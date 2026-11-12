/**
 * Сканер QR-кода с камеры. Распознаёт встроенным BarcodeDetector, если он есть,
 * иначе библиотекой jsQR (грузится только при открытии сканера).
 * Если камеры нет или доступ запрещён — можно выбрать фото с QR-кодом.
 */
import { useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'

type Decoder = (img: ImageData) => Promise<string | null>

interface BarcodeDetectorLike {
  detect(src: ImageBitmapSource): Promise<{ rawValue: string }[]>
}
declare const BarcodeDetector:
  | { new (o: { formats: string[] }): BarcodeDetectorLike; getSupportedFormats(): Promise<string[]> }
  | undefined

const MAX_SIDE = 800 // кадр уменьшаем: распознавать быстрее, точности хватает
const SCAN_EVERY_MS = 150
const PHOTO_MAX_SIDE = 1600 // на фото с телефона QR обычно занимает малую часть кадра

async function makeDecoder(): Promise<Decoder> {
  try {
    if (typeof BarcodeDetector !== 'undefined' && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
      const det = new BarcodeDetector({ formats: ['qr_code'] })
      return async (img) => (await det.detect(img))[0]?.rawValue ?? null
    }
  } catch {
    /* падаем на jsQR */
  }
  const { default: jsQR } = await import('jsqr')
  return async (img) => jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })?.data ?? null
}

function frame(ctx: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number, max = MAX_SIDE): ImageData {
  const k = Math.min(1, max / Math.max(w, h))
  const cw = Math.round(w * k)
  const ch = Math.round(h * k)
  ctx.canvas.width = cw
  ctx.canvas.height = ch
  ctx.drawImage(src, 0, 0, cw, ch)
  return ctx.getImageData(0, 0, cw, ch)
}

/** Запрещена ли камера заголовком Permissions-Policy (тогда getUserMedia всё равно не сработает). */
function cameraBlockedByPolicy(): boolean {
  const d = document as Document & {
    permissionsPolicy?: { allowsFeature(f: string): boolean }
    featurePolicy?: { allowsFeature(f: string): boolean }
  }
  try {
    const p = d.permissionsPolicy ?? d.featurePolicy
    return p ? !p.allowsFeature('camera') : false
  } catch {
    return false
  }
}

function cameraError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'PolicyError') return 'Сфотографируйте QR-код или выберите готовое фото.'
  if (name === 'NotAllowedError') return 'Доступ к камере запрещён. Разрешите его в настройках сайта или выберите фото с QR-кодом.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Камера не найдена. Выберите фото с QR-кодом.'
  return 'Не удалось включить камеру. Выберите фото с QR-кодом.'
}

export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(true)
  const decoder = useRef<Promise<Decoder> | null>(null)
  const done = useRef(false)
  const getDecoder = () => (decoder.current ??= makeDecoder())

  const finish = (text: string) => {
    if (done.current) return
    done.current = true
    navigator.vibrate?.(50)
    onResult(text)
  }

  useEffect(() => {
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!

    const loop = async () => {
      const v = video.current
      if (stopped || done.current || !v) return
      if (v.readyState >= 2 && v.videoWidth) {
        try {
          const text = await (await getDecoder())(frame(ctx, v, v.videoWidth, v.videoHeight))
          if (text && !stopped) return finish(text)
        } catch {
          /* кадр не распознан — пробуем следующий */
        }
      }
      timer = setTimeout(loop, SCAN_EVERY_MS)
    }

    ;(async () => {
      if (cameraBlockedByPolicy()) throw new DOMException('', 'PolicyError')
      if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('', 'NotFoundError')
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      if (stopped) return
      const v = video.current!
      v.srcObject = stream
      await v.play()
      setStarting(false)
      void getDecoder()
      void loop()
    })().catch((e) => {
      if (stopped) return
      setStarting(false)
      setError(cameraError(e))
    })

    return () => {
      stopped = true
      clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fromFile = async (file: File | undefined) => {
    if (!file) return
    setError('')
    try {
      const bmp = await createImageBitmap(file)
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
      const text = await (await getDecoder())(frame(ctx, bmp, bmp.width, bmp.height, PHOTO_MAX_SIDE))
      bmp.close()
      if (text) finish(text)
      else setError('На фото не найден QR-код. Попробуйте снять ближе и ровнее.')
    } catch {
      setError('Не удалось прочитать изображение.')
    }
  }

  return (
    <Modal title="Сканировать QR-код" onClose={onClose}>
      <div className="scanner">
        {!error && (
          <div className="scanner-view">
            <video ref={video} playsInline muted />
            <div className="scanner-frame" aria-hidden="true" />
            {starting && <p className="scanner-hint">Включаю камеру…</p>}
          </div>
        )}
        {error ? <p className="error">{error}</p> : <p className="muted small">Наведите камеру на QR-код приглашения.</p>}
        <label className="button">
          Сфотографировать или выбрать фото
          <input type="file" accept="image/*" hidden onChange={(e) => void fromFile(e.target.files?.[0])} />
        </label>
      </div>
    </Modal>
  )
}
