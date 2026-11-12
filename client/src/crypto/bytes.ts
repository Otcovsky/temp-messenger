/** Байтовые утилиты. Bytes — Uint8Array поверх обычного ArrayBuffer (так его принимает Web Crypto). */
export type Bytes = Uint8Array<ArrayBuffer>

export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n))
}

/** Случайный идентификатор: 16 байт в base64url (22 символа). Так же выглядят ID ящиков. */
export function randomId(): string {
  return b64e(randomBytes(16))
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

/** Лексикографическое сравнение, для детерминированного порядка ключей. */
export function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

export function u32be(n: number): Bytes {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n)
  return b
}

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })
export const utf8 = (s: string): Bytes => enc.encode(s) as Bytes
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b)

export function b64e(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64d(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url')
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Дополнение до кратного block байт (ISO/IEC 7816-4: 0x80, затем нули), чтобы скрыть длину текста. */
export function pad(b: Uint8Array, block = 256): Bytes {
  const len = Math.ceil((b.length + 1) / block) * block
  const out = new Uint8Array(len)
  out.set(b)
  out[b.length] = 0x80
  return out
}

export function unpad(b: Uint8Array): Bytes {
  let i = b.length - 1
  while (i >= 0 && b[i] === 0) i--
  if (i < 0 || b[i] !== 0x80) throw new Error('bad padding')
  return b.slice(0, i) as Bytes
}
