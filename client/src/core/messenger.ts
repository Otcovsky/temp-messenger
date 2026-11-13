/**
 * Ядро клиента: связывает криптографию, хранилище и транспорт.
 *
 * Все операции, меняющие состояние храповика (шифрование и расшифровка),
 * выполняются строго по очереди через serial(): иначе два параллельных
 * сообщения испортили бы сессию.
 */
import { b64d, b64e, randomId } from '../crypto/bytes'
import {
  type Identity,
  type InvitePayload,
  type PendingInvite,
  acceptInvite as acceptInviteCrypto,
  completeInvite,
  createInvite as createInviteCrypto,
  encodeInvite,
  safetyNumber,
} from '../crypto/handshake'
import { type KeyPair, generateDH, generateSigning } from '../crypto/primitives'
import { ratchetDecrypt, ratchetEncrypt } from '../crypto/ratchet'
import { type Content, decodeContent, decodePayload, encodeContent, encodePayload } from '../protocol/envelope'
import {
  type Contact,
  type Conversation,
  type DB,
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
  wipeStore,
  writeAll,
} from '../storage/db'
import { type ConnStatus, type InviteState, type ServerFrame, Transport, defaultServerUrl } from '../transport/ws'

const INVITE_TTL_MS = 30 * 24 * 3600 * 1000
const MAX_TEXT = 10_000
const MAILBOX_RE = /^[A-Za-z0-9_-]{22}$/
const PROBE_TIMEOUT_MS = 10_000
const REGISTER_TIMEOUT_MS = 8_000
/** Сколько id уже обработанных входящих помнить, чтобы не разбирать повторную доставку */
const HANDLED_MAX = 2_000
const NO_CONNECTION = 'Нет связи с сервером. Попробуйте ещё раз, когда связь появится.'
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
  /** Проверка базы при запуске: onReady ждёт её, чтобы не регистрировать ящики удаляемых контактов */
  private repaired: Promise<void> = Promise.resolve()
  /**
   * Id входящих, уже взятых в работу. Сервер может прислать сообщение повторно (например,
   * после перерегистрации ящика, пока ack ещё не дошёл), а повторная расшифровка уже
   * использованным ключом храповика заканчивается ошибкой.
   */
  private handled = new Set<string>()
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
      if (await this.db.get('conversations', c.id)) continue
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

  /** Удалить всё: сообщить собеседникам, закрыть ящики на сервере, стереть базу. */
  async wipeAll(): Promise<void> {
    try {
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
        void this.serial(() => this.receive(f.mailbox, f.payload))
          .catch((e) => console.warn('Не удалось обработать сообщение', e))
          .finally(() => this.transport?.send({ t: 'ack', mailbox: f.mailbox, ids: [f.id] }))
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
      case 'error':
        console.warn('Ошибка сервера:', f.code, f.ref ?? '')
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
      if (this.inFlight.has(it.id)) continue
      if (!this.transport.send({ t: 'send', id: it.id, to: it.to, payload: it.payload })) break
      this.inFlight.add(it.id)
    }
  }

  private async onSent(id: string, failed: { to: string; reason: string }[]) {
    this.inFlight.delete(id)
    const item = await this.db.get('outbox', id)
    if (!item) return
    await this.db.delete('outbox', id)
    if (failed.some((f) => f.reason === 'no_mailbox')) {
      const contacts = await this.db.getAll('contacts')
      for (const c of contacts) {
        if (c.theirMailbox && failed.some((f) => f.to === c.theirMailbox)) await this.db.put('contacts', { ...c, gone: true })
      }
    }
    if (item.msgId) await this.updateStatus(item.msgId, failed.length ? 'failed' : 'sent')
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

  listInvites(): Promise<PendingInvite[]> {
    return this.db.getAll('invites')
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

  async sendText(convId: string, text: string): Promise<void> {
    text = text.trim().slice(0, MAX_TEXT)
    if (!text) return
    const conv = await this.db.get('conversations', convId)
    const contact = conv && (await this.db.get('contacts', conv.members[0]))
    if (!conv || !contact) throw new Error('Беседа не найдена')
    const msg: Message = { id: randomId(), conv: convId, from: 'me', ts: Date.now(), type: 'text', text, status: 'pending' }
    await this.db.put('messages', msg)
    await this.db.put('conversations', { ...conv, lastTs: msg.ts, lastText: text })
    this.emit()
    try {
      await this.sendContent(contact, { id: msg.id, ts: msg.ts, type: 'text', body: { text } }, msg.id)
    } catch (e) {
      await this.updateStatus(msg.id, 'failed')
      this.emit()
      throw e
    }
  }

  /** Повторить отправку сообщения, которое не дошло до сервера. */
  async retry(msgId: string): Promise<void> {
    const msg = await this.db.get('messages', msgId)
    if (!msg || msg.from !== 'me' || msg.status !== 'failed') return
    await this.db.delete('messages', msgId)
    await this.sendText(msg.conv, msg.text)
  }

  private sendContent(contact: Contact, content: Content, msgId?: string): Promise<void> {
    return this.serial(async () => {
      if (!contact.theirMailbox || contact.gone) throw new Error('Собеседнику больше нельзя писать')
      const sess = await this.db.get('sessions', contact.id)
      if (!sess) throw new Error('Нет сессии шифрования')
      const r = await ratchetEncrypt(sess.state, encodeContent(content))
      const payload = encodePayload(r.header, r.ciphertext, sess.preKey)
      const to = contact.theirMailbox
      await writeAll(this.db, ['sessions', 'outbox'], (tx) => [
        tx.objectStore('sessions').put({ ...sess, state: r.state }),
        tx.objectStore('outbox').put({ id: content.id, to: [to], payload, createdAt: Date.now(), msgId }),
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

  private async receive(mailbox: string, raw: string): Promise<void> {
    const { header, ct, pk } = decodePayload(raw)
    let contact = await this.db.getFromIndex('contacts', 'byMyMailbox', mailbox)

    if (!contact) {
      // Первое сообщение по моему приглашению
      const invite = await this.db.get('invites', mailbox)
      if (!invite || !pk) return
      const state = await completeInvite(this.identity!, invite, pk)
      const r = await ratchetDecrypt(state, header, ct)
      const hello = decodeContent(r.plaintext)
      if (hello?.type !== 'hello' || !MAILBOX_RE.test(hello.body.mailbox)) return
      contact = {
        id: randomId(),
        name: String(hello.body.name || '').trim().slice(0, 64) || 'Без имени',
        myMailbox: mailbox,
        theirMailbox: hello.body.mailbox,
        ik: pk.ik,
        sigPub: typeof hello.body.sigPub === 'string' ? hello.body.sigPub : null,
        createdAt: Date.now(),
      }
      const created = contact
      await writeAll(this.db, ['invites', 'contacts', 'sessions', 'conversations'], (tx) => [
        tx.objectStore('invites').delete(mailbox), // приглашение одноразовое
        tx.objectStore('contacts').put(created),
        tx.objectStore('sessions').put({ contactId: created.id, state: r.state }),
        tx.objectStore('conversations').put(newConversation(created)),
      ])
      // Ящик теперь обычный: повторно открытая ссылка не создаст «мёртвый» чат
      this.transport?.send({ t: 'register', mailbox, invite: false })
      this.emit()
      return
    }

    const sess = await this.db.get('sessions', contact.id)
    if (!sess) return
    const r = await ratchetDecrypt(sess.state, header, ct)
    // Собеседник ответил — prekey-заголовок больше не нужен
    await this.db.put('sessions', { contactId: contact.id, state: r.state })
    const content = decodeContent(r.plaintext)
    if (content) await this.handleContent(contact, content)
    this.emit()
  }

  private async handleContent(contact: Contact, c: Content) {
    switch (c.type) {
      case 'text': {
        if (await this.db.get('messages', c.id)) return
        const conv = await this.db.get('conversations', contact.id)
        if (!conv) return
        const text = String(c.body?.text ?? '').slice(0, MAX_TEXT)
        const isOpen = this.activeConv === conv.id && document.visibilityState === 'visible'
        await this.db.put('messages', {
          id: c.id, conv: conv.id, from: contact.id, ts: c.ts, type: 'text', text, status: 'received', readSent: isOpen,
        })
        await this.db.put('conversations', {
          ...conv, lastTs: Math.max(conv.lastTs, c.ts), lastText: text, unread: isOpen ? 0 : conv.unread + 1,
        })
        // Без await: мы внутри serial(), а отправка сама встаёт в ту же очередь
        void this.sendReceipt(contact, isOpen ? 'read' : 'delivered', [c.id])
        break
      }
      case 'receipt': {
        const ids = Array.isArray(c.body?.ids) ? c.body.ids.slice(0, 500) : []
        for (const id of ids) {
          const m = await this.db.get('messages', String(id))
          if (m && m.from === 'me' && m.conv === contact.id) await this.updateStatus(m.id, c.body.status)
        }
        break
      }
      case 'goodbye':
        await this.db.put('contacts', { ...contact, gone: true })
        break
      case 'hello':
        break // повторный hello по уже установленной сессии — игнорируем
    }
  }

  private async updateStatus(id: string, status: MessageStatus) {
    const m = await this.db.get('messages', id)
    if (!m) return
    // Статус только растёт (sent → delivered → read); failed — особый случай
    if (status === 'failed' ? m.status === 'pending' : STATUS_RANK[status] > STATUS_RANK[m.status]) {
      await this.db.put('messages', { ...m, status })
    }
  }

  // --- для UI --------------------------------------------------------------

  setActiveConversation(id: string | null): void {
    this.activeConv = id
    if (id) void this.markRead(id)
  }

  async markRead(convId: string): Promise<void> {
    const conv = await this.db.get('conversations', convId)
    const contact = await this.db.get('contacts', convId)
    if (!conv || !contact) return
    const unreadMsgs = (await listMessages(this.db, convId)).filter((m) => m.from !== 'me' && !m.readSent)
    if (!unreadMsgs.length && !conv.unread) return
    for (const m of unreadMsgs) await this.db.put('messages', { ...m, readSent: true })
    await this.db.put('conversations', { ...conv, unread: 0 })
    this.emit()
    await this.sendReceipt(contact, 'read', unreadMsgs.map((m) => m.id))
  }

  async deleteConversation(convId: string): Promise<void> {
    const contact = await this.db.get('contacts', convId)
    if (contact) await this.sendGoodbye(contact).catch(() => {})
    const msgs = await listMessages(this.db, convId)
    await writeAll(this.db, ['contacts', 'sessions', 'conversations', 'messages'], (tx) => [
      tx.objectStore('contacts').delete(convId),
      tx.objectStore('sessions').delete(convId),
      tx.objectStore('conversations').delete(convId),
      ...msgs.map((m) => tx.objectStore('messages').delete(m.id)),
    ])
    // Ящик закрываем после удаления: если запись не удалась, чат остаётся рабочим
    if (contact) await this.closeMailbox(contact.myMailbox)
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

  async safetyNumber(contactId: string): Promise<string | null> {
    const c = await this.db.get('contacts', contactId)
    return c ? safetyNumber(this.identity!.dh.pub, b64d(c.ik)) : null
  }
}

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

function newConversation(contact: Contact): Conversation {
  return {
    id: contact.id, kind: 'direct', members: [contact.id], title: contact.name,
    lastTs: Date.now(), lastText: '', unread: 0,
  }
}
