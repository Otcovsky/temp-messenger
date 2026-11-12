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

export type Content = TextContent | HelloContent | ReceiptContent | GoodbyeContent

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

const KNOWN_TYPES = new Set(['text', 'hello', 'receipt', 'goodbye'])
