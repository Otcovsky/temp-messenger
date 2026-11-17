/**
 * Ядро клиента: связывает криптографию, хранилище и транспорт.
 *
 * Все операции, меняющие состояние храповика (шифрование и расшифровка),
 * выполняются строго по очереди через serial(): иначе два параллельных
 * сообщения испортили бы сессию.
 */
import { type Bytes, b64d, b64e, randomId } from '../crypto/bytes'
import { decryptFile, encryptFile, newFileKey } from '../crypto/file'
import {
  type Identity,
  type InvitePayload,
  type PendingInvite,
  acceptInvite as acceptInviteCrypto,
  completeInvite,
  decodeInvite,
  createInvite as createInviteCrypto,
  encodeInvite,
  safetyNumber,
} from '../crypto/handshake'
import { type KeyPair, generateDH, generateSigning } from '../crypto/primitives'
import { type RatchetState, ratchetDecrypt, ratchetEncrypt } from '../crypto/ratchet'
import {
  type CallContent,
  type Content,
  type GroupIntroContent,
  type GroupLeaveContent,
  type GroupMemberInfo,
  type GroupStateContent,
  decodeContent,
  decodePayload,
  encodeContent,
  encodePayload,
} from '../protocol/envelope'
import {
  type CallInfo,
  type Contact,
  type Conversation,
  type DB,
  type FileInfo,
  type GroupInfo,
  type Message,
  type MessageStatus,
  type Profile,
  allMailboxes,
  getAuthKey,
  getIdentity,
  getProfile,
  listConversations,
  listMessages,
  mailboxRegistrations,
  dequeueUnregister,
  openStore,
  pendingUnregisters,
  queueUnregister,
  saveAccount,
  transact,
  type WriteTx,
  wipeStore,
  writeAll,
} from '../storage/db'
import { BlobError, blobDone, getBlob, putBlob } from '../transport/blobs'
import { type ConnStatus, type InviteState, type ServerFrame, Transport, defaultServerUrl } from '../transport/ws'

const INVITE_TTL_MS = 30 * 24 * 3600 * 1000
const MAX_TEXT = 10_000
const MAILBOX_RE = /^[A-Za-z0-9_-]{22}$/
/** Самый большой файл, который можно отправить */
export const MAX_FILE = 25 * 1024 * 1024
const BLOB_ID_RE = MAILBOX_RE
const FILE_KEY_RE = /^[A-Za-z0-9_-]{43}$/
/** id из 16 случайных байт в base64url (randomId) */
const ID_RE = /^[A-Za-z0-9_-]{22}$/
/** Ключ личности: 32 байта в base64url */
const IK_RE = /^[A-Za-z0-9_-]{43}$/
/** Самая большая группа: каждое сообщение шифруется отдельно для каждого участника */
export const MAX_GROUP = 50
const NAME_MAX = 64
/** Через сколько повторить передачу файла после сбоя связи, если соединение с сервером живо */
const TRANSFER_RETRY_MS = 20_000
const PROBE_TIMEOUT_MS = 10_000
const REGISTER_TIMEOUT_MS = 8_000
/** Сколько id уже обработанных входящих помнить, чтобы не разбирать повторную доставку */
const HANDLED_MAX = 2_000
const NO_CONNECTION = 'Нет связи с сервером. Попробуйте ещё раз, когда связь появится.'
/** Типы содержимого, о которых получателю стоит показать уведомление */
const NOTIFY_TYPES = new Set(['hello', 'text', 'file'])
/** Сколько секунд живёт сигнал звонка: дольше вызов всё равно не длится */
export const CALL_SIGNAL_TTL_SEC = 60
const ICE_TIMEOUT_MS = 4_000
const NO_ANSWER = 'Сервер не ответил. Проверьте связь и попробуйте ещё раз.'

/** Понятный текст для отказа сервера (кадр error) на register или probe. */
function serverRefusal(code: string): string {
  switch (code) {
    case 'too_many_mailboxes':
      return 'Слишком много открытых приглашений и чатов. Отзовите ненужные приглашения и попробуйте снова.'
    case 'rate_limited':
      return 'Слишком много запросов к серверу. Подождите немного и попробуйте снова.'
    case 'forbidden':
      return 'Сервер не принял ящик для приглашения. Попробуйте создать ссылку ещё раз.'
    default:
      return `Сервер отклонил запрос (${code}). Попробуйте ещё раз.`
  }
}

const STATUS_RANK: Record<MessageStatus, number> = {
  failed: -1, pending: 0, sent: 1, delivered: 2, read: 3, received: 0,
}

/** Статус только растёт (sent → delivered → read); failed — особый случай: только из pending. */
function statusAdvances(from: MessageStatus, to: MessageStatus): boolean {
  return to === 'failed' ? from === 'pending' : STATUS_RANK[to] > STATUS_RANK[from]
}

/** Транзакция, в которой входящее сообщение записывается вместе с новым состоянием храповика. */
type ReceiveTx = WriteTx<('sessions' | 'contacts' | 'conversations' | 'messages')[]>

export class Messenger {
  private identity: Identity | null = null
  private auth: KeyPair | null = null
  profile: Profile | null = null
  status: ConnStatus = 'offline'
  private transport: Transport | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private inFlight = new Set<string>()
  private listeners = new Set<() => void>()
  private activeConv: string | null = null
  /** Ждут ответа probe / registered по ящику */
  private probes = new Waiters<InviteState>()
  private registers = new Waiters<void>()
  private iceWaiters = new Waiters<RTCIceServer[]>()
  /** Проверка базы при запуске: onReady ждёт её, чтобы не регистрировать ящики удаляемых контактов */
  private repaired: Promise<void> = Promise.resolve()
  /**
   * Id входящих, уже взятых в работу. Сервер может прислать сообщение повторно (например,
   * после перерегистрации ящика, пока ack ещё не дошёл), а повторная расшифровка уже
   * использованным ключом храповика заканчивается ошибкой.
   */
  private handled = new Set<string>()
  /** Id сообщений, чей файл сейчас загружается или скачивается */
  private transfers = new Set<string>()
  /** Слушатель сигналов звонка (calls.ts): вызывается после записи состояния храповика */
  onCall: ((contact: Contact, c: CallContent) => void) | null = null
  /** Слушатель пуш-уведомлений (push.ts): подключение к серверу и ответ сервера на подписку */
  onPush:
    | ((
        e:
          | { t: 'ready' }
          | { t: 'result'; ok: true }
          | { t: 'result'; ok: false; code: string }
          | { t: 'test'; status: number }
          | { t: 'incoming' },
      ) => void)
    | null = null
  private lastNoteTs = 0
  /**
   * Id конвертов, которые сервер только что принял. Между его ответом и удалением записи из
   * очереди проходит мгновение — без этой пометки параллельная отправка послала бы конверт ещё раз.
   */
  private accepted = new Set<string>()
  /** Растёт при каждом изменении — UI по нему перечитывает данные */
  version = 0

  private constructor(private db: DB) {}

  static async open(): Promise<Messenger> {
    const m = new Messenger(await openStore())
    m.identity = (await getIdentity(m.db)) ?? null
    m.auth = (await getAuthKey(m.db)) ?? null
    m.profile = (await getProfile(m.db)) ?? null
    return m
  }

  get hasAccount(): boolean {
    return !!(this.identity && this.auth && this.profile)
  }

  // --- подписка UI ---------------------------------------------------------

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit() {
    this.version++
    for (const fn of this.listeners) fn()
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn)
    this.chain = p.catch(() => {})
    return p
  }

  // --- аккаунт -------------------------------------------------------------

  async createAccount(name: string): Promise<void> {
    const identity: Identity = { dh: await generateDH(), sig: await generateSigning() }
    const auth = await generateSigning()
    const profile: Profile = { name: name.trim().slice(0, 64), createdAt: Date.now() }
    await saveAccount(this.db, identity, auth, profile)
    Object.assign(this, { identity, auth, profile })
    // Просим браузер не вытеснять данные при нехватке места
    navigator.storage?.persist?.().catch(() => {})
    this.emit()
  }

  start(url = defaultServerUrl()): void {
    if (!this.auth || this.transport) return
    this.repaired = this.repair().catch((e) => console.warn('Не удалось проверить базу', e))
    this.transport = new Transport(url, this.auth, {
      onReady: () => void this.onReady().catch((e) => console.warn('Не удалось восстановить ящики', e)),
      onFrame: (f) => this.onFrame(f),
      onStatus: (s) => {
        this.status = s
        if (s !== 'online') {
          this.inFlight.clear()
          // Ответа по разорванному соединению уже не будет — не держим человека до таймаута
          this.probes.rejectAll(new Error(NO_CONNECTION))
          this.registers.rejectAll(new Error(NO_CONNECTION))
          this.iceWaiters.rejectAll(new Error(NO_CONNECTION))
        }
        this.emit()
      },
    })
    this.transport.start()
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.activeConv) void this.markRead(this.activeConv)
    })
    void this.dropExpiredInvites().catch((e) => console.warn('Не удалось убрать старые приглашения', e))
  }

  /**
   * Контакт без беседы — след прежней ошибки, когда запись прерывалась на середине.
   * Если сессия цела, восстанавливаем беседу, иначе убираем контакт: писать ему всё равно нечем.
   */
  private async repair() {
    let changed = false
    for (const c of await this.db.getAll('contacts')) {
      if (c.groupOnly || (await this.db.get('conversations', c.id))) continue
      if (await this.db.get('sessions', c.id)) {
        await this.db.put('conversations', newConversation(c))
      } else {
        await this.db.delete('contacts', c.id)
        await this.closeMailbox(c.myMailbox)
      }
      changed = true
    }
    if (changed) this.emit()
  }

  /**
   * Закрыть свой ящик на сервере. Ящик запоминается в базе, пока сервер не ответит
   * unregistered: без связи (или если кадр потеряется) закроем при следующем подключении.
   */
  private async closeMailbox(mailbox: string) {
    await queueUnregister(this.db, mailbox)
    this.transport?.send({ t: 'unregister', mailbox })
  }

  /** Ключ VAPID сервера; null — сервер пуши не шлёт или связи ещё не было */
  get pushKey(): string | null {
    return this.transport?.pushKey ?? null
  }

  /** Сообщить серверу адрес пуш-подписки этого браузера; null — отписаться. */
  setPushEndpoint(sub: { endpoint: string; p256dh?: string; auth?: string } | null): boolean {
    return this.transport?.send(sub ? { t: 'push-sub', ...sub } : { t: 'push-unsub' }) ?? false
  }

  /** Попросить сервер прислать пробный пуш на этот браузер; ответ придёт в onPush как test. */
  testPush(kind?: 'call'): boolean {
    return this.transport?.send({ t: 'push-test', ...(kind ? { kind } : {}) }) ?? false
  }

  /** Удалить всё: сообщить собеседникам, закрыть ящики на сервере, стереть базу. */
  async wipeAll(): Promise<void> {
    try {
      this.setPushEndpoint(null)
      for (const g of await this.db.getAll('conversations')) {
        if (g.group && !g.group.left) await this.announceLeave(g).catch(() => {})
      }
      const contacts = await this.db.getAll('contacts')
      await Promise.all(contacts.map((c) => this.sendGoodbye(c).catch(() => {})))
      await this.flushOutbox()
      await new Promise((r) => setTimeout(r, 1500))
      const mailboxes = [...(await allMailboxes(this.db)), ...(await pendingUnregisters(this.db))]
      for (const mb of mailboxes) this.transport?.send({ t: 'unregister', mailbox: mb })
      await new Promise((r) => setTimeout(r, 300))
    } finally {
      this.transport?.stop()
      await wipeStore(this.db)
    }
  }

  // --- сеть ----------------------------------------------------------------

  private async onReady() {
    await this.repaired
    for (const r of await mailboxRegistrations(this.db)) this.transport?.send({ t: 'register', ...r })
    for (const mailbox of await pendingUnregisters(this.db)) this.transport?.send({ t: 'unregister', mailbox })
    await this.flushOutbox()
    // Знакомство с участниками групп могло оборваться (не было связи) — пробуем довести
    for (const g of await this.db.getAll('conversations')) {
      if (g.group && !g.group.left) void this.linkGroup(g.id).catch(() => {})
    }
    this.onPush?.({ t: 'ready' })
    void this.resumeTransfers().catch((e) => console.warn('Не удалось возобновить передачу файлов', e))
  }

  private onFrame(f: ServerFrame) {
    switch (f.t) {
      case 'msg':
        if (this.handled.has(f.id)) {
          this.transport?.send({ t: 'ack', mailbox: f.mailbox, ids: [f.id] })
          break
        }
        this.handled.add(f.id)
        if (this.handled.size > HANDLED_MAX) this.handled.delete(this.handled.values().next().value!)
        void this.serial(() => this.receive(f.mailbox, f.payload)).then(
          () => this.transport?.send({ t: 'ack', mailbox: f.mailbox, ids: [f.id] }),
          (e) => {
            // receive() бросает только при сбое базы (негодные сообщения он отбрасывает сам).
            // Не подтверждаем: сообщение останется на сервере и придёт снова при следующем
            // подключении. В базу при этом ничего не попало, так что оно расшифруется.
            console.warn('Не удалось сохранить сообщение, сервер пришлёт его ещё раз', e)
            this.handled.delete(f.id)
          },
        )
        break
      case 'sent':
        void this.onSent(f.id, f.failed)
        break
      case 'registered':
        this.registers.resolve(f.mailbox, undefined)
        break
      case 'unregistered':
        void dequeueUnregister(this.db, f.mailbox).catch((e) => console.warn('Не удалось обновить базу', e))
        break
      case 'probe':
        this.probes.resolve(f.mailbox, f.state)
        break
      case 'ice':
        this.iceWaiters.resolve('ice', Array.isArray(f.servers) ? f.servers : [])
        break
      case 'push-sub':
        this.onPush?.({ t: 'result', ok: true })
        break
      case 'push-test':
        this.onPush?.({ t: 'test', status: f.status })
        break
      case 'error':
        console.warn('Ошибка сервера:', f.code, f.ref ?? '')
        if (['bad_endpoint', 'bad_keys', 'push_disabled', 'no_subscription'].includes(f.code))
          this.onPush?.({ t: 'result', ok: false, code: f.code })
        if (!f.ref) break
        if (this.inFlight.delete(f.ref)) setTimeout(() => void this.flushOutbox(), 3000)
        this.registers.reject(f.ref, new Error(serverRefusal(f.code)))
        this.probes.reject(f.ref, new Error(serverRefusal(f.code)))
        break
    }
  }

  private async flushOutbox() {
    if (!this.transport?.isReady) return
    const items = await this.db.getAllFromIndex('outbox', 'byCreated')
    for (const it of items) {
      if (this.inFlight.has(it.id) || this.accepted.has(it.id)) continue
      if (it.ttl && Date.now() > it.createdAt + it.ttl * 1000) {
        await this.db.delete('outbox', it.id) // сигнал звонка устарел, пока не было связи
        continue
      }
      const frame = {
        t: 'send', id: it.id, to: it.to, payload: it.payload,
        ...(it.notify ? { notify: it.notify } : {}),
        ...(it.ttl ? { ttl: it.ttl } : {}),
      }
      if (!this.transport.send(frame)) break
      this.inFlight.add(it.id)
    }
  }

  private async onSent(id: string, failed: { to: string; reason: string }[]) {
    this.accepted.add(id)
    if (this.accepted.size > HANDLED_MAX) this.accepted.delete(this.accepted.values().next().value!)
    this.inFlight.delete(id)
    const item = await this.db.get('outbox', id)
    if (!item) return
    await this.db.delete('outbox', id)
    const lost = new Set(failed.filter((f) => f.reason === 'no_mailbox').map((f) => f.to))
    if (lost.size) {
      for (const c of await this.db.getAll('contacts')) {
        if (c.theirMailbox && !c.gone && lost.has(c.theirMailbox)) {
          await this.db.put('contacts', { ...c, gone: true, goneBy: 'no_mailbox' })
        }
      }
    }
    if (item.msgId) {
      const { msgId } = item
      // У группового сообщения копия на каждого участника: «отправлено» — когда ушли все.
      // Отказ по одной копии (участник пропал) сообщение неотправленным не делает.
      const more = item.group && (await this.db.getAll('outbox')).some((o) => o.msgId === msgId)
      if (!more) await this.updateStatus(msgId, failed.length && !item.group ? 'failed' : 'sent')
    }
    this.emit()
  }

  // --- приглашения -----------------------------------------------------------

  inviteLink(inv: PendingInvite): string {
    return `${location.origin}${location.pathname}#i=${encodeInvite(inv.payload)}`
  }

  /**
   * Создать приглашение. Ссылку отдаём, только когда сервер подтвердил ящик: иначе
   * собеседник, открыв её, услышит от сервера «такого приглашения нет».
   */
  async createInvite(): Promise<PendingInvite> {
    if (!(await this.waitOnline(PROBE_TIMEOUT_MS))) throw new Error(NO_CONNECTION)
    const inv = await createInviteCrypto(this.identity!, this.profile!.name)
    await this.db.put('invites', inv)
    try {
      await this.registers.wait(inv.mailbox, REGISTER_TIMEOUT_MS, () => this.noAnswer(), () =>
        this.send({ t: 'register', mailbox: inv.mailbox, invite: true }),
      )
    } catch (e) {
      await this.db.delete('invites', inv.mailbox)
      // Регистрация могла дойти до сервера, а потерялся только ответ — закрываем ящик там
      await this.closeMailbox(inv.mailbox).catch(() => {})
      throw e
    }
    this.emit()
    return inv
  }

  private send(frame: object): boolean {
    return !!this.transport?.send(frame)
  }

  /** Сервер молчит: проверить, живо ли соединение, и вернуть ошибку для человека. */
  private noAnswer(): Error {
    this.transport?.checkAlive()
    return new Error(NO_ANSWER)
  }

  /** Приглашения-ссылки, которые ещё никто не принял (без служебных «знакомств» по группе). */
  async listInvites(): Promise<PendingInvite[]> {
    return (await this.db.getAll('invites')).filter((i) => !i.group)
  }

  async cancelInvite(mailbox: string): Promise<void> {
    await this.db.delete('invites', mailbox)
    await this.closeMailbox(mailbox)
    this.emit()
  }

  private async dropExpiredInvites() {
    for (const inv of await this.db.getAll('invites')) {
      if (Date.now() - inv.createdAt > INVITE_TTL_MS) await this.cancelInvite(inv.mailbox)
    }
  }

  /** Дождаться соединения с сервером (не дольше ms). */
  private waitOnline(ms: number): Promise<boolean> {
    if (this.transport?.isReady) return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer)
        unsub()
        resolve(ok)
      }
      const timer = setTimeout(() => done(false), ms)
      const unsub = this.subscribe(() => this.transport?.isReady && done(true))
    })
  }

  /** Спросить сервер, ждёт ли ещё ящик-приглашение ответа. */
  private async probeInvite(mailbox: string): Promise<InviteState> {
    const deadline = Date.now() + PROBE_TIMEOUT_MS
    if (!(await this.waitOnline(PROBE_TIMEOUT_MS))) throw new Error(NO_CONNECTION)
    return this.probes.wait(mailbox, Math.max(1000, deadline - Date.now()), () => this.noAnswer(), () =>
      this.send({ t: 'probe', mailbox }),
    )
  }

  /** Живая беседа, уже созданная по этому приглашению (если ссылку открыли повторно). */
  async existingChatForInvite(invite: InvitePayload): Promise<string | null> {
    const c = (await this.db.getAll('contacts')).find((c) => c.theirMailbox === invite.m && !c.gone)
    return c && (await this.db.get('conversations', c.id)) ? c.id : null
  }

  /**
   * Проверить приглашение до создания чата. Возвращает текст причины, если принять его нельзя,
   * иначе null. Чат создаём, только если пригласивший ещё ждёт ответа: иначе сообщения ушли бы в никуда.
   */
  async checkInvite(invite: InvitePayload): Promise<string | null> {
    if (invite.ik === b64e(this.identity!.dh.pub)) return 'Это ваше собственное приглашение.'
    const state = await this.probeInvite(invite.m)
    if (state === 'used') return 'По этой ссылке уже подключились. Попросите собеседника создать новую.'
    if (state === 'none') return 'Приглашение больше не действует: его отозвали, или собеседник удалил чат. Попросите новую ссылку.'
    return null
  }

  /** Принять чужое приглашение. Возвращает id новой беседы (или уже существующей). */
  async acceptInvite(invite: InvitePayload): Promise<string> {
    const me = this.identity!
    const existing = await this.existingChatForInvite(invite)
    if (existing) return existing
    const problem = await this.checkInvite(invite)
    if (problem) throw new Error(problem)
    const { session, preKey } = await acceptInviteCrypto(me, invite)
    const contact: Contact = {
      id: randomId(),
      name: invite.n?.trim() || 'Без имени',
      ...(invite.n?.trim() ? { selfName: invite.n.trim() } : {}),
      myMailbox: randomId(),
      theirMailbox: invite.m,
      ik: invite.ik,
      sigPub: invite.sk,
      createdAt: Date.now(),
    }
    await writeAll(this.db, ['contacts', 'sessions', 'conversations'], (tx) => [
      tx.objectStore('contacts').put(contact),
      tx.objectStore('sessions').put({ contactId: contact.id, state: session, preKey }),
      tx.objectStore('conversations').put(newConversation(contact)),
    ])
    this.transport?.send({ t: 'register', mailbox: contact.myMailbox, invite: false })
    await this.sendContent(contact, {
      id: randomId(),
      ts: Date.now(),
      type: 'hello',
      body: { name: this.profile!.name, mailbox: contact.myMailbox, sigPub: b64e(me.sig.pub) },
    })
    this.emit()
    return contact.id
  }

  // --- отправка ------------------------------------------------------------

  /** Беседа и те, кому в неё писать: собеседник или участники группы, с которыми есть канал. */
  private async chat(convId: string): Promise<{ conv: Conversation; targets: Contact[] }> {
    const conv = await this.db.get('conversations', convId)
    if (!conv) throw new Error('Беседа не найдена')
    if (conv.group) {
      if (conv.group.left) throw new Error('Вы больше не участник этой группы')
      const targets = await this.groupTargets(conv.group)
      if (!targets.length) throw new Error('В группе пока некому писать: участники ещё подключаются')
      return { conv, targets }
    }
    const contact = await this.db.get('contacts', conv.members[0])
    if (!contact) throw new Error('Беседа не найдена')
    return { conv, targets: [contact] }
  }

  /**
   * Отправить содержимое в беседу. В группе каждый участник получает свою копию, зашифрованную
   * его парным каналом; id сообщения у копий общий, id конверта у каждой свой.
   */
  private async sendToChat(conv: Conversation, targets: Contact[], content: Content, msgId?: string): Promise<void> {
    if (!conv.group) return this.sendContent(targets[0], content, msgId)
    const results = await Promise.allSettled(
      targets.map((c) => this.sendContent(c, { ...content, conv: conv.id }, msgId, undefined, randomId())),
    )
    const failed = results.filter((r) => r.status === 'rejected')
    if (failed.length === results.length) throw (failed[0] as PromiseRejectedResult).reason
  }

  /** Обновить строку беседы в списке чатов, не затирая то, что в ней успело измениться. */
  private async touchConversation(convId: string, patch: Partial<Conversation>): Promise<void> {
    await transact(this.db, ['conversations'], async (tx) => {
      const cur = await tx.objectStore('conversations').get(convId)
      if (cur) await tx.objectStore('conversations').put({ ...cur, ...patch })
    })
  }

  async sendText(convId: string, text: string): Promise<void> {
    text = text.trim().slice(0, MAX_TEXT)
    if (!text) return
    const { conv, targets } = await this.chat(convId)
    const msg: Message = { id: randomId(), conv: convId, from: 'me', ts: Date.now(), type: 'text', text, status: 'pending' }
    await this.db.put('messages', msg)
    await this.touchConversation(convId, { lastTs: msg.ts, lastText: text })
    this.emit()
    try {
      await this.sendToChat(conv, targets, { id: msg.id, ts: msg.ts, type: 'text', body: { text } }, msg.id)
    } catch (e) {
      await this.updateStatus(msg.id, 'failed')
      this.emit()
      throw e
    }
  }

  /** Отправить один файл, при желании с подписью. См. sendFiles. */
  sendFile(convId: string, file: File, caption = ''): Promise<void> {
    return this.sendFiles(convId, [file], caption)
  }

  /**
   * Отправить файлы одной пачкой. Каждый шифруется своим ключом и загружается на сервер,
   * собеседнику уходит по сообщению на файл с id, ключом и общей меткой альбома (если файлов
   * больше одного). Подпись — у последнего файла: клиент, не знающий альбомов, покажет её под пачкой.
   * Бросает, если какой-то файл не подходит (тогда не отправляется ничего) или сервер не принял
   * файл; без связи сообщения ждут отправки, как обычные.
   */
  async sendFiles(convId: string, files: File[], caption = ''): Promise<void> {
    if (!files.length) return
    for (const file of files) {
      const name = cleanFileName(file.name)
      if (file.size > MAX_FILE) throw new Error(`«${name}» больше ${MAX_FILE / 1024 / 1024} МБ, такие файлы отправить нельзя.`)
      if (!file.size) throw new Error(`«${name}» — пустой файл.`)
    }
    const { conv, targets } = await this.chat(convId)
    if (!conv.group && (!targets[0].theirMailbox || targets[0].gone)) throw new Error('Собеседнику больше нельзя писать')
    const text = caption.trim().slice(0, MAX_TEXT)
    const album = files.length > 1 ? randomId() : undefined
    const now = Date.now()
    const batch: { msg: Message; data: ArrayBuffer }[] = []
    for (const [i, file] of files.entries()) {
      const data = await file.arrayBuffer()
      const last = i === files.length - 1
      const msg: Message = {
        // Время с шагом в 1 мс: порядок файлов в пачке сохраняется и у получателя
        id: randomId(), conv: convId, from: 'me', ts: now + i, type: 'file', text: last ? text : '',
        status: 'pending', transfer: 'up', ...(album ? { album } : {}),
        file: {
          name: cleanFileName(file.name), mime: cleanMime(file.type), size: data.byteLength,
          blob: randomId(), key: b64e(newFileKey()), state: 'ready',
        },
      }
      batch.push({ msg, data })
    }
    const lastMsg = batch[batch.length - 1].msg
    // Вся пачка появляется в чате сразу, загрузка идёт следом
    await writeAll(this.db, ['messages', 'files'], (tx) => [
      ...batch.map(({ msg }) => tx.objectStore('messages').put(msg)),
      ...batch.map(({ msg, data }) => tx.objectStore('files').put({ id: msg.id, data })),
    ])
    await this.touchConversation(convId, { lastTs: lastMsg.ts, lastText: fileLabel(lastMsg.file!.name, text) })
    this.emit()
    let failure: unknown
    for (const { msg } of batch) {
      try {
        await this.upload(msg.id)
      } catch (e) {
        failure ??= e // остальные файлы пачки всё равно пробуем отправить
      }
    }
    if (failure) throw failure
  }

  /** Повторить отправку сообщения, которое не дошло до сервера. */
  async retry(msgId: string): Promise<void> {
    const msg = await this.db.get('messages', msgId)
    if (!msg || msg.from !== 'me' || msg.status !== 'failed') return
    if (msg.type === 'file') {
      // Ключ и id файла прежние: шифротекст тот же, и если файл уже на сервере, он примет повтор
      await this.db.put('messages', { ...msg, status: 'pending', transfer: 'up' })
      this.emit()
      await this.upload(msgId)
      return
    }
    await this.db.delete('messages', msgId)
    await this.sendText(msg.conv, msg.text)
  }

  /** Скачать снова файл, который не удалось скачать или расшифровать. */
  async retryDownload(msgId: string): Promise<void> {
    const msg = await this.db.get('messages', msgId)
    if (!msg?.file || msg.from === 'me' || msg.file.state !== 'error') return
    await this.db.put('messages', { ...msg, transfer: 'down', file: { ...msg.file, state: 'loading' } })
    this.emit()
    await this.download(msgId)
  }

  /**
   * Запомнить размер картинки, чтобы при следующем открытии чата сразу занять под неё место.
   * Без emit: показанный пузырь размер уже знает, а перечитывать ради этого весь чат незачем.
   */
  async rememberImageSize(msgId: string, w: number, h: number): Promise<void> {
    const tx = this.db.transaction('messages', 'readwrite')
    const msg = await tx.store.get(msgId)
    if (msg?.file && !(msg.file.w && msg.file.h)) await tx.store.put({ ...msg, file: { ...msg.file, w, h } })
    await tx.done
  }

  /** Содержимое файла из сообщения, если оно уже есть в базе. */
  async fileData(msgId: string): Promise<ArrayBuffer | undefined> {
    return (await this.db.get('files', msgId))?.data
  }

  // --- передача файлов -------------------------------------------------------

  /** Возобновить передачи, прерванные перезапуском или потерей связи. По одной, чтобы не забить канал. */
  private async resumeTransfers() {
    for (const m of await this.db.getAllFromIndex('messages', 'byTransfer', 'up')) {
      await this.upload(m.id).catch((e) => console.warn('Файл не отправлен', e))
    }
    for (const m of await this.db.getAllFromIndex('messages', 'byTransfer', 'down')) await this.download(m.id)
  }

  /** Сбой связи при живом соединении (например, сервер перезапускался): попробовать ещё раз позже. */
  private retryLater(fn: () => Promise<void>) {
    setTimeout(() => {
      if (this.transport?.isReady) void fn().catch(() => {})
    }, TRANSFER_RETRY_MS)
  }

  /**
   * Загрузить файл своего сообщения на сервер и отправить собеседнику сообщение о нём.
   * Бросает, если сервер отказал (сообщение помечается неотправленным). При сбое связи
   * сообщение остаётся в ожидании, и загрузка повторится.
   */
  private async upload(msgId: string): Promise<void> {
    if (this.transfers.has(msgId)) return
    this.transfers.add(msgId)
    try {
      const msg = await this.db.get('messages', msgId)
      if (!msg?.file || msg.transfer !== 'up') return
      const chat = await this.chat(msg.conv).catch(() => null)
      const stored = await this.db.get('files', msgId)
      if (!chat || !stored) return await this.finishUpload(msgId, true)
      const { blob, key, size, name, mime } = msg.file
      try {
        const ct = await encryptFile(b64d(key), new Uint8Array(stored.data))
        // В группе файл загружается один раз, а скачать его должен каждый участник
        await putBlob(blob, ct, chat.targets.length, this.auth!)
        const body = {
          blob, key, size, name, mime,
          ...(msg.text ? { caption: msg.text } : {}),
          ...(msg.album ? { album: msg.album } : {}),
        }
        await this.sendToChat(chat.conv, chat.targets, { id: msg.id, ts: msg.ts, type: 'file', body }, msg.id)
      } catch (e) {
        if (e instanceof BlobError && !e.permanent) {
          this.retryLater(() => this.upload(msgId))
          return
        }
        await this.finishUpload(msgId, true)
        throw e
      }
      await this.finishUpload(msgId, false)
    } finally {
      this.transfers.delete(msgId)
    }
  }

  private async finishUpload(msgId: string, failed: boolean) {
    await transact(this.db, ['messages'], async (tx) => {
      const m = await tx.objectStore('messages').get(msgId)
      if (!m) return
      const { transfer: _transfer, ...rest } = m
      await tx.objectStore('messages').put(failed && m.status === 'pending' ? { ...rest, status: 'failed' } : rest)
    })
    this.emit()
  }

  /** Скачать и расшифровать файл входящего сообщения. */
  private async download(msgId: string): Promise<void> {
    if (this.transfers.has(msgId)) return
    this.transfers.add(msgId)
    try {
      const msg = await this.db.get('messages', msgId)
      if (!msg?.file || msg.transfer !== 'down') return
      const { blob, key, size } = msg.file
      let ct: Bytes | null
      try {
        ct = await getBlob(blob)
      } catch (e) {
        if (e instanceof BlobError && !e.permanent) return this.retryLater(() => this.download(msgId))
        console.warn('Файл не скачан', e)
        return await this.finishDownload(msgId, 'error')
      }
      if (!ct) return await this.finishDownload(msgId, 'gone')
      let data: Bytes
      try {
        data = await decryptFile(b64d(key), ct)
        if (data.length !== size) throw new Error('размер не совпадает')
      } catch (e) {
        console.warn('Файл не расшифрован', e)
        return await this.finishDownload(msgId, 'error')
      }
      await this.finishDownload(msgId, 'ready', data)
      void blobDone(blob)
    } finally {
      this.transfers.delete(msgId)
    }
  }

  private async finishDownload(msgId: string, state: FileInfo['state'], data?: Bytes) {
    await transact(this.db, ['messages', 'files'], async (tx) => {
      const m = await tx.objectStore('messages').get(msgId)
      if (!m?.file) return // чат удалили, пока файл скачивался
      const { transfer: _transfer, ...rest } = m
      if (data) await tx.objectStore('files').put({ id: msgId, data: data.buffer })
      await tx.objectStore('messages').put({ ...rest, file: { ...m.file, state } })
    })
    this.emit()
  }

  /** envId — id конверта, если он должен отличаться от id содержимого (копии группового сообщения). */
  private sendContent(contact: Contact, content: Content, msgId?: string, ttl?: number, envId?: string): Promise<void> {
    return this.serial(async () => {
      if (!contact.theirMailbox || contact.gone) throw new Error('Собеседнику больше нельзя писать')
      const sess = await this.db.get('sessions', contact.id)
      if (!sess) throw new Error('Нет сессии шифрования')
      const r = await ratchetEncrypt(sess.state, encodeContent(content))
      const payload = encodePayload(r.header, r.ciphertext, sess.preKey)
      const to = contact.theirMailbox
      // О звонке получателю придёт отдельное, «звонящее» уведомление. Конец звонка без срока
      // хранения — это «вам звонили и не дождались»: его тоже стоит показать.
      const notify =
        content.type === 'call-offer'
          ? 'call'
          : content.type === 'call-end'
            ? !ttl && 'call-end'
            : NOTIFY_TYPES.has(content.type)
      await writeAll(this.db, ['sessions', 'outbox'], (tx) => [
        tx.objectStore('sessions').put({ ...sess, state: r.state }),
        tx.objectStore('outbox').put({
          id: envId ?? content.id, to: [to], payload, createdAt: Date.now(), msgId,
          ...(notify ? { notify } : {}),
          ...(ttl ? { ttl } : {}),
          ...(envId ? { group: true } : {}),
        }),
      ])
    }).then(() => this.flushOutbox())
  }

  private sendReceipt(contact: Contact, status: 'delivered' | 'read', ids: string[]) {
    if (!ids.length || contact.gone || !contact.theirMailbox) return Promise.resolve()
    return this.sendContent(contact, { id: randomId(), ts: Date.now(), type: 'receipt', body: { status, ids } })
  }

  private sendGoodbye(contact: Contact) {
    if (contact.gone || !contact.theirMailbox) return Promise.resolve()
    return this.sendContent(contact, { id: randomId(), ts: Date.now(), type: 'goodbye', body: {} })
  }

  // --- приём ---------------------------------------------------------------

  /**
   * Разобрать входящее сообщение. Негодное (не разбирается, не расшифровывается) молча
   * отбрасывается: повторная доставка его не исправит. Исключение отсюда означает сбой базы —
   * тогда сообщение не подтверждается серверу и придёт ещё раз.
   */
  private async receive(mailbox: string, raw: string): Promise<void> {
    let parsed: ReturnType<typeof decodePayload>
    try {
      parsed = decodePayload(raw)
    } catch (e) {
      console.warn('Сообщение не разобрано', e)
      return
    }
    const { header, ct, pk } = parsed
    const known = await this.db.getFromIndex('contacts', 'byMyMailbox', mailbox)

    if (!known) {
      // Первое сообщение по моему приглашению
      const invite = await this.db.get('invites', mailbox)
      if (!invite || !pk) return
      let opened: { state: RatchetState; theirIk: string; hello: Content | null }
      try {
        const { session, theirIk } = await completeInvite(this.identity!, invite, pk)
        const r = await ratchetDecrypt(session, header, ct)
        opened = { state: r.state, theirIk: b64e(theirIk), hello: decodeContent(r.plaintext) }
      } catch (e) {
        console.warn('Ответ на приглашение не расшифрован', e)
        return
      }
      const { hello } = opened
      if (hello?.type !== 'hello' || !MAILBOX_RE.test(hello.body?.mailbox)) return
      // «Знакомство» по группе: приглашение предназначалось одному участнику — другому не верим
      const intro = invite.group
      if (intro && opened.theirIk !== intro.ik) return
      const said = String(hello.body.name || '').trim().slice(0, NAME_MAX)
      const created: Contact = {
        id: randomId(),
        name: said || (intro ? 'Участник' : 'Без имени'),
        ...(said ? { selfName: said } : {}),
        ...(intro ? { groupOnly: true } : {}),
        myMailbox: mailbox,
        theirMailbox: hello.body.mailbox,
        ik: opened.theirIk,
        sigPub: typeof hello.body.sigPub === 'string' ? hello.body.sigPub : null,
        createdAt: Date.now(),
      }
      await writeAll(this.db, ['invites', 'contacts', 'sessions', 'conversations'], (tx) => [
        tx.objectStore('invites').delete(mailbox), // приглашение одноразовое
        tx.objectStore('contacts').put(created),
        tx.objectStore('sessions').put({ contactId: created.id, state: opened.state }),
        // Знакомому только по группе личный чат не заводим
        ...(intro ? [] : [tx.objectStore('conversations').put(newConversation(created))]),
      ])
      // Ящик теперь обычный: повторно открытая ссылка не создаст «мёртвый» чат
      this.transport?.send({ t: 'register', mailbox, invite: false })
      this.emit()
      return
    }

    const sess = await this.db.get('sessions', known.id)
    if (!sess) return
    let state: RatchetState
    let content: Content | null = null
    try {
      const r = await ratchetDecrypt(sess.state, header, ct)
      state = r.state
      try {
        content = decodeContent(r.plaintext)
      } catch (e) {
        // Расшифровано, но внутри мусор: ключ израсходован, состояние всё равно сохраняем
        console.warn('Содержимое сообщения не разобрано', e)
      }
    } catch (e) {
      console.warn('Сообщение не расшифровано', e)
      return
    }

    // Состояние храповика и само сообщение пишутся вместе. Иначе при сбое между двумя записями
    // ключ был бы уже израсходован, а сообщение не сохранено — и повторная доставка не помогла бы.
    const after = await transact(this.db, ['sessions', 'contacts', 'conversations', 'messages'], async (tx: ReceiveTx) => {
      // Собеседник ответил — prekey-заголовок больше не нужен
      await tx.objectStore('sessions').put({ contactId: known.id, state })
      let contact = known
      if (contact.gone && contact.goneBy !== 'goodbye' && content?.type !== 'goodbye') {
        // Сервер когда-то не нашёл его ящик (истёк, пока человек был не в сети), но он вернулся
        const { gone: _gone, goneBy: _goneBy, ...alive } = contact
        contact = alive
        await tx.objectStore('contacts').put(contact)
      }
      return content ? this.applyContent(tx, contact, content) : undefined
    })
    after?.()
    this.emit()
  }

  /**
   * Записать содержимое входящего сообщения в транзакцию приёма. Возвращает действие,
   * которое надо выполнить после её фиксации (отправить квитанцию).
   */
  private async applyContent(tx: ReceiveTx, contact: Contact, c: Content): Promise<(() => void) | undefined> {
    switch (c.type) {
      case 'text':
        return this.storeIncoming(tx, contact, c, { type: 'text', text: String(c.body?.text ?? '').slice(0, MAX_TEXT) })
      case 'file': {
        const file = parseFile(c.body)
        if (!file) return
        // Подпись к файлу хранится в text, как у обычного сообщения
        const caption = typeof c.body.caption === 'string' ? c.body.caption.trim().slice(0, MAX_TEXT) : ''
        const album = typeof c.body.album === 'string' && ID_RE.test(c.body.album) ? c.body.album : undefined
        return this.storeIncoming(
          tx, contact, c,
          { type: 'file', text: caption, file, transfer: 'down', ...(album ? { album } : {}) },
          fileLabel(file.name, caption),
        )
      }
      case 'receipt': {
        const status = c.body?.status
        if (status !== 'delivered' && status !== 'read') return
        const messages = tx.objectStore('messages')
        const ids = Array.isArray(c.body.ids) ? c.body.ids.slice(0, 500) : []
        for (const id of ids) {
          const m = await messages.get(String(id))
          if (m && m.from === 'me' && m.conv === contact.id && statusAdvances(m.status, status)) {
            await messages.put({ ...m, status })
          }
        }
        return
      }
      case 'goodbye':
        await tx.objectStore('contacts').put({ ...contact, gone: true, goneBy: 'goodbye' })
        return
      case 'hello':
        return // повторный hello по уже установленной сессии — игнорируем
      case 'group-state':
        return this.applyGroupState(tx, contact, c)
      case 'group-leave':
        return this.applyGroupLeave(tx, contact, c)
      case 'group-intro':
        return () => void this.onGroupIntro(contact, c).catch((e) => console.warn('Знакомство по группе не удалось', e))
      case 'call-offer':
      case 'call-answer':
      case 'call-ice':
      case 'call-media':
      case 'call-end':
        // Сигнал с conv — групповой звонок: формат зарезервирован, но этот клиент их не умеет
        if (c.conv) return
        if (!c.body || typeof c.body.call !== 'string' || !ID_RE.test(c.body.call)) return
        return () => this.onCall?.(contact, c)
    }
  }

  /** Записать входящее сообщение и обновить беседу. */
  private async storeIncoming(
    tx: ReceiveTx,
    contact: Contact,
    c: Content,
    fields: Pick<Message, 'type' | 'text' | 'file' | 'transfer' | 'album'>,
    preview = fields.text,
  ): Promise<(() => void) | undefined> {
    const messages = tx.objectStore('messages')
    const conversations = tx.objectStore('conversations')
    if (await messages.get(c.id)) return
    let conv: Conversation | undefined
    if (c.conv) {
      // Групповое: принимаем только от участника группы, в которой состоим сами
      conv = await conversations.get(c.conv)
      if (!conv?.group || conv.group.left || !inGroup(conv.group, contact.ik)) return
    } else {
      conv = await conversations.get(contact.id)
      if (!conv && contact.groupOnly) {
        // Знакомый по группе написал лично — с этого момента у нас есть и личный чат
        const { groupOnly: _groupOnly, ...direct } = contact
        contact = direct
        await tx.objectStore('contacts').put(contact)
        conv = newConversation(contact)
      }
      if (!conv) return
    }
    const group = !!conv.group
    const isOpen = this.activeConv === conv.id && document.visibilityState === 'visible'
    await messages.put({
      // В группе квитанции не шлём (их пришлось бы рассылать каждому), так что и ждать их отправки незачем
      id: c.id, conv: conv.id, from: contact.id, ts: c.ts, status: 'received', readSent: isOpen || group,
      ...(group ? { fromName: contact.name } : {}),
      ...fields,
    })
    await conversations.put({
      ...conv, lastTs: Math.max(conv.lastTs, c.ts), lastText: group ? `${contact.name}: ${preview}` : preview,
      unread: isOpen ? 0 : conv.unread + 1,
    })
    return () => {
      // Без await: мы внутри serial(), а отправка сама встаёт в ту же очередь
      if (!group) void this.sendReceipt(contact, isOpen ? 'read' : 'delivered', [c.id])
      this.onPush?.({ t: 'incoming' })
      if (fields.transfer === 'down') void this.download(c.id)
    }
  }

  /** Чтение и запись одной транзакцией: параллельная запись того же сообщения (файл скачался) не затрётся. */
  private async updateStatus(id: string, status: MessageStatus) {
    await transact(this.db, ['messages'], async (tx) => {
      const m = await tx.objectStore('messages').get(id)
      if (m && statusAdvances(m.status, status)) await tx.objectStore('messages').put({ ...m, status })
    })
  }

  // --- для UI --------------------------------------------------------------

  // --- звонки ----------------------------------------------------------------

  /**
   * Отправить сигнал звонка собеседнику. keep — хранить на сервере как обычное сообщение
   * (для «звонок закончился, а вы не ответили»: по нему собеседник узнает о пропущенном).
   */
  sendCall(contactId: string, signal: Pick<CallContent, 'type' | 'body'>, keep = false): Promise<void> {
    return this.db.get('contacts', contactId).then((contact) => {
      if (!contact) throw new Error('Контакт не найден')
      const content = { id: randomId(), ts: Date.now(), ...signal } as CallContent
      return this.sendContent(contact, content, undefined, keep ? undefined : CALL_SIGNAL_TTL_SEC)
    })
  }

  /** STUN/TURN-серверы для звонка с временным логином. Пустой список — соединяться напрямую. */
  iceServers(): Promise<RTCIceServer[]> {
    return this.iceWaiters.wait('ice', ICE_TIMEOUT_MS, () => this.noAnswer(), () => this.send({ t: 'ice' }))
  }

  /** Записать звонок в ленту чата. Повторная запись того же звонка ничего не меняет. */
  async addCallRecord(contactId: string, callId: string, mine: boolean, ts: number, call: CallInfo): Promise<void> {
    const text = callLabel(mine, call)
    await transact(this.db, ['conversations', 'messages'], async (tx) => {
      const messages = tx.objectStore('messages')
      const conversations = tx.objectStore('conversations')
      const conv = await conversations.get(contactId)
      if (!conv || (await messages.get(callId))) return
      const isOpen = this.activeConv === conv.id && document.visibilityState === 'visible'
      // readSent: квитанцию о прочтении слать не о чем — у собеседника этой записи нет
      await messages.put({
        id: callId, conv: conv.id, from: mine ? 'me' : contactId, ts, type: 'call', text, status: 'received', readSent: true, call,
      })
      await conversations.put({
        ...conv, lastTs: Math.max(conv.lastTs, ts), lastText: text,
        unread: call.outcome === 'missed' && !isOpen ? conv.unread + 1 : conv.unread,
      })
    })
    this.emit()
  }

  setActiveConversation(id: string | null): void {
    this.activeConv = id
    if (id) void this.markRead(id)
  }

  async markRead(convId: string): Promise<void> {
    const conv = await this.db.get('conversations', convId)
    const contact = conv?.group ? undefined : await this.db.get('contacts', convId)
    if (!conv || (!contact && !conv.group)) return
    const unreadMsgs = (await listMessages(this.db, convId)).filter((m) => m.from !== 'me' && !m.readSent)
    if (!unreadMsgs.length && !conv.unread) return
    await transact(this.db, ['messages', 'conversations'], async (tx) => {
      for (const { id } of unreadMsgs) {
        const cur = await tx.objectStore('messages').get(id)
        if (cur) await tx.objectStore('messages').put({ ...cur, readSent: true })
      }
      const fresh = await tx.objectStore('conversations').get(convId)
      if (fresh) await tx.objectStore('conversations').put({ ...fresh, unread: 0 })
    })
    this.emit()
    if (contact) await this.sendReceipt(contact, 'read', unreadMsgs.map((m) => m.id))
  }

  async deleteConversation(convId: string): Promise<void> {
    const conv = await this.db.get('conversations', convId)
    if (conv?.group) return this.leaveGroup(convId)
    const contact = await this.db.get('contacts', convId)
    // Собеседник ещё и участник общей группы: канал с ним нужен, так что удаляется только переписка
    const shared = !!contact && (await this.groupIks()).has(contact.ik)
    if (contact && !shared) await this.sendGoodbye(contact).catch(() => {})
    const msgs = await listMessages(this.db, convId)
    await writeAll(this.db, ['contacts', 'sessions', 'conversations', 'messages', 'files'], (tx) => [
      ...(shared
        ? [tx.objectStore('contacts').put({ ...contact!, groupOnly: true })]
        : [tx.objectStore('contacts').delete(convId), tx.objectStore('sessions').delete(convId)]),
      tx.objectStore('conversations').delete(convId),
      ...msgs.map((m) => tx.objectStore('messages').delete(m.id)),
      ...msgs.filter((m) => m.type === 'file').map((m) => tx.objectStore('files').delete(m.id)),
    ])
    // Ящик закрываем после удаления: если запись не удалась, чат остаётся рабочим
    if (contact && !shared) await this.closeMailbox(contact.myMailbox)
    this.emit()
  }

  async renameContact(convId: string, name: string): Promise<void> {
    const contact = await this.db.get('contacts', convId)
    const conv = await this.db.get('conversations', convId)
    name = name.trim().slice(0, 64)
    if (!contact || !conv || !name) return
    await this.db.put('contacts', { ...contact, name })
    await this.db.put('conversations', { ...conv, title: name })
    this.emit()
  }

  conversations(): Promise<Conversation[]> {
    return listConversations(this.db)
  }

  messages(convId: string): Promise<Message[]> {
    return listMessages(this.db, convId)
  }

  contact(id: string): Promise<Contact | undefined> {
    return this.db.get('contacts', id)
  }

  conversation(id: string): Promise<Conversation | undefined> {
    return this.db.get('conversations', id)
  }

  /** Люди, которым можно писать: для выбора участников группы. Без повторов одного и того же человека. */
  async people(): Promise<Contact[]> {
    const byIk = new Map<string, Contact>()
    for (const c of await this.db.getAll('contacts')) {
      if (!usable(c)) continue
      const have = byIk.get(c.ik)
      if (!have || (have.groupOnly && !c.groupOnly)) byIk.set(c.ik, c)
    }
    return [...byIk.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  // --- группы ------------------------------------------------------------------
  //
  // Группа — список участников, который ведёт её администратор (создатель). Отдельного группового
  // ключа нет: сообщение шифруется для каждого участника его парным каналом. Поэтому у каждой
  // пары участников должен быть свой канал; незнакомых друг с другом сводит администратор.

  private myIk(): string {
    return b64e(this.identity!.dh.pub)
  }

  /** Контакт человека с таким ключом личности, которому можно писать (личный чат — в приоритете). */
  private async contactByIk(ik: string): Promise<Contact | undefined> {
    const found = (await this.db.getAll('contacts')).filter((c) => c.ik === ik && usable(c))
    return found.find((c) => !c.groupOnly) ?? found[0]
  }

  /** Участники группы, с которыми уже есть канал. */
  private async groupTargets(group: GroupInfo): Promise<Contact[]> {
    const byIk = new Map<string, Contact>()
    for (const c of await this.db.getAll('contacts')) {
      if (!usable(c)) continue
      const have = byIk.get(c.ik)
      if (!have || (have.groupOnly && !c.groupOnly)) byIk.set(c.ik, c)
    }
    return group.roster.map((m) => byIk.get(m.ik)).filter((c): c is Contact => !!c)
  }

  /** Ключи всех, с кем я состою хотя бы в одной группе. */
  private async groupIks(): Promise<Set<string>> {
    const convs = await this.db.getAll('conversations')
    return new Set(convs.filter((c) => c.group && !c.group.left).flatMap((c) => c.group!.roster.map((m) => m.ik)))
  }

  /** Служебная строка в ленте группы. Возвращает беседу с обновлённой строкой для списка чатов. */
  private async note(tx: ReceiveTx | GroupTx, conv: Conversation, text: string, unread = false): Promise<Conversation> {
    const t = tx as GroupTx
    // Строки, записанные подряд, должны и в ленте идти в том же порядке — время строго растёт
    const now = (this.lastNoteTs = Math.max(Date.now(), this.lastNoteTs + 1))
    await t.objectStore('messages').put({
      id: randomId(), conv: conv.id, from: '', ts: now, type: 'note', text, status: 'received', readSent: true,
    })
    const isOpen = this.activeConv === conv.id && document.visibilityState === 'visible'
    const next = { ...conv, lastTs: now, lastText: text, unread: conv.unread + (unread && !isOpen ? 1 : 0) }
    await t.objectStore('conversations').put(next)
    return next
  }

  /** Создать группу из своих контактов. Возвращает её id. */
  async createGroup(name: string, contactIds: string[]): Promise<string> {
    name = name.trim().slice(0, NAME_MAX)
    if (!name) throw new Error('Дайте группе название')
    const roster = await this.rosterOf(contactIds)
    if (!roster.length) throw new Error('Выберите хотя бы одного участника')
    if (roster.length >= MAX_GROUP) throw new Error(`В группе может быть не больше ${MAX_GROUP} человек`)
    const conv: Conversation = {
      id: randomId(), kind: 'group', members: [], title: name, lastTs: Date.now(), lastText: '', unread: 0,
      group: { admin: 'me', rev: 1, roster },
    }
    await transact(this.db, ['conversations', 'messages'], async (tx) => {
      await this.note(tx, conv, 'Вы создали группу')
    })
    this.emit()
    await this.broadcastGroup(conv)
    return conv.id
  }

  private async rosterOf(contactIds: string[]): Promise<GroupMemberInfo[]> {
    const seen = new Set<string>([this.myIk()])
    const roster: GroupMemberInfo[] = []
    for (const id of contactIds) {
      const c = await this.db.get('contacts', id)
      if (!c || !usable(c) || seen.has(c.ik)) continue
      seen.add(c.ik)
      // Участникам уходит имя, которым человек назвался сам, а не то, как я его переименовал у себя
      roster.push({ ik: c.ik, name: c.selfName ?? c.name })
    }
    return roster
  }

  /**
   * Правка группы администратором: изменить состав или название, поднять номер состояния
   * и разослать новое состояние всем участникам (и тем, кого только что удалили, — чтобы узнали).
   */
  private async editGroup(
    gid: string,
    change: (conv: Conversation, group: GroupInfo) => { title?: string; roster?: GroupMemberInfo[]; notes: string[] },
  ): Promise<void> {
    let before: GroupInfo | undefined
    let after: Conversation | undefined
    await transact(this.db, ['conversations', 'messages'], async (tx) => {
      const conv = await tx.objectStore('conversations').get(gid)
      const g = conv?.group
      if (!conv || !g || g.left) throw new Error('Группа не найдена')
      if (g.admin !== 'me') throw new Error('Менять группу может только её администратор')
      const { title, roster, notes } = change(conv, g)
      before = g
      let next: Conversation = { ...conv, title: title ?? conv.title, group: { ...g, rev: g.rev + 1, roster: roster ?? g.roster } }
      await tx.objectStore('conversations').put(next)
      for (const text of notes) next = await this.note(tx, next, text)
      after = next
    })
    this.emit()
    if (!after?.group || !before) return
    const kept = new Set(after.group.roster.map((m) => m.ik))
    const removed: Contact[] = []
    for (const m of before.roster) {
      const c = kept.has(m.ik) ? undefined : await this.contactByIk(m.ik)
      if (c) removed.push(c)
    }
    await this.broadcastGroup(after, removed)
    await this.dropOrphanContacts()
  }

  async addGroupMembers(gid: string, contactIds: string[]): Promise<void> {
    const added = await this.rosterOf(contactIds)
    await this.editGroup(gid, (_conv, g) => {
      const fresh = added.filter((a) => !g.roster.some((m) => m.ik === a.ik))
      if (g.roster.length + fresh.length >= MAX_GROUP) throw new Error(`В группе может быть не больше ${MAX_GROUP} человек`)
      return { roster: [...g.roster, ...fresh], notes: fresh.map((m) => `${m.name} теперь в группе`) }
    })
  }

  async removeGroupMember(gid: string, ik: string): Promise<void> {
    await this.editGroup(gid, (_conv, g) => {
      const gone = g.roster.find((m) => m.ik === ik)
      return { roster: g.roster.filter((m) => m.ik !== ik), notes: gone ? [`${gone.name} больше не в группе`] : [] }
    })
  }

  async renameGroup(gid: string, name: string): Promise<void> {
    name = name.trim().slice(0, NAME_MAX)
    if (!name) return
    await this.editGroup(gid, (conv) => ({
      title: name,
      notes: conv.title === name ? [] : [`Группа теперь называется «${name}»`],
    }))
  }

  /** Разослать состояние группы всем, с кем есть канал (extra — ещё и только что удалённым). */
  private async broadcastGroup(conv: Conversation, extra: Contact[] = []): Promise<void> {
    const g = conv.group!
    const members: GroupMemberInfo[] = [{ ik: this.myIk(), name: this.profile!.name }, ...g.roster]
    const body = { name: conv.title, admin: this.myIk(), rev: g.rev, members }
    for (const c of [...(await this.groupTargets(g)), ...extra]) {
      await this.sendContent(c, { id: randomId(), ts: Date.now(), type: 'group-state', conv: conv.id, body }).catch((e) =>
        console.warn('Состояние группы не отправлено', e),
      )
    }
  }

  /** Сообщить участникам, что я выхожу. Администратор при этом передаёт управление первому из них. */
  private async announceLeave(conv: Conversation): Promise<void> {
    const g = conv.group!
    const targets = await this.groupTargets(g)
    const body = g.admin === 'me' && targets.length ? { admin: targets[0].ik } : {}
    await Promise.allSettled(
      targets.map((c) => this.sendContent(c, { id: randomId(), ts: Date.now(), type: 'group-leave', conv: conv.id, body })),
    )
  }

  /** Выйти из группы и удалить её переписку у себя. */
  async leaveGroup(gid: string): Promise<void> {
    const conv = await this.db.get('conversations', gid)
    if (!conv?.group) return
    if (!conv.group.left) await this.announceLeave(conv)
    const msgs = await listMessages(this.db, gid)
    await writeAll(this.db, ['conversations', 'messages', 'files'], (tx) => [
      tx.objectStore('conversations').delete(gid),
      ...msgs.map((m) => tx.objectStore('messages').delete(m.id)),
      ...msgs.filter((m) => m.type === 'file').map((m) => tx.objectStore('files').delete(m.id)),
    ])
    await this.dropOrphanContacts()
    this.emit()
  }

  /**
   * Убрать то, что держалось только на группах: контакты людей, с которыми общих групп больше
   * нет (а личного чата и не было), и свои неиспользованные «знакомства» для них.
   */
  private async dropOrphanContacts(): Promise<void> {
    const needed = await this.groupIks()
    for (const c of await this.db.getAll('contacts')) {
      if (!c.groupOnly || needed.has(c.ik)) continue
      await this.sendGoodbye(c).catch(() => {})
      await writeAll(this.db, ['contacts', 'sessions'], (tx) => [
        tx.objectStore('contacts').delete(c.id),
        tx.objectStore('sessions').delete(c.id),
      ])
      await this.closeMailbox(c.myMailbox)
    }
    for (const inv of await this.db.getAll('invites')) {
      if (inv.group && !needed.has(inv.group.ik)) await this.cancelInvite(inv.mailbox)
    }
  }

  /** Состояние группы от администратора: создание, новый состав, новое название, моё удаление. */
  private async applyGroupState(tx: ReceiveTx, contact: Contact, c: GroupStateContent): Promise<(() => void) | undefined> {
    const gid = c.conv
    const b = c.body
    if (typeof gid !== 'string' || !ID_RE.test(gid) || !b || typeof b.name !== 'string') return
    // Состояние вправе слать только администратор, и он сам должен быть в списке
    if (b.admin !== contact.ik || !Number.isSafeInteger(b.rev) || !Array.isArray(b.members)) return
    const me = this.myIk()
    const seen = new Set<string>()
    const members: GroupMemberInfo[] = []
    for (const m of b.members.slice(0, MAX_GROUP)) {
      if (!m || typeof m.ik !== 'string' || !IK_RE.test(m.ik) || seen.has(m.ik)) continue
      seen.add(m.ik)
      members.push({ ik: m.ik, name: String(m.name ?? '').trim().slice(0, NAME_MAX) || 'Участник' })
    }
    if (!seen.has(contact.ik)) return
    const amIn = seen.has(me)
    const roster = members.filter((m) => m.ik !== me)
    const title = b.name.trim().slice(0, NAME_MAX) || 'Группа'
    const conversations = tx.objectStore('conversations')
    const old = await conversations.get(gid)

    if (!old) {
      if (!amIn) return
      const conv: Conversation = {
        id: gid, kind: 'group', members: [], title, lastTs: Date.now(), lastText: '', unread: 0,
        group: { admin: contact.ik, rev: b.rev, roster },
      }
      await this.note(tx, conv, `${contact.name} добавил(а) вас в группу`, true)
    } else {
      const g = old.group
      if (!g || g.admin !== contact.ik || b.rev <= g.rev) return
      if (!amIn) {
        if (g.left) return
        await this.note(tx, { ...old, group: { ...g, rev: b.rev, left: 'removed' } }, 'Вас удалили из группы', true)
      } else {
        let conv: Conversation = { ...old, title, group: { admin: g.admin, rev: b.rev, roster } }
        await conversations.put(conv)
        if (g.left) conv = await this.note(tx, conv, 'Вас снова добавили в группу', true)
        if (title !== old.title) conv = await this.note(tx, conv, `Группа теперь называется «${title}»`)
        for (const m of roster) {
          if (!g.roster.some((x) => x.ik === m.ik)) conv = await this.note(tx, conv, `${m.name} теперь в группе`)
        }
        for (const m of g.roster) {
          if (!seen.has(m.ik)) conv = await this.note(tx, conv, `${m.name} больше не в группе`)
        }
      }
    }
    return () => {
      void this.linkGroup(gid).catch((e) => console.warn('Не удалось познакомиться с участниками', e))
      void this.dropOrphanContacts().catch(() => {})
    }
  }

  /** Участник вышел из группы (администратор — передав управление). */
  private async applyGroupLeave(tx: ReceiveTx, contact: Contact, c: GroupLeaveContent): Promise<(() => void) | undefined> {
    const gid = c.conv
    if (typeof gid !== 'string' || !ID_RE.test(gid)) return
    const conv = await tx.objectStore('conversations').get(gid)
    const g = conv?.group
    if (!conv || !g || g.left || !inGroup(g, contact.ik)) return
    const roster = g.roster.filter((m) => m.ik !== contact.ik)
    let admin = g.admin
    if (g.admin === contact.ik) {
      // Преемника называет сам уходящий администратор; не назвал годного — группа остаётся без управления
      const heir = c.body?.admin
      admin = heir === this.myIk() ? 'me' : roster.some((m) => m.ik === heir) ? (heir as string) : ''
    }
    const mine = g.admin === 'me'
    // Мой номер состояния растёт, только если состоянием управляю я
    let next: Conversation = { ...conv, group: { ...g, admin, roster, rev: mine || admin === 'me' ? g.rev + 1 : g.rev } }
    await tx.objectStore('conversations').put(next)
    next = await this.note(tx, next, `${contact.name} вышел(ла) из группы`)
    if (admin === 'me' && !mine) next = await this.note(tx, next, 'Теперь группой управляете вы', true)
    return () => {
      // Вышедший мог знать не всех — администратор сообщает новый состав остальным
      if (mine) void this.broadcastGroup(next).catch(() => {})
      void this.dropOrphanContacts().catch(() => {})
    }
  }

  /**
   * Познакомиться с участниками группы, с которыми ещё нет канала. Из двоих приглашение создаёт
   * тот, чей ключ меньше (так оба решают одинаково), и передаёт его через администратора:
   * с ним канал есть у каждого. Второй отвечает на приглашение, как на обычную ссылку.
   */
  private async linkGroup(gid: string): Promise<void> {
    const conv = await this.db.get('conversations', gid)
    const g = conv?.group
    if (!g || g.left || g.admin === 'me' || !g.admin) return
    const admin = await this.contactByIk(g.admin)
    if (!admin) return
    const me = this.myIk()
    const waiting = new Set((await this.db.getAll('invites')).map((i) => i.group?.ik))
    for (const m of g.roster) {
      if (m.ik === g.admin || me > m.ik || waiting.has(m.ik) || (await this.contactByIk(m.ik))) continue
      const inv: PendingInvite = { ...(await createInviteCrypto(this.identity!, this.profile!.name)), group: { gid, ik: m.ik } }
      await this.db.put('invites', inv)
      this.send({ t: 'register', mailbox: inv.mailbox, invite: true })
      await this.sendContent(admin, {
        id: randomId(), ts: Date.now(), type: 'group-intro', conv: gid,
        body: { for: m.ik, invite: encodeInvite(inv.payload) },
      })
    }
  }

  /** «Знакомство»: администратор пересылает его адресату, адресат — принимает. */
  private async onGroupIntro(contact: Contact, c: GroupIntroContent): Promise<void> {
    const gid = c.conv
    const b = c.body
    const conv = typeof gid === 'string' && ID_RE.test(gid) ? await this.db.get('conversations', gid) : undefined
    const g = conv?.group
    if (!g || g.left || !b || typeof b.invite !== 'string' || b.invite.length > 600) return
    let invite: InvitePayload
    try {
      invite = decodeInvite(b.invite)
    } catch {
      return
    }
    const member = (ik: unknown) => typeof ik === 'string' && g.roster.some((m) => m.ik === ik)
    if (g.admin === 'me') {
      // Пересылаю: только между участниками и только приглашение самого отправителя
      if (!member(contact.ik) || !member(b.for) || invite.ik !== contact.ik) return
      const target = await this.contactByIk(b.for!)
      if (!target) return
      await this.sendContent(target, {
        id: randomId(), ts: Date.now(), type: 'group-intro', conv: gid,
        body: { from: contact.ik, invite: b.invite },
      })
      return
    }
    // Принимаю: только от администратора и только если ключ в приглашении — того, кого он назвал
    if (contact.ik !== g.admin || !member(b.from) || invite.ik !== b.from) return
    if (await this.contactByIk(invite.ik)) return
    const { session, preKey } = await acceptInviteCrypto(this.identity!, invite)
    const said = invite.n?.trim().slice(0, NAME_MAX)
    const created: Contact = {
      id: randomId(),
      name: said || 'Участник',
      ...(said ? { selfName: said } : {}),
      groupOnly: true,
      myMailbox: randomId(),
      theirMailbox: invite.m,
      ik: invite.ik,
      sigPub: invite.sk,
      createdAt: Date.now(),
    }
    await writeAll(this.db, ['contacts', 'sessions'], (tx) => [
      tx.objectStore('contacts').put(created),
      tx.objectStore('sessions').put({ contactId: created.id, state: session, preKey }),
    ])
    this.send({ t: 'register', mailbox: created.myMailbox, invite: false })
    await this.sendContent(created, {
      id: randomId(), ts: Date.now(), type: 'hello',
      body: { name: this.profile!.name, mailbox: created.myMailbox, sigPub: b64e(this.identity!.sig.pub) },
    })
    this.emit()
  }

  /** Группа глазами интерфейса: участники с именами и тем, есть ли с ними канал. */
  async group(gid: string): Promise<GroupView | null> {
    const conv = await this.db.get('conversations', gid)
    const g = conv?.group
    if (!conv || !g) return null
    const members: GroupView['members'] = []
    for (const m of g.roster) {
      const c = await this.contactByIk(m.ik)
      members.push({ ik: m.ik, name: c?.name ?? m.name, contactId: c?.id ?? null, admin: g.admin === m.ik })
    }
    return { id: gid, title: conv.title, amAdmin: g.admin === 'me', left: g.left ?? null, members }
  }

  async safetyNumber(contactId: string): Promise<string | null> {
    const c = await this.db.get('contacts', contactId)
    return c ? safetyNumber(this.identity!.dh.pub, b64d(c.ik)) : null
  }
}

/** Группа для интерфейса. contactId: null — канала с участником ещё нет, он сообщений не получит. */
export interface GroupView {
  id: string
  title: string
  amAdmin: boolean
  left: 'left' | 'removed' | null
  members: { ik: string; name: string; contactId: string | null; admin: boolean }[]
}

type GroupTx = WriteTx<('conversations' | 'messages')[]>

/** Контакту можно писать: его ящик известен и он не удалил чат. */
const usable = (c: Contact) => !!c.theirMailbox && !c.gone

/** Этот ключ — участник группы (администратор тоже в списке, кроме случая, когда администратор я). */
const inGroup = (g: GroupInfo, ik: string) => g.admin === ik || g.roster.some((m) => m.ik === ik)

type Waiter<T> = { resolve: (v: T) => void; reject: (e: Error) => void }

/** Запросы к серверу, ждущие ответа по ящику (probe, register). */
class Waiters<T> {
  private map = new Map<string, Waiter<T>[]>()

  /**
   * Отправить запрос (send) и ждать, пока ответ не придёт через resolve/reject.
   * Не дождались за ms — отказ с ошибкой из onTimeout. send вернул false — сразу «нет связи».
   */
  wait(key: string, ms: number, onTimeout: () => Error, send: () => boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.remove(key, w)
        reject(onTimeout())
      }, ms)
      const w: Waiter<T> = {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      this.map.set(key, [...(this.map.get(key) ?? []), w])
      if (!send()) {
        this.remove(key, w)
        w.reject(new Error(NO_CONNECTION))
      }
    })
  }

  resolve(key: string, v: T): void {
    this.take(key).forEach((w) => w.resolve(v))
  }

  reject(key: string, e: Error): void {
    this.take(key).forEach((w) => w.reject(e))
  }

  rejectAll(e: Error): void {
    for (const key of [...this.map.keys()]) this.reject(key, e)
  }

  private take(key: string): Waiter<T>[] {
    const list = this.map.get(key) ?? []
    this.map.delete(key)
    return list
  }

  private remove(key: string, w: Waiter<T>) {
    const rest = (this.map.get(key) ?? []).filter((x) => x !== w)
    if (rest.length) this.map.set(key, rest)
    else this.map.delete(key)
  }
}

/** Строка в списке чатов для сообщения с файлом */
/** Строка в списке чатов: подпись, если она есть, иначе имя файла. */
export const fileLabel = (name: string, caption = '') => `📎 ${caption || name}`

/** Имя файла без путей и управляющих символов, не длиннее 200 знаков (расширение сохраняется). */
function cleanFileName(name: string): string {
  const n = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim()
  return (n.length > 200 ? `${n.slice(0, 150)}…${n.slice(-49)}` : n) || 'файл'
}

function cleanMime(mime: string): string {
  mime = mime.toLowerCase()
  return mime.length <= 100 && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : 'application/octet-stream'
}

/** Проверить описание файла из входящего сообщения. */
function parseFile(b: unknown): FileInfo | null {
  if (!b || typeof b !== 'object') return null
  const { blob, key, size, name, mime } = b as Record<string, unknown>
  if (typeof blob !== 'string' || !BLOB_ID_RE.test(blob)) return null
  if (typeof key !== 'string' || !FILE_KEY_RE.test(key)) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE) return null
  return { blob, key, size, name: cleanFileName(String(name ?? '')), mime: cleanMime(String(mime ?? '')), state: 'loading' }
}

/** Строка о звонке для ленты и списка чатов. */
export function callLabel(mine: boolean, call: CallInfo): string {
  switch (call.outcome) {
    case 'answered': {
      const s = Math.max(0, Math.round(call.duration ?? 0))
      const time = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
      return `${mine ? 'Исходящий' : 'Входящий'} ${call.video ? 'видеозвонок' : 'звонок'} · ${time}`
    }
    case 'missed':
      return call.video ? 'Пропущенный видеозвонок' : 'Пропущенный звонок'
    case 'declined':
      return mine ? 'Звонок отклонён' : 'Отклонённый звонок'
    case 'noanswer':
      return 'Звонок без ответа'
    case 'busy':
      return 'Собеседник был занят'
    case 'cancelled':
      return 'Отменённый звонок'
    case 'failed':
      return 'Звонок не удался'
  }
}

function newConversation(contact: Contact): Conversation {
  return {
    id: contact.id, kind: 'direct', members: [contact.id], title: contact.name,
    lastTs: Date.now(), lastText: '', unread: 0,
  }
}
