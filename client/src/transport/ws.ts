/**
 * WebSocket-соединение с ретранслятором: авторизация по ключу, пинги,
 * переподключение с экспоненциальной задержкой.
 */
import { b64d, b64e, concat, utf8 } from '../crypto/bytes'
import { type KeyPair, sign } from '../crypto/primitives'

export type ConnStatus = 'connecting' | 'online' | 'offline'

/** Состояние ящика-приглашения на сервере: ждёт ответа / уже принято / отозвано или удалено. */
export type InviteState = 'open' | 'used' | 'none'

export type ServerFrame =
  | { t: 'challenge'; nonce: string }
  | { t: 'ready' }
  | { t: 'registered'; mailbox: string; created: boolean }
  | { t: 'unregistered'; mailbox: string }
  | { t: 'sent'; id: string; failed: { to: string; reason: string }[] }
  | { t: 'msg'; id: string; mailbox: string; payload: string; ts: number }
  | { t: 'probe'; mailbox: string; state: InviteState }
  | { t: 'pong' }
  | { t: 'error'; code: string; ref?: string }

export interface TransportHandlers {
  onReady(): void
  onFrame(f: ServerFrame): void
  onStatus(s: ConnStatus): void
}

const AUTH_CONTEXT = utf8('tm-auth-v1:')
const PING_MS = 25_000

export function defaultServerUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

export class Transport {
  private ws: WebSocket | null = null
  private ready = false
  private stopped = false
  private attempt = 0
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  status: ConnStatus = 'offline'

  constructor(
    private url: string,
    private authKey: KeyPair,
    private h: TransportHandlers,
  ) {}

  start(): void {
    this.stopped = false
    this.connect()
    window.addEventListener('online', this.kick)
    document.addEventListener('visibilitychange', this.kick)
  }

  stop(): void {
    this.stopped = true
    window.removeEventListener('online', this.kick)
    document.removeEventListener('visibilitychange', this.kick)
    clearTimeout(this.retryTimer)
    this.ws?.close()
  }

  get isReady(): boolean {
    return this.ready
  }

  send(frame: object): boolean {
    if (!this.ready || !this.ws) return false
    this.ws.send(JSON.stringify(frame))
    return true
  }

  /** Сеть появилась или вкладка снова видима — переподключиться сразу, без ожидания. */
  private kick = () => {
    if (!this.stopped && !this.ws && document.visibilityState === 'visible') {
      clearTimeout(this.retryTimer)
      this.attempt = 0
      this.connect()
    }
  }

  private setStatus(s: ConnStatus) {
    this.status = s
    this.h.onStatus(s)
  }

  private connect() {
    if (this.stopped || this.ws) return
    this.setStatus('connecting')
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.onmessage = async (ev) => {
      let f: ServerFrame
      try {
        f = JSON.parse(ev.data)
      } catch {
        return
      }
      if (f.t === 'challenge') {
        const sig = await sign(this.authKey.priv, concat(AUTH_CONTEXT, b64d(f.nonce)))
        ws.send(JSON.stringify({ t: 'auth', pub: b64e(this.authKey.pub), sig: b64e(sig) }))
      } else if (f.t === 'ready') {
        this.ready = true
        this.attempt = 0
        this.setStatus('online')
        this.pingTimer = setInterval(() => this.send({ t: 'ping' }), PING_MS)
        this.h.onReady()
      } else {
        this.h.onFrame(f)
      }
    }

    ws.onclose = () => {
      clearInterval(this.pingTimer)
      this.ws = null
      this.ready = false
      this.setStatus('offline')
      if (this.stopped) return
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5)
      this.attempt++
      this.retryTimer = setTimeout(() => this.connect(), delay)
    }
    ws.onerror = () => ws.close()
  }
}
