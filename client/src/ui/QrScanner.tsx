/**
 * Сканер QR-кода с камеры. Распознаёт встроенным BarcodeDetector, если он есть,
 * иначе библиотекой jsQR (грузится только при открытии сканера).
 * Если камеры нет или доступ запрещён — можно выбрать фото с QR-кодом.
 */
import { Camera, ImageUp, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
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
  if (name === 'PolicyError') return t('qr.policy')
  if (name === 'NotAllowedError') return t('qr.denied')
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return t('qr.noCamera')
  return t('qr.cameraFailed')
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
      else setError(t('qr.notFound'))
    } catch {
      setError(t('qr.badImage'))
    }
  }

  const corner = 'absolute size-9 border-white'
  return (
    <Modal title={t('qr.title')} onClose={onClose}>
      <div className="grid gap-4">
        {!error && (
          <div className="relative aspect-square overflow-hidden rounded-3xl bg-black">
            <video ref={video} className="block size-full object-cover" playsInline muted />
            <div className="scanner-frame absolute inset-[16%] rounded-3xl" aria-hidden="true">
              <span className={`${corner} top-0 left-0 rounded-tl-3xl border-t-4 border-l-4`} />
              <span className={`${corner} top-0 right-0 rounded-tr-3xl border-t-4 border-r-4`} />
              <span className={`${corner} bottom-0 left-0 rounded-bl-3xl border-b-4 border-l-4`} />
              <span className={`${corner} right-0 bottom-0 rounded-br-3xl border-r-4 border-b-4`} />
            </div>
            {starting && (
              <p className="absolute inset-0 flex items-center justify-center gap-2 text-white">
                <Loader2 className="size-5 animate-spin" /> {t('qr.starting')}
              </p>
            )}
          </div>
        )}
        {error ? (
          <p className="note note-warn">
            <Camera className="mt-0.5 size-5 shrink-0" />
            <span>{error}</span>
          </p>
        ) : (
          <p className="muted text-center text-sm">{t('qr.aim')}</p>
        )}
        <label role="button" className={`btn w-full ${error ? 'btn-primary' : 'btn-soft'}`}>
          <ImageUp className="size-5" /> {t('qr.photo')}
          <input type="file" accept="image/*" hidden onChange={(e) => void fromFile(e.target.files?.[0])} />
        </label>
      </div>
    </Modal>
  )
}
