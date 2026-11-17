import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlobError, blobDone, getBlob } from './blobs'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('location', { origin: 'https://chat.test' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const reply = (status: number) => new Response(status === 204 ? null : 'x', { status })
const noSleep = async () => {}

describe('ограничение частоты (429)', () => {
  it('скачивание при 429 — временный сбой, повторится', async () => {
    fetchMock.mockResolvedValue(reply(429))
    const err = await getBlob('a'.repeat(22)).catch((e) => e)
    expect(err).toBeInstanceOf(BlobError)
    expect(err.permanent).toBe(false)
  })

  it('отказ сервера (403) остаётся окончательным', async () => {
    fetchMock.mockResolvedValue(reply(403))
    const err = await getBlob('a'.repeat(22)).catch((e) => e)
    expect(err.permanent).toBe(true)
  })

  it('«скачан» повторяется при 429, 5xx и обрыве связи, пока сервер не ответит', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(429))
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(reply(502))
      .mockResolvedValueOnce(reply(204))
    await blobDone('b'.repeat(22), noSleep)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[3][0]).toBe(`https://chat.test/blob/${'b'.repeat(22)}/done`)
  })

  it('«скачан» не повторяется после ответа сервера и сдаётся после 7 попыток', async () => {
    fetchMock.mockResolvedValue(reply(204))
    await blobDone('c'.repeat(22), noSleep)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockReset()
    fetchMock.mockResolvedValue(reply(429))
    const pauses: number[] = []
    await blobDone('c'.repeat(22), async (ms) => void pauses.push(ms))
    expect(fetchMock).toHaveBeenCalledTimes(7)
    expect(pauses).toHaveLength(6)
    expect(pauses[5]).toBeGreaterThanOrEqual(16_000) // 32 с ± половина
  })
})
