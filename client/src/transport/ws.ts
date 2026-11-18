/**
 * WebSocket-соединение с ретранслятором: авторизация по ключу, пинги,
 * переподключение с экспоненциальной задержкой.
 */
import { b64d, b64e, concat, utf8 } from '../crypto/bytes'
import { type KeyPair, sign } from '../crypto/primitives'
import { serverOrigin } from '../platform'

export type ConnStatus = 'connecting' | 'online' | 'offline'

/** Состояние ящика-приглашения на сервере: ждёт ответа / уже принято / отозвано или удалено. */
export type InviteState = 'open' | 'used' | 'none'

export type ServerFrame =
  | { t: 'challenge'; nonce: string }
  | { t: 'ready'; push?: string; fcm?: boolean }
  | { t: 'registered'; mailbox: string; created: boolean }
  | { t: 'unregistered'; mailbox: string }
  | { t: 'sent'; id: string; failed: { to: string; reason: string }[] }
  | { t: 'msg'; id: string; mailbox: string; payload: string; ts: number }
  | { t: 'probe'; mailbox: string; state: InviteState }
  | { t: 'pong' }
  | { t: 'push-sub'; ok: boolean }
  | { t: 'push-unsub'; ok: boolean }
  | { t: 'push-test'; status: number }
  | { t: 'ice'; servers: RTCIceServer[]; ttl: number }
  | { t: 'error'; code: string; ref?: string }

export interface TransportHandlers {
  onReady(): void
  onFrame(f: ServerFrame): void
  onStatus(s: ConnStatus): void
}

const AUTH_CONTEXT = utf8('tm-auth-v1:')
const PING_MS = 25_000
/** Сколько ждать ответа на проверочный пинг, прежде чем считать соединение мёртвым */
const ALIVE_TIMEOUT_MS = 5_000
/**
 * То же при возвращении в приложение: соединение, пережившее сон телефона, обычно мертво, а человек
 * вернулся, чтобы писать. Живой сервер отвечает за доли секунды, так что ждём недолго.
 */
const WAKE_TIMEOUT_MS = 1_500

export function defaultServerUrl(): string {
  return `${serverOrigin().replace(/^http/, 'ws')}/ws`
}

export class Transport {
  private ws: WebSocket | null = null
  private ready = false
  private stopped = false
  private attempt = 0
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private aliveTimer: ReturnType<typeof setTimeout> | undefined
  /** Когда от сервера последний раз что-то приходило */
  private lastFrameAt = 0
  status: ConnStatus = 'offline'
  /** Ключ VAPID сервера из кадра ready; null — сервер не умеет слать пуш-уведомления */
  pushKey: string | null = null
  /** Сервер умеет слать пуши Android-приложению через Firebase (кадр ready) */
  fcm = false

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
    clearTimeout(this.aliveTimer)
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

  /**
   * Сеть появилась или вкладка снова видима — переподключиться сразу, без ожидания.
   * Если соединение формально открыто, проверяем, живо ли оно: iOS, усыпив приложение
   * в фоне, оставляет «зомби»-сокет, в который send() уходит в никуда, а close приходит
   * лишь через минуты.
   */
  private kick = () => {
    if (this.stopped || document.visibilityState !== 'visible') return
    if (!this.ws) {
      clearTimeout(this.retryTimer)
      this.attempt = 0
      this.connect()
    } else if (this.ready) {
      this.checkAlive(WAKE_TIMEOUT_MS)
    }
  }

  /** Отправить пинг и, если сервер не ответит, переподключиться. */
  checkAlive(timeout = ALIVE_TIMEOUT_MS): void {
    if (!this.ws || !this.ready) return
    if (this.aliveTimer) {
      if (timeout >= ALIVE_TIMEOUT_MS) return
      clearTimeout(this.aliveTimer) // идёт обычная проверка — заменяем её срочной
      this.aliveTimer = undefined
    }
    const since = Date.now()
    this.send({ t: 'ping' })
    this.aliveTimer = setTimeout(() => {
      this.aliveTimer = undefined
      if (this.lastFrameAt < since) this.drop()
    }, timeout)
  }

  /** Бросить текущее соединение, не дожидаясь close от браузера, и сразу открыть новое. */
  private drop() {
    const ws = this.ws
    if (!ws) return
    ws.onmessage = ws.onclose = ws.onerror = null
    try {
      ws.close()
    } catch {
      /* уже закрыт */
    }
    this.closed(0)
  }

  private closed(delay: number) {
    clearInterval(this.pingTimer)
    clearTimeout(this.aliveTimer)
    this.aliveTimer = undefined
    this.ws = null
    this.ready = false
    this.setStatus('offline')
    if (this.stopped) return
    this.retryTimer = setTimeout(() => this.connect(), delay)
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
      this.lastFrameAt = Date.now()
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
        this.pushKey = typeof f.push === 'string' ? f.push : null
        this.fcm = f.fcm === true
        this.attempt = 0
        this.setStatus('online')
        this.pingTimer = setInterval(() => this.checkAlive(), PING_MS)
        this.h.onReady()
      } else {
        this.h.onFrame(f)
      }
    }

    ws.onclose = () => {
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5)
      this.attempt++
      this.closed(delay)
    }
    ws.onerror = () => ws.close()
  }
}
