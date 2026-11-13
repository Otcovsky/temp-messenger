/**
 * Шифрование файлов (docs/protocol.md, «Файлы»).
 *
 * У каждого файла свой случайный ключ AES-256-GCM. Ключ используется один раз, поэтому IV нулевой,
 * а шифротекст для того же ключа и файла всегда одинаковый: повторная загрузка после сбоя
 * отдаёт серверу те же байты. Перед шифрованием файл дополняется по схеме Padmé, чтобы
 * сервер видел размер лишь приблизительно (запас не больше 12%, у больших файлов — 1–2%).
 */
import { type Bytes, randomBytes, unpad, utf8 } from './bytes'
import { aesGcmDecrypt, aesGcmEncrypt } from './primitives'

const IV = new Uint8Array(12) as Bytes
const AD = utf8('TM-File-v1')

export const newFileKey = (): Bytes => randomBytes(32)

/** Padmé: длина, до которой дополняется сообщение длины len. */
export function padmeLength(len: number): number {
  if (len < 2) return len
  const e = Math.floor(Math.log2(len))
  const s = Math.floor(Math.log2(e)) + 1
  const mask = 2 ** (e - s) - 1
  return Math.ceil(len / (mask + 1)) * (mask + 1)
}

/** Дополнение как в pad() (0x80, затем нули), но до длины по Padmé. */
function padFile(data: Uint8Array): Bytes {
  const out = new Uint8Array(padmeLength(data.length + 1))
  out.set(data)
  out[data.length] = 0x80
  return out
}

export function encryptFile(key: Bytes, data: Uint8Array): Promise<Bytes> {
  return aesGcmEncrypt(key, IV, padFile(data), AD)
}

export async function decryptFile(key: Bytes, ct: Bytes): Promise<Bytes> {
  return unpad(await aesGcmDecrypt(key, IV, ct, AD))
}
