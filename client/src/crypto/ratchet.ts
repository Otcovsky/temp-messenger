/**
 * Double Ratchet по спецификации Signal (https://signal.org/docs/specifications/doubleratchet/).
 *
 * KDF_RK: HKDF-SHA256(salt = RK, ikm = DH-выход, info = "TM-Ratchet") → 64 байта = RK' || CK
 * KDF_CK: MK = HMAC(CK, 0x01), CK' = HMAC(CK, 0x02)
 * Шифр:   HKDF(MK, info = "TM-MsgKeys") → 32 байта ключа AES-256-GCM || 12 байт IV
 *         AD  = session.ad || dh || pn || n
 *
 * Все функции чистые: возвращают новое состояние и не меняют входное.
 * Если расшифровка не удалась, вызывающий код просто не сохраняет результат.
 */
import { type Bytes, b64e, concat, equal, u32be, utf8 } from './bytes'
import { type KeyPair, aesGcmDecrypt, aesGcmEncrypt, dh, generateDH, hkdf, hmac } from './primitives'

const MAX_SKIP = 1000 // сколько пропущенных ключей можно вывести за раз
const MAX_STORED_SKIPPED = 2000 // сколько хранить всего
const ZERO32 = new Uint8Array(32)
const INFO_RK = utf8('TM-Ratchet')
const INFO_MK = utf8('TM-MsgKeys')

export interface RatchetState {
  dhs: KeyPair
  dhr: Bytes | null
  rk: Bytes
  cks: Bytes | null
  ckr: Bytes | null
  ns: number
  nr: number
  pn: number
  /** Ключи пропущенных сообщений: "<dh b64>:<n>" → MK. Порядок вставки = возраст. */
  skipped: Record<string, Bytes>
  /** Associated data: ключи личности обеих сторон, инициатор первым. */
  ad: Bytes
}

export interface Header {
  dh: Bytes
  pn: number
  n: number
}

async function kdfRK(rk: Bytes, dhOut: Bytes): Promise<[Bytes, Bytes]> {
  const out = await hkdf(dhOut, rk, INFO_RK, 64)
  return [out.slice(0, 32), out.slice(32)]
}

async function kdfCK(ck: Bytes): Promise<[Bytes, Bytes]> {
  const [mk, next] = await Promise.all([hmac(ck, new Uint8Array([1])), hmac(ck, new Uint8Array([2]))])
  return [next, mk]
}

async function messageKeys(mk: Bytes): Promise<[Bytes, Bytes]> {
  const out = await hkdf(mk, ZERO32, INFO_MK, 44)
  return [out.slice(0, 32), out.slice(32)]
}

export function encodeHeader(h: Header): Bytes {
  return concat(h.dh, u32be(h.pn), u32be(h.n))
}

function clone(s: RatchetState): RatchetState {
  return { ...s, skipped: { ...s.skipped } }
}

const skipKey = (dhPub: Bytes, n: number) => `${b64e(dhPub)}:${n}`

/** Сторона, которая отправляет первое сообщение (принявший приглашение). */
export async function initSender(sk: Bytes, theirRatchetPub: Bytes, ad: Bytes): Promise<RatchetState> {
  const dhs = await generateDH()
  const [rk, cks] = await kdfRK(sk, await dh(dhs.priv, theirRatchetPub))
  return { dhs, dhr: theirRatchetPub, rk, cks, ckr: null, ns: 0, nr: 0, pn: 0, skipped: {}, ad }
}

/** Сторона, которая ждёт первое сообщение (создавший приглашение). */
export function initReceiver(sk: Bytes, ownRatchet: KeyPair, ad: Bytes): RatchetState {
  return { dhs: ownRatchet, dhr: null, rk: sk, cks: null, ckr: null, ns: 0, nr: 0, pn: 0, skipped: {}, ad }
}

export async function ratchetEncrypt(
  state: RatchetState,
  plaintext: Bytes,
): Promise<{ state: RatchetState; header: Header; ciphertext: Bytes }> {
  if (!state.cks) throw new Error('Цепочка отправки ещё не инициализирована')
  const s = clone(state)
  const [cks, mk] = await kdfCK(s.cks!)
  s.cks = cks
  const header: Header = { dh: s.dhs.pub, pn: s.pn, n: s.ns }
  s.ns += 1
  const [key, iv] = await messageKeys(mk)
  const ciphertext = await aesGcmEncrypt(key, iv, plaintext, concat(s.ad, encodeHeader(header)))
  return { state: s, header, ciphertext }
}

export async function ratchetDecrypt(
  state: RatchetState,
  header: Header,
  ciphertext: Bytes,
): Promise<{ state: RatchetState; plaintext: Bytes }> {
  const s = clone(state)
  const ad = concat(s.ad, encodeHeader(header))

  const sk = skipKey(header.dh, header.n)
  const skippedMk = s.skipped[sk]
  if (skippedMk) {
    delete s.skipped[sk]
    const [key, iv] = await messageKeys(skippedMk)
    return { state: s, plaintext: await aesGcmDecrypt(key, iv, ciphertext, ad) }
  }

  if (!s.dhr || !equal(header.dh, s.dhr)) {
    await skipMessageKeys(s, header.pn)
    // DH-шаг храповика
    s.pn = s.ns
    s.ns = 0
    s.nr = 0
    s.dhr = header.dh
    ;[s.rk, s.ckr] = await kdfRK(s.rk, await dh(s.dhs.priv, s.dhr))
    s.dhs = await generateDH()
    ;[s.rk, s.cks] = await kdfRK(s.rk, await dh(s.dhs.priv, s.dhr))
  }

  await skipMessageKeys(s, header.n)
  const [ckr, mk] = await kdfCK(s.ckr!)
  s.ckr = ckr
  s.nr += 1
  const [key, iv] = await messageKeys(mk)
  return { state: s, plaintext: await aesGcmDecrypt(key, iv, ciphertext, ad) }
}

async function skipMessageKeys(s: RatchetState, until: number): Promise<void> {
  if (!s.ckr || !s.dhr) return
  if (until - s.nr > MAX_SKIP) throw new Error('Слишком много пропущенных сообщений')
  while (s.nr < until) {
    const [ckr, mk] = await kdfCK(s.ckr)
    s.ckr = ckr
    s.skipped[skipKey(s.dhr, s.nr)] = mk
    s.nr += 1
  }
  const keys = Object.keys(s.skipped)
  for (let i = 0; i < keys.length - MAX_STORED_SKIPPED; i++) delete s.skipped[keys[i]]
}
