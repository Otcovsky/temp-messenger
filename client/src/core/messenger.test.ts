/**
 * Сквозная проверка ядра: два клиента с отдельными базами (fake-indexeddb) общаются
 * через ретранслятор в памяти, который ведёт себя как сервер из server/app/main.py.
 */
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { relay, FakeTransport, blobs } = vi.hoisted(() => {
  type Frame = Record<string, any>
  interface Box {
    owner: FakeTransport
    invite: boolean
    queue: Map<string, string>
  }

  class Relay {
    boxes = new Map<string, Box>()
    /** Все payload, которые видел сервер */
    seen: string[] = []
    /**
     * Каждый принятый send, по порядку: кто отправил, флаг notify и срок хранения (ttl; undefined —
     * обычный). Отправитель нужен, потому что клиенты прошлых тестов ещё живы и тоже что-то шлют.
     */
    sends: { from: unknown; notify: unknown; ttl: number | undefined }[] = []

    reset() {
      this.boxes.clear()
      this.seen = []
      this.sends = []
    }

    handle(from: FakeTransport, f: Frame) {
      const box = this.boxes.get(f.mailbox)
      switch (f.t) {
        case 'register': {
          if (box && box.owner !== from) return from.deliver({ t: 'error', code: 'forbidden', ref: f.mailbox })
          const b = box ?? { owner: from, invite: !!f.invite, queue: new Map() }
          if (typeof f.invite === 'boolean') b.invite = f.invite
          this.boxes.set(f.mailbox, b)
          from.deliver({ t: 'registered', mailbox: f.mailbox, created: !box })
          for (const [id, payload] of b.queue) from.deliver({ t: 'msg', id, mailbox: f.mailbox, payload, ts: 0 })
          break
        }
        case 'probe':
          from.deliver({ t: 'probe', mailbox: f.mailbox, state: !box ? 'none' : box.invite ? 'open' : 'used' })
          break
        case 'unregister':
          if (box?.owner === from) this.boxes.delete(f.mailbox)
          from.deliver({ t: 'unregistered', mailbox: f.mailbox })
          break
        case 'send': {
          const failed: Frame[] = []
          this.sends.push({ from, notify: f.notify ?? false, ttl: f.ttl })
          for (const to of f.to as string[]) {
            const b = this.boxes.get(to)
            if (!b) {
              failed.push({ to, reason: 'no_mailbox' })
            } else if (!b.queue.has(f.id)) {
              this.seen.push(f.payload)
              b.queue.set(f.id, f.payload)
              if (b.owner.online) b.owner.deliver({ t: 'msg', id: f.id, mailbox: to, payload: f.payload, ts: 0 })
            }
          }
          from.deliver({ t: 'sent', id: f.id, failed })
          break
        }
        case 'ack':
          if (box?.owner === from) for (const id of f.ids) box.queue.delete(id)
          break
      }
    }
  }

  const relay = new Relay()

  class FakeTransport {
    online = false
    constructor(
      _url: string,
      _auth: unknown,
      private h: { onReady(): void; onFrame(f: Frame): void; onStatus(s: string): void },
    ) {}

    get isReady() {
      return this.online
    }

    start() {
      this.online = true
      this.h.onStatus('online')
      this.h.onReady()
    }

    stop() {
      this.online = false
      this.h.onStatus('offline')
    }

    checkAlive() {}

    send(frame: Frame): boolean {
      if (!this.online) return false
      const copy = JSON.parse(JSON.stringify(frame))
      setTimeout(() => relay.handle(this, copy), 0)
      return true
    }

    deliver(frame: Frame) {
      setTimeout(() => this.online && this.h.onFrame(frame), 0)
    }
  }

  /** Хранилище файлов, как /blob на сервере: файл стирается, когда его скачают все получатели */
  class Blobs {
    files = new Map<string, { data: Uint8Array; remaining: number }>()
    /** Следующие n загрузок падают со сбоем связи */
    failUploads = 0

    reset() {
      this.files.clear()
      this.failUploads = 0
    }
  }
  const blobs = new Blobs()

  return { relay, FakeTransport, blobs }
})

vi.mock('../transport/ws', () => ({ Transport: FakeTransport, defaultServerUrl: () => 'ws://test/ws' }))
vi.mock('../transport/blobs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../transport/blobs')>()
  return {
    BlobError: real.BlobError,
    async putBlob(id: string, ct: Uint8Array, n: number) {
      if (blobs.failUploads > 0) {
        blobs.failUploads--
        throw new real.BlobError('Нет связи с сервером.', false)
      }
      if (!blobs.files.has(id)) blobs.files.set(id, { data: ct.slice(), remaining: n })
    },
    async getBlob(id: string) {
      return blobs.files.get(id)?.data.slice() ?? null
    },
    async blobDone(id: string) {
      const f = blobs.files.get(id)
      if (f && --f.remaining <= 0) blobs.files.delete(id)
    },
  }
})

import { setLang } from '../i18n'
import { Messenger } from './messenger'

// Тексты в проверках — русские
setLang('ru', false)

/** Открытые методы Messenger плюс доступ к внутренностям, нужным тестам */
type Client = Omit<Messenger, never> & { db: any; transport: any }

async function client(name: string): Promise<Client> {
  globalThis.indexedDB = new IDBFactory() // у каждого клиента своя база
  const m = (await Messenger.open()) as unknown as Client
  await m.createAccount(name)
  m.start('ws://test/ws')
  return m
}

async function until<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('условие не выполнилось')
}

const settle = () => new Promise((r) => setTimeout(r, 60))

/** Что этот клиент отправил на сервер (с какого места журнала считать — from). */
const sentBy = (m: Client, from = 0) => relay.sends.slice(from).filter((s) => s.from === m.transport)

/** Алиса приглашает, Боб принимает. Возвращает клиентов и id беседы у каждого. */
async function connected() {
  const alice = await client('Алиса')
  const bob = await client('Боб')
  const invite = await alice.createInvite()
  const bobConv = await bob.acceptInvite(invite.payload)
  const aliceConv = (await until(async () => (await alice.conversations())[0])).id
  return { alice, bob, aliceConv, bobConv, invite }
}

const texts = async (m: Client, conv: string) => (await m.messages(conv)).map((x: any) => x.text)

/** Следующая запись входящего сообщения в базу падает посреди транзакции (как при нехватке места). */
function failNextMessageWrite(m: Client) {
  const real = m.db
  let armed = true
  m.db = new Proxy(real, {
    get(t: any, p: string) {
      if (p === 'transaction') {
        return (stores: string | string[], mode?: string) => {
          const tx = t.transaction(stores, mode)
          if (!armed || mode !== 'readwrite' || ![stores].flat().includes('messages')) return tx
          armed = false
          return new Proxy(tx, {
            get(tt: any, pp: string) {
              if (pp !== 'objectStore') {
                const v = tt[pp]
                return typeof v === 'function' ? v.bind(tt) : v
              }
              return (name: string) => {
                const store = tt.objectStore(name)
                if (name !== 'messages') return store
                return new Proxy(store, {
                  get(s: any, k: string) {
                    if (k === 'put') return () => Promise.reject(new DOMException('нет места', 'QuotaExceededError'))
                    const v = s[k]
                    return typeof v === 'function' ? v.bind(s) : v
                  },
                })
              }
            },
          })
        }
      }
      const v = t[p]
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
}

beforeEach(() => {
  relay.reset()
  blobs.reset()
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('обмен сообщениями', () => {
  it('приглашение, переписка в обе стороны, квитанции', async () => {
    const { alice, bob, aliceConv, bobConv } = await connected()
    await bob.sendText(bobConv, 'привет')
    await until(async () => (await texts(alice, aliceConv)).includes('привет'))
    await alice.sendText(aliceConv, 'и тебе')
    await until(async () => (await texts(bob, bobConv)).includes('и тебе'))
    await until(async () => (await bob.messages(bobConv)).find((x: any) => x.text === 'привет')?.status === 'delivered')
    // всё подтверждено — на сервере ничего не осталось
    await until(() => [...relay.boxes.values()].every((b) => b.queue.size === 0))
    expect(await alice.safetyNumber(aliceConv)).toBe(await bob.safetyNumber(bobConv))
  })

  it('сервер не видит ключ личности принявшего приглашение', async () => {
    const { alice, bob, aliceConv, bobConv } = await connected()
    await bob.sendText(bobConv, 'раз')
    await until(async () => (await texts(alice, aliceConv)).includes('раз'))
    const bobIk = (await alice.contact(aliceConv))!.ik
    const aliceIk = (await bob.contact(bobConv))!.ik
    expect(relay.seen.some((p) => p.includes('"pk"'))).toBe(true)
    for (const p of relay.seen) {
      expect(p).not.toContain(bobIk)
      expect(p).not.toContain(aliceIk)
    }
  })

  it('сбой записи: сообщение не подтверждается и приходит снова', async () => {
    const { alice, bob, aliceConv, bobConv } = await connected()
    await bob.sendText(bobConv, 'первое')
    await until(async () => (await texts(alice, aliceConv)).includes('первое'))
    await until(() => [...relay.boxes.values()].every((b) => b.queue.size === 0))

    failNextMessageWrite(alice)
    await bob.sendText(bobConv, 'второе')
    await settle()
    const aliceBox = relay.boxes.get((await alice.contact(aliceConv))!.myMailbox)!
    expect(await texts(alice, aliceConv)).toEqual(['первое'])
    expect(aliceBox.queue.size).toBe(1) // ack не ушёл

    // Переподключение: сервер присылает сообщение снова. Состояние храповика откатилось
    // вместе с неудавшейся записью, поэтому оно расшифровывается.
    alice.transport.stop()
    alice.transport.start()
    await until(async () => (await texts(alice, aliceConv)).includes('второе'))
    await until(() => aliceBox.queue.size === 0)

    // сессия цела в обе стороны
    await alice.sendText(aliceConv, 'ответ')
    await until(async () => (await texts(bob, bobConv)).includes('ответ'))
  })

  it('негодное сообщение отбрасывается и подтверждается', async () => {
    const { alice, bob, aliceConv, bobConv } = await connected()
    const mailbox = (await alice.contact(aliceConv))!.myMailbox
    relay.handle(bob.transport, { t: 'send', id: 'garbage-0001', to: [mailbox], payload: 'не json' })
    relay.handle(bob.transport, {
      t: 'send', id: 'garbage-0002', to: [mailbox],
      payload: JSON.stringify({ v: 1, h: { dh: 'A'.repeat(43), pn: 0, n: 0 }, ct: 'AAAA' }),
    })
    await settle()
    expect(relay.boxes.get(mailbox)!.queue.size).toBe(0)
    await bob.sendText(bobConv, 'живо')
    await until(async () => (await texts(alice, aliceConv)).includes('живо'))
  })

  it('пометка «ящика нет» снимается, когда собеседник возвращается', async () => {
    const { alice, bob, aliceConv, bobConv } = await connected()
    await bob.sendText(bobConv, 'до')
    await until(async () => (await texts(alice, aliceConv)).includes('до'))
    await alice.sendText(aliceConv, 'ок')
    await until(async () => (await texts(bob, bobConv)).includes('ок'))
    await settle()

    // Алиса долго не в сети — сервер удалил её ящик
    const aliceMailbox = (await alice.contact(aliceConv))!.myMailbox
    alice.transport.stop()
    relay.boxes.delete(aliceMailbox)
    await bob.sendText(bobConv, 'в никуда')
    const lost = await until(async () => {
      const c = await bob.contact(bobConv)
      return c?.gone ? c : null
    })
    expect(lost.goneBy).toBe('no_mailbox')
    await expect(bob.sendText(bobConv, 'ещё')).rejects.toThrow()

    // Алиса вернулась и написала — Боб снова может отвечать
    alice.transport.start()
    await alice.sendText(aliceConv, 'я тут')
    await until(async () => (await texts(bob, bobConv)).includes('я тут'))
    expect((await bob.contact(bobConv))!.gone).toBeUndefined()
    await bob.sendText(bobConv, 'с возвращением')
    await until(async () => (await texts(alice, aliceConv)).includes('с возвращением'))
  })

  it('после goodbye чат закрыт окончательно', async () => {
    const { alice, bob, aliceConv, bobConv } = await connected()
    await bob.sendText(bobConv, 'привет')
    await until(async () => (await texts(alice, aliceConv)).includes('привет'))
    await alice.deleteConversation(aliceConv)
    const c = await until(async () => {
      const c = await bob.contact(bobConv)
      return c?.gone ? c : null
    })
    expect(c.goneBy).toBe('goodbye')
    await expect(bob.sendText(bobConv, 'эй')).rejects.toThrow()
  })
})

describe('файлы', () => {
  const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff)
  const fileMsg = async (m: Client, conv: string) => (await m.messages(conv)).find((x: any) => x.type === 'file')

  it('файл шифруется, доходит целым и стирается с сервера после скачивания', async () => {
    const { alice, bob, aliceConv, bobConv } = await connected()
    const data = bytes(70_000)
    await alice.sendFile(aliceConv, new File([data], 'отчёт.pdf', { type: 'application/pdf' }))

    const got = await until(async () => {
      const m = await fileMsg(bob, bobConv)
      return m?.file?.state === 'ready' ? m : null
    })
    expect(got.file).toMatchObject({ name: 'отчёт.pdf', mime: 'application/pdf', size: data.length })
    expect(got.transfer).toBeUndefined()
    expect(new Uint8Array((await bob.fileData(got.id))!)).toEqual(data)
    expect((await bob.conversations())[0].lastText).toBe('📎 отчёт.pdf')

    // У отправителя: файл свой, сообщение доставлено
    const mine = await until(async () => {
      const m = await fileMsg(alice, aliceConv)
      return m?.status === 'delivered' ? m : null
    })
    expect(mine.transfer).toBeUndefined()
    expect(new Uint8Array((await alice.fileData(mine.id))!)).toEqual(data)
    expect(got.text).toBe('')

    // На сервере было только шифротекст, дополненный до размера по Padmé, и его больше нет
    await until(() => blobs.files.size === 0)
    for (const p of relay.seen) expect(p).not.toContain('отчёт')
  })

  it('подпись к файлу доходит вместе с ним и не теряется при повторной загрузке', async () => {
    const { alice, bob, aliceConv, bobConv } = await connected()
    blobs.failUploads = 1 // первая загрузка срывается — подпись должна уйти со второй
    await alice.sendFile(aliceConv, new File([bytes(10)], 'photo.png', { type: 'image/png' }), '  Вид из окна  ')
    expect(await fileMsg(alice, aliceConv)).toMatchObject({ text: 'Вид из окна', transfer: 'up' })
    expect((await alice.conversations())[0].lastText).toBe('📎 Вид из окна')

    alice.transport.stop()
    alice.transport.start()
    const got = await until(async () => {
      const m = await fileMsg(bob, bobConv)
      return m?.file?.state === 'ready' ? m : null
    })
    expect(got.text).toBe('Вид из окна')
    expect(got.file?.name).toBe('photo.png')
    expect((await bob.conversations())[0].lastText).toBe('📎 Вид из окна')
    for (const p of relay.seen) expect(p).not.toContain('Вид из окна')
  })

  it('пачка файлов приходит альбомом: общий id, порядок сохранён, подпись у последнего', async () => {
    const { alice, bob, aliceConv, bobConv } = await connected()
    const files = ['1.png', '2.jpg', 'смета.xlsx'].map((n, i) => new File([bytes(10 + i)], n))
    await alice.sendFiles(aliceConv, files, 'Всё по объекту')

    const got = await until(async () => {
      const list = (await bob.messages(bobConv)).filter((x: any) => x.type === 'file')
      return list.length === 3 && list.every((x: any) => x.file?.state === 'ready') ? list : null
    })
    expect(got.map((x: any) => x.file.name)).toEqual(['1.png', '2.jpg', 'смета.xlsx'])
    expect(new Set(got.map((x: any) => x.album)).size).toBe(1)
    expect(got[0].album).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(got.map((x: any) => x.text)).toEqual(['', '', 'Всё по объекту'])
    expect((await bob.conversations())[0].lastText).toBe('📎 Всё по объекту')

    // У одиночного файла альбома нет
    await alice.sendFile(aliceConv, new File([bytes(3)], 'one.txt'))
    const single = await until(async () => (await bob.messages(bobConv)).find((x: any) => x.file?.name === 'one.txt'))
    expect(single.album).toBeUndefined()
  })

  it('негодный файл в пачке — не отправляется ничего', async () => {
    const { alice, aliceConv } = await connected()
    await expect(alice.sendFiles(aliceConv, [new File([bytes(5)], 'ok.txt'), new File([], 'empty.txt')])).rejects.toThrow(/пустой/)
    expect(await fileMsg(alice, aliceConv)).toBeUndefined()
  })

  it('без связи файл ждёт и уходит после переподключения', async () => {
    const { alice, bob, aliceConv, bobConv } = await connected()
    blobs.failUploads = 1
    await alice.sendFile(aliceConv, new File([bytes(10)], 'a.txt', { type: 'text/plain' }))
    const waiting = await fileMsg(alice, aliceConv)
    expect(waiting).toMatchObject({ status: 'pending', transfer: 'up' })

    alice.transport.stop()
    alice.transport.start()
    await until(async () => (await fileMsg(bob, bobConv))?.file?.state === 'ready')
  })

  it('файла на сервере уже нет — получатель видит это, а не вечную загрузку', async () => {
    const { alice, bob, aliceConv, bobConv } = await connected()
    // Боб не в сети, пока файл лежит на сервере; за это время его стёрли
    bob.transport.stop()
    await alice.sendFile(aliceConv, new File([bytes(10)], 'b.bin'))
    await until(() => blobs.files.size === 1)
    blobs.files.clear()
    bob.transport.start()
    const m = await until(async () => {
      const m = await fileMsg(bob, bobConv)
      return m?.file?.state === 'gone' ? m : null
    })
    expect(m.file?.mime).toBe('application/octet-stream')
  })

  it('слишком большой и пустой файлы не отправляются', async () => {
    const { alice, aliceConv } = await connected()
    const big = new File([new Uint8Array(1)], 'big.iso')
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 })
    await expect(alice.sendFile(aliceConv, big)).rejects.toThrow(/больше 25 МБ/)
    await expect(alice.sendFile(aliceConv, new File([], 'empty.txt'))).rejects.toThrow(/пустой/)
    expect(await fileMsg(alice, aliceConv)).toBeUndefined()
  })

  it('удаление чата стирает и файлы', async () => {
    const { alice, aliceConv } = await connected()
    await alice.sendFile(aliceConv, new File([bytes(5)], 'c.txt'))
    const m = (await fileMsg(alice, aliceConv))!
    await alice.deleteConversation(aliceConv)
    expect(await alice.fileData(m.id)).toBeUndefined()
  })

  it('просит уведомить получателя о сообщениях, но не о квитанциях', async () => {
    const { alice, bob, aliceConv, bobConv } = await connected()
    await alice.sendText(aliceConv, 'привет')
    await until(async () => (await texts(bob, bobConv)).includes('привет'))
    bob.setActiveConversation(bobConv)
    await bob.markRead(bobConv)
    await until(async () => (await alice.messages(aliceConv)).some((x: any) => x.status === 'read'))
    // hello Боба и текст Алисы — с уведомлением; квитанции «доставлено» и «прочитано» — без
    const all = [...sentBy(alice), ...sentBy(bob)].map((s) => s.notify)
    expect(all.filter(Boolean)).toHaveLength(2)
    expect(all.filter((n) => !n).length).toBeGreaterThanOrEqual(2)
  })

  it('сигналы звонка доходят до собеседника и живут на сервере недолго', async () => {
    const { alice, bob, aliceConv, bobConv } = await connected()
    const got: any[] = []
    bob.onCall = (contact: any, c: any) => got.push({ from: contact.id, type: c.type, body: c.body })
    const call = 'A'.repeat(22)
    const mark = relay.sends.length
    await alice.sendCall(aliceConv, { type: 'call-offer', body: { call, sdp: 'v=0' } })
    await alice.sendCall(aliceConv, { type: 'call-end', body: { call, reason: 'timeout' } }, true)
    await alice.sendCall(aliceConv, { type: 'call-end', body: { call: 'не id', reason: 'hangup' } })
    await until(() => got.length === 2)
    await settle()
    expect(got).toEqual([
      { from: bobConv, type: 'call-offer', body: { call, sdp: 'v=0' } },
      { from: bobConv, type: 'call-end', body: { call, reason: 'timeout' } },
    ])
    // Приглашение звонит у получателя и хранится минуту; «не ответили» хранится как обычное сообщение
    // и тоже будит — покажет пропущенный; конец состоявшегося разговора не будит
    expect(sentBy(alice, mark).map((s) => s.notify)).toEqual(['call', 'call-end', false])
    expect(sentBy(alice, mark).map((s) => s.ttl)).toEqual([60, undefined, 60])
    expect(await texts(bob, bobConv)).toEqual([]) // в ленту сигналы не попадают

    await bob.addCallRecord(bobConv, call, false, 1000, { outcome: 'missed' })
    await bob.addCallRecord(bobConv, call, false, 1000, { outcome: 'answered', duration: 5 }) // повтор не меняет запись
    expect(await texts(bob, bobConv)).toEqual(['Пропущенный звонок'])
    expect((await bob.conversations())[0].unread).toBe(1)
  })
})

describe('группы', () => {
  const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff)

  /** Алиса знает Боба и Кэрол; между собой те не знакомы. Возвращает клиентов и id личных чатов Алисы. */
  async function trio() {
    const alice = await client('Алиса')
    const bob = await client('Боб')
    const carol = await client('Кэрол')
    const withBob = await befriend(alice, bob)
    const withCarol = await befriend(alice, carol)
    return { alice, bob, carol, withBob, withCarol }
  }

  /** a приглашает, b принимает. Возвращает id личного чата у a. */
  async function befriend(a: Client, b: Client): Promise<string> {
    const before = new Set((await a.conversations()).map((c: any) => c.id))
    const invite = await a.createInvite()
    await b.acceptInvite(invite.payload)
    return (await until(async () => (await a.conversations()).find((c: any) => !before.has(c.id)))).id
  }

  /** Все участники группы у этого клиента на связи (канал установлен). */
  const linked = async (m: Client, gid: string, n: number) => {
    const g = await m.group(gid)
    return !!g && g.members.length === n && g.members.every((x: any) => x.contactId)
  }

  /** Группа создана, и каждый знаком с каждым. */
  async function grouped() {
    const t = await trio()
    const gid = await t.alice.createGroup('Друзья', [t.withBob, t.withCarol])
    await until(() => linked(t.bob, gid, 2))
    await until(() => linked(t.carol, gid, 2))
    return { ...t, gid }
  }

  const chat = async (m: Client, gid: string) =>
    (await m.messages(gid)).filter((x: any) => x.type !== 'note').map((x: any) => `${x.fromName ?? 'я'}: ${x.text}`)
  const notes = async (m: Client, gid: string) =>
    (await m.messages(gid)).filter((x: any) => x.type === 'note').map((x: any) => x.text)

  it('создатель сводит незнакомых участников, сообщения доходят каждому', async () => {
    const { alice, bob, carol, gid } = await grouped()
    expect((await bob.group(gid))!.title).toBe('Друзья')
    expect((await bob.group(gid))!.members.map((m: any) => m.name).sort()).toEqual(['Алиса', 'Кэрол'])
    expect((await bob.group(gid))!.amAdmin).toBe(false)
    expect((await alice.group(gid))!.amAdmin).toBe(true)

    await bob.sendText(gid, 'всем привет')
    await until(async () => (await chat(alice, gid)).length === 1)
    await until(async () => (await chat(carol, gid)).length === 1)
    await carol.sendText(gid, 'привет, Боб')
    await until(async () => (await chat(bob, gid)).length === 2)
    await until(async () => (await chat(alice, gid)).length === 2)

    expect(await chat(alice, gid)).toEqual(['Боб: всем привет', 'Кэрол: привет, Боб'])
    expect(await chat(bob, gid)).toEqual(['я: всем привет', 'Кэрол: привет, Боб'])
    expect(await chat(carol, gid)).toEqual(['Боб: всем привет', 'я: привет, Боб'])
    // У сообщения в группе один id на всех — на него потом можно будет ссылаться
    const id = (m: Client) => m.messages(gid).then((l: any[]) => l.find((x) => x.text === 'всем привет')!.id)
    expect(await id(alice)).toBe(await id(bob))
    expect(await id(carol)).toBe(await id(bob))
    await until(async () => (await bob.messages(gid)).find((x: any) => x.text === 'всем привет')!.status === 'sent')

    // Знакомство по группе не заводит личный чат: у Боба — только Алиса и группа
    expect((await bob.conversations()).map((c: any) => c.title).sort()).toEqual(['Алиса', 'Друзья'])
    expect(await bob.listInvites()).toEqual([])
    // Сервер открытого текста не видел
    expect(relay.seen.some((p) => p.includes('привет') || p.includes('Друзья'))).toBe(false)
    expect(await notes(bob, gid)).toEqual(['Алиса добавил(а) вас в группу'])
  })

  it('личное сообщение знакомому по группе открывает обычный чат', async () => {
    const { bob, carol, gid } = await grouped()
    const carolAtBob = (await bob.group(gid))!.members.find((m: any) => m.name === 'Кэрол')!.contactId
    // Написать лично можно только из личного чата; его создаёт первое входящее без метки группы
    await (bob as any).sendContent(await bob.contact(carolAtBob!), {
      id: 'B'.repeat(22), ts: Date.now(), type: 'text', body: { text: 'лично' },
    })
    await until(async () => (await carol.conversations()).some((c: any) => c.title === 'Боб'))
    const direct = (await carol.conversations()).find((c: any) => c.title === 'Боб')
    expect(await texts(carol, direct!.id)).toEqual(['лично'])
    expect(await chat(carol, gid)).toEqual([])
  })

  it('своё имя для участника: видно только мне, в личном чате и в группе', async () => {
    const { alice, bob, carol, withBob, gid } = await grouped()
    // Кэрол знакома Бобу только по группе — личного чата нет, но подписать её по-своему можно
    const carolAtBob = (await bob.group(gid))!.members.find((m: any) => m.name === 'Кэрол')!
    await bob.renameContact(carolAtBob.contactId!, '  Кэрол с работы  ')
    const renamed = (await bob.group(gid))!.members.find((m: any) => m.ik === carolAtBob.ik)!
    expect(renamed.name).toBe('Кэрол с работы')
    expect(renamed.selfName).toBe('Кэрол')
    expect((await bob.contactNames()).get(carolAtBob.contactId!)).toBe('Кэрол с работы')

    // Личный чат: меняется и контакт, и заголовок в списке чатов
    await alice.renameContact(withBob, 'Боб (сосед)')
    expect((await alice.conversation(withBob))!.title).toBe('Боб (сосед)')
    expect((await alice.group(gid))!.members.find((m: any) => m.contactId === withBob)!.name).toBe('Боб (сосед)')
    expect(await bob.renameContact(withBob, '   ')).toBeUndefined() // пустое имя — ничего не меняется

    // Остальные видят, как человек назвал себя сам: моё имя никуда не уходит
    await alice.renameGroup(gid, 'Друзья 2')
    await until(async () => (await carol.group(gid))!.title === 'Друзья 2')
    expect((await carol.group(gid))!.members.map((m: any) => m.name).sort()).toEqual(['Алиса', 'Боб'])
    expect(relay.seen.some((p) => p.includes('сосед') || p.includes('с работы'))).toBe(false)
  })

  it('удалённый участник перестаёт получать сообщения и писать', async () => {
    const { alice, bob, carol, gid } = await grouped()
    const carolIk = (await alice.group(gid))!.members.find((m: any) => m.name === 'Кэрол')!.ik
    await alice.removeGroupMember(gid, carolIk)
    await until(async () => (await carol.group(gid))!.left === 'removed')
    await until(async () => (await bob.group(gid))!.members.length === 1)

    await bob.sendText(gid, 'без Кэрол')
    await until(async () => (await chat(alice, gid)).length === 1)
    await settle()
    expect(await chat(carol, gid)).toEqual([])
    await expect(carol.sendText(gid, 'я тут')).rejects.toThrow('больше не участник')
    expect((await notes(carol, gid)).at(-1)).toBe('Вас удалили из группы')
    expect((await notes(bob, gid)).at(-1)).toBe('Кэрол больше не в группе')

    // Знакомство держалось только на группе — канал между Бобом и Кэрол закрыт
    await until(async () => (await (bob as any).db.getAll('contacts')).length === 1)
    await until(async () => (await (carol as any).db.getAll('contacts')).length === 1)

    // Чужое сообщение с меткой группы не принимается, даже если канал с отправителем есть
    const aliceAtCarol = (await (carol as any).db.getAll('contacts'))[0]
    await (carol as any).sendContent(aliceAtCarol, {
      id: 'C'.repeat(22), ts: Date.now(), type: 'text', conv: gid, body: { text: 'подброшено' },
    })
    await settle()
    expect(await chat(alice, gid)).toEqual(['Боб: без Кэрол'])
  })

  it('участника можно добавить позже: он знакомится со всеми и видит только новое', async () => {
    const { alice, bob, carol, gid } = await grouped()
    await bob.sendText(gid, 'до Дэйва')
    await until(async () => (await chat(carol, gid)).length === 1)

    const dave = await client('Дэйв')
    const withDave = await befriend(alice, dave)
    await alice.addGroupMembers(gid, [withDave])
    await until(() => linked(dave, gid, 3))
    await until(() => linked(bob, gid, 3))
    await until(() => linked(carol, gid, 3))

    await carol.sendText(gid, 'привет, Дэйв')
    await until(async () => (await chat(dave, gid)).length === 1)
    expect(await chat(dave, gid)).toEqual(['Кэрол: привет, Дэйв'])
    await dave.sendText(gid, 'всем привет')
    await until(async () => (await chat(bob, gid)).length === 3)
    expect((await chat(bob, gid)).at(-1)).toBe('Дэйв: всем привет')
    expect(await notes(bob, gid)).toContain('Дэйв теперь в группе')
  })

  it('выход из группы; создатель выйти не может', async () => {
    const { alice, bob, carol, gid } = await grouped()
    await bob.leaveGroup(gid)
    expect(await bob.group(gid)).toBeNull()
    await until(async () => (await alice.group(gid))!.members.length === 1)
    await until(async () => (await carol.group(gid))!.members.length === 1)
    expect((await notes(carol, gid)).at(-1)).toBe('Боб вышел(ла) из группы')

    await expect(alice.leaveGroup(gid)).rejects.toThrow('только удалить')
    expect((await alice.group(gid))!.amAdmin).toBe(true)
  })

  it('старый клиент: администратор, уходя, передаёт управление', async () => {
    const { alice, bob, carol, gid, withCarol } = await grouped()
    await bob.leaveGroup(gid)
    await until(async () => (await carol.group(gid))!.members.length === 1)
    // Так выходил администратор до того, как выход создателю запретили
    const carolIk = (await alice.group(gid))!.members.find((m: any) => m.name === 'Кэрол')!.ik
    await (alice as any).sendContent(await alice.contact(withCarol), {
      id: 'H'.repeat(22), ts: Date.now(), type: 'group-leave', conv: gid, body: { admin: carolIk },
    })
    await until(async () => (await carol.group(gid))!.amAdmin)
    expect((await carol.group(gid))!.members).toEqual([])
    expect((await notes(carol, gid)).at(-1)).toBe('Теперь группой управляете вы')
    // Новый администратор может переименовать группу
    await carol.renameGroup(gid, 'Одна')
    expect((await carol.group(gid))!.title).toBe('Одна')
  })

  it('создатель удаляет группу — она стирается у всех вместе с файлами', async () => {
    const { alice, bob, carol, gid } = await grouped()
    await alice.sendFile(gid, new File([bytes(500)], 'фото.jpg', { type: 'image/jpeg' }))
    await bob.sendText(gid, 'привет')
    await until(async () => (await bob.messages(gid)).some((x: any) => x.file?.state === 'ready'))
    await until(async () => (await chat(carol, gid)).length === 2)

    // Участник удалить группу не может: ни через функцию, ни подделав сообщение
    await expect(bob.deleteGroup(gid)).rejects.toThrow('только её создатель')
    const bobAtCarol = (await carol.group(gid))!.members.find((m: any) => m.name === 'Боб')!
    await (carol as any).sendContent(await carol.contact(bobAtCarol.contactId!), {
      id: 'J'.repeat(22), ts: Date.now(), type: 'group-delete', conv: gid, body: {},
    })
    await settle()
    expect(await bob.group(gid)).not.toBeNull()

    await alice.deleteGroup(gid)
    expect(await alice.group(gid)).toBeNull()
    await until(async () => (await bob.group(gid)) === null)
    await until(async () => (await carol.group(gid)) === null)
    expect(await bob.messages(gid)).toEqual([])
    expect(await (bob as any).db.getAll('files')).toEqual([])
    expect((await bob.conversations()).map((c: any) => c.title)).toEqual(['Алиса'])
    // Знакомство Боба и Кэрол держалось только на группе — канал закрыт, личный чат с Алисой жив
    await until(async () => (await (bob as any).db.getAll('contacts')).length === 1)
    await until(async () => (await (carol as any).db.getAll('contacts')).length === 1)
    expect((await (bob as any).db.getAll('contacts'))[0].gone).toBeFalsy()
  })

  it('переименование доходит до участников, не-администратор менять группу не может', async () => {
    const { alice, bob, carol, gid } = await grouped()
    await alice.renameGroup(gid, 'Работа')
    await until(async () => (await bob.group(gid))!.title === 'Работа')
    await until(async () => (await carol.group(gid))!.title === 'Работа')
    expect((await bob.conversations()).some((c: any) => c.title === 'Работа')).toBe(true)
    await expect(bob.renameGroup(gid, 'Захват')).rejects.toThrow('только её администратор')
    const aliceIk = (await bob.group(gid))!.members.find((m: any) => m.admin)!.ik
    await expect(bob.removeGroupMember(gid, aliceIk)).rejects.toThrow('только её администратор')
  })

  it('чужое состояние группы не принимается', async () => {
    const { alice, bob, carol, gid } = await grouped()
    // Кэрол (не администратор) пытается разослать своё состояние: себя — администратором, без Алисы
    const bobAtCarol = (await carol.group(gid))!.members.find((m: any) => m.name === 'Боб')!
    const me = (carol as any).myIk()
    await (carol as any).sendContent(await carol.contact(bobAtCarol.contactId!), {
      id: 'D'.repeat(22), ts: Date.now(), type: 'group-state', conv: gid,
      body: { name: 'Захват', admin: me, rev: 99, members: [{ ik: me, name: 'Кэрол' }, { ik: bobAtCarol.ik, name: 'Боб' }] },
    })
    await settle()
    const g = (await bob.group(gid))!
    expect(g.title).toBe('Друзья')
    expect(g.members.map((m: any) => m.name).sort()).toEqual(['Алиса', 'Кэрол'])
    expect((await alice.group(gid))!.amAdmin).toBe(true)
  })

  it('файл в группе загружается один раз и доходит каждому', async () => {
    const { alice, bob, carol, gid } = await grouped()
    const data = bytes(3000)
    await alice.sendFile(gid, new File([data], 'план.pdf', { type: 'application/pdf' }), 'смотрите')
    const got = async (m: Client) => {
      const msg = (await m.messages(gid)).find((x: any) => x.type === 'file')
      return msg?.file?.state === 'ready' ? msg : null
    }
    const atBob = await until(() => got(bob))
    const atCarol = await until(() => got(carol))
    expect(new Uint8Array((await bob.fileData(atBob.id))!)).toEqual(data)
    expect(new Uint8Array((await carol.fileData(atCarol.id))!)).toEqual(data)
    expect(atBob.text).toBe('смотрите')
    expect(atBob.fromName).toBe('Алиса')
    // Оба скачали — на сервере файла больше нет
    await until(() => blobs.files.size === 0)
  })

  it('удаление личного чата с участником общей группы группу не ломает', async () => {
    const { alice, bob, gid, withBob } = await grouped()
    await alice.deleteConversation(withBob)
    expect((await alice.conversations()).map((c: any) => c.title).sort()).toEqual(['Друзья', 'Кэрол'])
    await alice.sendText(gid, 'я всё ещё тут')
    await until(async () => (await chat(bob, gid)).length === 1)
    await bob.sendText(gid, 'вижу')
    await until(async () => (await chat(alice, gid)).length === 2)
    // Боб не получил «чат закрыт»: его личный чат с Алисой жив
    expect((await (bob as any).db.getAll('contacts')).every((c: any) => !c.gone)).toBe(true)
  })

  it('сигнал звонка с меткой группы пока не обрабатывается', async () => {
    const { alice, bob, gid, withBob } = await grouped()
    const got: any[] = []
    bob.onCall = (_contact: any, c: any) => got.push(c.type)
    const to = await alice.contact(withBob)
    await (alice as any).sendContent(to, {
      id: 'E'.repeat(22), ts: Date.now(), type: 'call-offer', conv: gid, body: { call: 'F'.repeat(22), sdp: 'v=0' },
    })
    await alice.sendCall(withBob, { type: 'call-offer', body: { call: 'G'.repeat(22), sdp: 'v=0' } })
    await until(() => got.length === 1)
    await settle()
    expect(got).toEqual(['call-offer']) // дошёл только личный звонок
  })
})
