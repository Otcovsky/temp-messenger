/**
 * Обёртки над Web Crypto: X25519, Ed25519, HKDF-SHA256, HMAC-SHA256, AES-256-GCM.
 * Закрытые ключи создаются неизвлекаемыми (extractable: false): их можно хранить
 * в IndexedDB и использовать, но нельзя выгрузить даже из JS страницы.
 *
 * X25519/Ed25519 появились в Web Crypto недавно, и часть браузеров (особенно
 * сборки Chromium от производителей телефонов) их до сих пор не поддерживает.
 * Тогда используется @noble/curves — проверенная аудитом реализация на JS.
 * Закрытый ключ в этом случае хранится как сырые 32 байта: защита от выгрузки
 * из JS теряется, но алгоритм и формат ключей те же, так что собеседники
 * с разными браузерами полностью совместимы.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { type Bytes, concat } from './bytes'

const subtle = globalThis.crypto.subtle
const X25519 = { name: 'X25519' } as const
const ED25519 = { name: 'Ed25519' } as const

/** Закрытый ключ: неизвлекаемый CryptoKey (Web Crypto) или сырые байты (запасная реализация). */
export type PrivateKey = CryptoKey | Bytes

export interface KeyPair {
  priv: PrivateKey
  pub: Bytes // сырые 32 байта
}

const isRaw = (k: PrivateKey): k is Bytes => k instanceof Uint8Array
const u8 = (b: Uint8Array): Bytes => new Uint8Array(b) as Bytes

/** Есть ли нативная поддержка в Web Crypto. Определяется один раз в detectNative(). */
const native = { x25519: false, ed25519: false }
let detected: Promise<void> | null = null

/**
 * Сохранить ключ в IndexedDB и прочитать обратно. Создать ключ браузер может, а сохранить —
 * не всегда (structured clone для CryptoKey X25519/Ed25519 поддержан не везде), и тогда
 * запись приглашения или сессии падала бы уже посреди работы.
 */
export const KEY_PROBE_DB = 'tm-key-probe'

async function roundTrip(key: CryptoKey): Promise<CryptoKey> {
  if (typeof indexedDB === 'undefined') return key // тесты в Node
  const req = (r: IDBRequest) =>
    new Promise<unknown>((resolve, reject) => {
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
  const open = indexedDB.open(KEY_PROBE_DB, 1)
  open.onupgradeneeded = () => open.result.createObjectStore('k')
  const db = (await req(open)) as IDBDatabase
  try {
    await req(db.transaction('k', 'readwrite').objectStore('k').put(key, 'k'))
    const back = (await req(db.transaction('k').objectStore('k').get('k'))) as CryptoKey
    if (!(back instanceof CryptoKey)) throw new Error('ключ не сохранился')
    return back
  } finally {
    db.close()
    // Проба одноразовая: не оставляем базу с тестовым ключом. Следующее open() браузер
    // поставит в очередь после удаления, так что ждать его не нужно.
    indexedDB.deleteDatabase(KEY_PROBE_DB)
  }
}

function detectNative(): Promise<void> {
  detected ??= (async () => {
    try {
      const a = (await subtle.generateKey(X25519, false, ['deriveBits'])) as CryptoKeyPair
      const b = (await subtle.generateKey(X25519, true, ['deriveBits'])) as CryptoKeyPair
      const pub = await subtle.importKey('raw', await subtle.exportKey('raw', b.publicKey), X25519, true, [])
      await subtle.deriveBits({ name: 'X25519', public: pub }, await roundTrip(a.privateKey), 256)
      native.x25519 = true
    } catch (e) {
      console.info('X25519 из Web Crypto недоступен, используется JS-реализация', e)
    }
    try {
      const kp = (await subtle.generateKey(ED25519, false, ['sign', 'verify'])) as CryptoKeyPair
      const data = new Uint8Array(1)
      const sig = await subtle.sign(ED25519, await roundTrip(kp.privateKey), data)
      const pub = await subtle.importKey('raw', await subtle.exportKey('raw', kp.publicKey), ED25519, true, ['verify'])
      if (!(await subtle.verify(ED25519, pub, sig, data))) throw new Error()
      native.ed25519 = true
    } catch (e) {
      console.info('Ed25519 из Web Crypto недоступен, используется JS-реализация', e)
    }
  })()
  return detected
}

/** Для тестов: принудительно включить запасную реализацию. */
export function _forceFallback(on: boolean) {
  native.x25519 = native.ed25519 = false
  detected = on ? Promise.resolve() : null
}

/** Используется ли запасная JS-реализация хотя бы для одного алгоритма. */
export async function usesFallback(): Promise<boolean> {
  await detectNative()
  return !native.x25519 || !native.ed25519
}

async function exportRaw(key: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await subtle.exportKey('raw', key))
}

export async function generateDH(): Promise<KeyPair> {
  await detectNative()
  if (!native.x25519) {
    const priv = u8(x25519.utils.randomSecretKey())
    return { priv, pub: u8(x25519.getPublicKey(priv)) }
  }
  const kp = (await subtle.generateKey(X25519, false, ['deriveBits'])) as CryptoKeyPair
  return { priv: kp.privateKey, pub: await exportRaw(kp.publicKey) }
}

export async function dh(priv: PrivateKey, theirPub: Bytes): Promise<Bytes> {
  if (isRaw(priv)) return u8(x25519.getSharedSecret(priv, theirPub))
  const pub = await subtle.importKey('raw', theirPub, X25519, true, [])
  const bits = await subtle.deriveBits({ name: 'X25519', public: pub }, priv, 256)
  return new Uint8Array(bits)
}

export async function generateSigning(): Promise<KeyPair> {
  await detectNative()
  if (!native.ed25519) {
    const priv = u8(ed25519.utils.randomSecretKey())
    return { priv, pub: u8(ed25519.getPublicKey(priv)) }
  }
  const kp = (await subtle.generateKey(ED25519, false, ['sign', 'verify'])) as CryptoKeyPair
  return { priv: kp.privateKey, pub: await exportRaw(kp.publicKey) }
}

export async function sign(priv: PrivateKey, data: Bytes): Promise<Bytes> {
  if (isRaw(priv)) return u8(ed25519.sign(data, priv))
  return new Uint8Array(await subtle.sign(ED25519, priv, data))
}

export async function verify(pub: Bytes, sig: Bytes, data: Bytes): Promise<boolean> {
  await detectNative()
  if (!native.ed25519) {
    try {
      return ed25519.verify(sig, data, pub)
    } catch {
      return false
    }
  }
  const key = await subtle.importKey('raw', pub, ED25519, true, ['verify'])
  return subtle.verify(ED25519, key, sig, data)
}

export async function hkdf(ikm: Bytes, salt: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8)
  return new Uint8Array(bits)
}

export async function hmac(keyBytes: Bytes, data: Bytes): Promise<Bytes> {
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await subtle.sign('HMAC', key, data))
}

export async function sha256(...parts: Bytes[]): Promise<Bytes> {
  return new Uint8Array(await subtle.digest('SHA-256', concat(...parts)))
}

export async function aesGcmEncrypt(key: Bytes, iv: Bytes, pt: Bytes, ad: Bytes): Promise<Bytes> {
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, k, pt))
}

export async function aesGcmDecrypt(key: Bytes, iv: Bytes, ct: Bytes, ad: Bytes): Promise<Bytes> {
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt'])
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: ad }, k, ct))
}

/** Проверка, что браузер умеет всё нужное. X25519/Ed25519 при необходимости заменяются JS-реализацией. */
export async function checkSupport(): Promise<string | null> {
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) {
    return 'Нужен HTTPS (или localhost): Web Crypto недоступен.'
  }
  try {
    const a = await generateDH()
    const b = await generateDH()
    await dh(a.priv, b.pub)
    const s = await generateSigning()
    const data = new Uint8Array(1)
    if (!(await verify(s.pub, await sign(s.priv, data), data))) throw new Error('verify')
    await hkdf(data, data, data, 32)
    await aesGcmEncrypt(new Uint8Array(32), new Uint8Array(12), data, data)
  } catch (e) {
    console.error('Проверка криптографии не прошла', e)
    return 'Браузер не поддерживает нужную криптографию (Web Crypto). Попробуйте Chrome, Firefox или Safari.'
  }
  if (!('indexedDB' in globalThis)) return 'Браузер не поддерживает IndexedDB.'
  return null
}
