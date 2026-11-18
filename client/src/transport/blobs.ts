/**
 * Обмен зашифрованными файлами с сервером по HTTP (docs/protocol.md, «Файлы»).
 * Сюда попадает только шифротекст: ключ, имя и тип файла уходят собеседнику внутри сообщения.
 */
import { type Bytes, b64e, utf8 } from '../crypto/bytes'
import { type KeyPair, sign } from '../crypto/primitives'
import { serverOrigin } from '../platform'

/**
 * Отказ при обмене файлом. permanent — повторять бессмысленно (сервер отказал);
 * иначе это сбой связи, и попытка повторится при следующем подключении.
 */
export class BlobError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message)
  }
}

const NO_FILES = 'Сервер не принимает файлы. Он ещё не обновлён или настроен без них.'

function refusal(status: number): BlobError {
  switch (status) {
    case 413:
      return new BlobError('Файл слишком большой для сервера.', true)
    case 507:
      return new BlobError('На сервере сейчас нет места для файлов. Попробуйте позже.', true)
    case 404:
    case 405:
      return new BlobError(NO_FILES, true)
    case 403:
      return new BlobError('Сервер не принял подпись загрузки.', true)
    case 429:
      // Ограничение частоты запросов с одного адреса (nginx): много файлов сразу. Это не отказ —
      // попытка повторится позже.
      return new BlobError('Сервер просит подождать: слишком много файлов сразу.', false)
    default:
      // 5xx — сервер перезапускается или перегружен: попробуем позже
      return new BlobError(`Сервер отклонил файл (${status}).`, status < 500)
  }
}

const url = (id: string) => `${serverOrigin()}/blob/${id}`

/** Загрузить шифротекст. recipients — сколько получателей должны скачать файл, прежде чем сервер его сотрёт. */
export async function putBlob(id: string, ct: Bytes, recipients: number, auth: KeyPair): Promise<void> {
  const sig = await sign(auth.priv, utf8(`tm-blob-v1:${id}:${ct.length}:${recipients}`))
  let res: Response
  try {
    res = await fetch(`${url(id)}?n=${recipients}`, {
      method: 'PUT',
      body: ct,
      headers: { 'X-TM-Auth': `${b64e(auth.pub)}.${b64e(sig)}`, 'Content-Type': 'application/octet-stream' },
      cache: 'no-store',
    })
  } catch {
    throw new BlobError('Нет связи с сервером.', false)
  }
  if (!res.ok) throw refusal(res.status)
}

/** Скачать шифротекст. null — файла на сервере нет (срок хранения истёк или его уже скачали). */
export async function getBlob(id: string): Promise<Bytes | null> {
  let res: Response
  try {
    res = await fetch(url(id), { cache: 'no-store' })
  } catch {
    throw new BlobError('Нет связи с сервером.', false)
  }
  if (res.status === 404) return null
  if (!res.ok) throw refusal(res.status)
  // Сервер без поддержки файлов отвечает на любой путь страницей приложения
  if (res.headers.get('content-type')?.startsWith('text/html')) throw new BlobError(NO_FILES, true)
  try {
    return new Uint8Array(await res.arrayBuffer()) as Bytes
  } catch {
    throw new BlobError('Связь прервалась во время скачивания.', false)
  }
}

/** Попыток сообщить «скачан»: паузы 1, 2, 4 … 32 с — около минуты в сумме. */
const DONE_ATTEMPTS = 7

/**
 * Сообщить серверу, что файл скачан: когда скачают все получатели, он его сотрёт.
 * Без этого файл пролежит на сервере до конца срока (7 дней) и займёт квоту отправителя,
 * поэтому при ограничении частоты (429), сбое сервера (5xx) или связи запрос повторяется.
 */
export async function blobDone(id: string, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  for (let i = 0; i < DONE_ATTEMPTS; i++) {
    if (i > 0) await sleep(1000 * 2 ** (i - 1) * (0.5 + Math.random()))
    try {
      const res = await fetch(`${url(id)}/done`, { method: 'POST', cache: 'no-store' })
      if (res.status !== 429 && res.status < 500) return
    } catch {
      // нет связи — попробуем ещё раз
    }
  }
}
