/**
 * Сквозная проверка ядра: два клиента с отдельными базами (fake-indexeddb) общаются
 * через ретранслятор в памяти, который ведёт себя как сервер из server/app/main.py.
 */
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { relay, FakeTransport } = vi.hoisted(() => {
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

    reset() {
      this.boxes.clear()
      this.seen = []
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

  return { relay, FakeTransport }
})

vi.mock('../transport/ws', () => ({ Transport: FakeTransport, defaultServerUrl: () => 'ws://test/ws' }))

import { Messenger } from './messenger'

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
