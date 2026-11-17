/**
 * Форматы сообщений (подробно — docs/protocol.md).
 *
 * Слой 1, видит сервер:     send {id, to:[mailbox], payload}
 * Слой 2, payload (строка): {"v":1, "h":{dh,pn,n}, "ct":..., "pk"?:{ik,ek,e}}
 * Слой 3, внутри ct:        Content — JSON, дополненный до кратного 256 байт
 *
 * Новые возможности добавляются новыми значениями Content.type.
 * Неизвестный type клиент молча игнорирует.
 */
import { type Bytes, b64d, b64e, fromUtf8, pad, unpad, utf8 } from '../crypto/bytes'
import type { PreKeyHeader } from '../crypto/handshake'
import type { Header } from '../crypto/ratchet'

export const PROTOCOL_VERSION = 1

export interface WirePayload {
  v: number
  h: { dh: string; pn: number; n: number }
  ct: string
  pk?: PreKeyHeader
}

export function encodePayload(header: Header, ct: Bytes, pk?: PreKeyHeader): string {
  const p: WirePayload = { v: PROTOCOL_VERSION, h: { dh: b64e(header.dh), pn: header.pn, n: header.n }, ct: b64e(ct) }
  if (pk) p.pk = pk
  return JSON.stringify(p)
}

export function decodePayload(s: string): { header: Header; ct: Bytes; pk?: PreKeyHeader } {
  const p = JSON.parse(s) as WirePayload
  if (p.v !== PROTOCOL_VERSION) throw new Error(`Неподдерживаемая версия протокола: ${p.v}`)
  const header: Header = { dh: b64d(p.h.dh), pn: p.h.pn | 0, n: p.h.n | 0 }
  if (header.dh.length !== 32) throw new Error('bad header')
  return { header, ct: b64d(p.ct), pk: p.pk }
}

// --- Слой 3: содержимое -------------------------------------------------

interface Base {
  /** Уникальный id (совпадает с id конверта на сервере) */
  id: string
  /** Время отправки по часам отправителя, мс */
  ts: number
  /** Id беседы для групп. У личных чатов отсутствует: беседа определяется по ящику. */
  conv?: string
}

export interface TextContent extends Base {
  type: 'text'
  body: { text: string }
}

/**
 * Файл. Сам он лежит на сервере зашифрованным (docs/protocol.md, «Файлы»), а здесь — как его
 * скачать и расшифровать. Ключ один на файл, поэтому в группе один и тот же файл можно
 * загрузить один раз и разослать всем.
 */
export interface FileContent extends Base {
  type: 'file'
  body: {
    /** id на сервере, 16 байт base64url */
    blob: string
    /** ключ AES-256-GCM, 32 байта base64url */
    key: string
    /** размер исходного файла в байтах */
    size: number
    name: string
    mime: string
    /** подпись к файлу; нет поля — файл без подписи */
    caption?: string
    /** общий id файлов одной пачки (16 байт base64url): получатель собирает их в альбом */
    album?: string
  }
}

/** Первое сообщение принявшего приглашение: куда ему писать и как его зовут. */
export interface HelloContent extends Base {
  type: 'hello'
  body: { name: string; mailbox: string; sigPub: string }
}

export interface ReceiptContent extends Base {
  type: 'receipt'
  body: { status: 'delivered' | 'read'; ids: string[] }
}

/** Собеседник удалил чат или всю переписку: его ящик больше не существует. */
export interface GoodbyeContent extends Base {
  type: 'goodbye'
  body: Record<string, never>
}

/**
 * Сигналы звонка (docs/protocol.md, «Звонки»). Идут тем же шифрованным каналом, что и сообщения,
 * поэтому сервер не видит ни самого факта звонка, ни адресов, а отпечаток ключа медиапотока
 * внутри sdp заверен ключами собеседников.
 */
export type CallEndReason = 'hangup' | 'decline' | 'busy' | 'timeout' | 'failed'

export interface CallOfferContent extends Base {
  type: 'call-offer'
  /** video — звонящий включил камеру (видеозвонок) */
  body: { call: string; sdp: string; video?: boolean }
}

export interface CallAnswerContent extends Base {
  type: 'call-answer'
  /** video — ответивший включил камеру */
  body: { call: string; sdp: string; video?: boolean }
}

/** Собеседник включил или выключил камеру посреди разговора. */
export interface CallMediaContent extends Base {
  type: 'call-media'
  body: { call: string; video: boolean }
}

/** Адреса для соединения, найденные уже после отправки offer/answer. */
export interface CallIceContent extends Base {
  type: 'call-ice'
  body: { call: string; candidates: RTCIceCandidateInit[] }
}

export interface CallEndContent extends Base {
  type: 'call-end'
  body: { call: string; reason: CallEndReason }
}

export type CallContent =
  | CallOfferContent
  | CallAnswerContent
  | CallIceContent
  | CallMediaContent
  | CallEndContent

export type Content = TextContent | FileContent | HelloContent | ReceiptContent | GoodbyeContent | CallContent

export function encodeContent(c: Content): Bytes {
  return pad(utf8(JSON.stringify(c)))
}

export function decodeContent(b: Bytes): Content | null {
  const c = JSON.parse(fromUtf8(unpad(b)))
  if (!c || typeof c.id !== 'string' || typeof c.type !== 'string' || typeof c.ts !== 'number') {
    throw new Error('bad content')
  }
  return KNOWN_TYPES.has(c.type) ? (c as Content) : null
}

const KNOWN_TYPES = new Set([
  'text', 'file', 'hello', 'receipt', 'goodbye', 'call-offer', 'call-answer', 'call-ice', 'call-media', 'call-end',
])
