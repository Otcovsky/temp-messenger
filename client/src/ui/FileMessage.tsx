import { Download, FileText, Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Messenger } from '../core/messenger'
import { t } from '../i18n'
import { saveFileNative } from '../native'
import { isNativeApp } from '../platform'
import type { Message } from '../storage/db'
import { formatSize } from './format'
import { useMessenger } from './hooks'
import { Modal } from './Modal'

/**
 * Картинки, которые показываются прямо в чате. Только растровые: SVG может содержать скрипты,
 * и открытый как страница он выполнился бы от имени приложения.
 */
const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/

/** Файл показывается картинкой прямо в ленте (тогда время рисуется поверх неё). */
export const isInlineImage = (msg: Message) => msg.file?.state === 'ready' && INLINE_IMAGE.test(msg.file.mime)

export const isInlineMime = (mime: string) => INLINE_IMAGE.test(mime)

/** Адрес blob: для показа файла из базы. Освобождается, когда компонент уходит с экрана. */
function useFileUrl(msgId: string, enabled: boolean, mime: string): string | null {
  const m = useMessenger()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    let made: string | null = null
    void m.fileData(msgId).then((data) => {
      if (!alive || !data) return
      made = URL.createObjectURL(new Blob([data], { type: mime }))
      setUrl(made)
    })
    return () => {
      alive = false
      if (made) URL.revokeObjectURL(made)
      setUrl(null)
    }
  }, [m, msgId, enabled, mime])
  return url
}

/** Сохранить файл на устройство. Тип octet-stream — чтобы браузер скачал файл, а не открыл его. */
async function saveFile(m: Messenger, msg: Message) {
  const data = await m.fileData(msg.id)
  if (!data || !msg.file) return
  if (isNativeApp) return saveFileNative(msg.file.name, new Uint8Array(data))
  const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = msg.file.name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function ImageViewer({ msg, url, onClose }: { msg: Message; url: string; onClose: () => void }) {
  const m = useMessenger()
  return (
    <Modal title={msg.file!.name} onClose={onClose} wide>
      <img className="mx-auto mb-4 block max-h-[65dvh] max-w-full rounded-2xl" src={url} alt={msg.file!.name} />
      <button className="btn btn-primary w-full" onClick={() => void saveFile(m, msg)}>
        <Download className="size-5" /> {t('file.save')}
      </button>
    </Modal>
  )
}

/**
 * Рамка картинки в ленте: не больше 320×320 и 70% ширины экрана, без увеличения маленьких.
 * Размер задан заранее, поэтому картинка встаёт в ленту сразу целиком, а не растёт при загрузке.
 */
const imageBox = (w: number, h: number): React.CSSProperties => ({
  aspectRatio: `${w} / ${h}`,
  width: `min(${w}px, 320px, 70vw, ${(320 * w) / h}px)`,
})

/** Одиночный файл в ленте: картинка целиком или карточка с именем и размером. */
export function FileMessage({ msg }: { msg: Message }) {
  const m = useMessenger()
  const file = msg.file!
  const inline = file.state === 'ready' && isInlineMime(file.mime)
  const imageUrl = useFileUrl(msg.id, inline, file.mime)
  const [size, setSize] = useState(file.w && file.h ? { w: file.w, h: file.h } : null)
  const [viewing, setViewing] = useState(false)

  // Размер ещё не известен (картинку показываем впервые): узнаём его, расшифровав картинку
  // заранее, и только потом ставим её в ленту — одним шагом, без промежуточных высот
  useEffect(() => {
    if (!imageUrl || size) return
    let alive = true
    const img = new Image()
    img.src = imageUrl
    img.decode().then(
      () => {
        const s = { w: img.naturalWidth, h: img.naturalHeight }
        if (!alive || !s.w || !s.h) return
        setSize(s)
        void m.rememberImageSize(msg.id, s.w, s.h)
      },
      () => {}, // битая картинка — остаётся карточкой файла
    )
    return () => {
      alive = false
    }
  }, [m, msg.id, imageUrl, size])

  if (!inline || !size) return <FileCard msg={msg} />
  return (
    <>
      <button
        className="block overflow-hidden rounded-[18px] bg-slate-900/10 transition active:scale-[0.98] dark:bg-white/8"
        style={imageBox(size.w, size.h)}
        disabled={!imageUrl}
        onClick={() => setViewing(true)}
        aria-label={t('file.open', { name: file.name })}
      >
        {imageUrl && <img className="block size-full" src={imageUrl} alt={file.name} />}
      </button>
      {viewing && imageUrl && <ImageViewer msg={msg} url={imageUrl} onClose={() => setViewing(false)} />}
    </>
  )
}

/** Картинка в сетке альбома: квадрат с обрезкой; пока файл не готов — крутилка. */
export function MediaTile({ msg, className = '' }: { msg: Message; className?: string }) {
  const file = msg.file!
  const url = useFileUrl(msg.id, file.state === 'ready', file.mime)
  const [viewing, setViewing] = useState(false)
  const busy = !url || file.state === 'loading' || msg.transfer === 'up'
  return (
    <>
      <button
        className={`relative block overflow-hidden bg-slate-900/10 transition active:brightness-90 dark:bg-white/8 ${className}`}
        disabled={!url}
        onClick={() => setViewing(true)}
        aria-label={t('file.open', { name: file.name })}
      >
        {url && <img className="size-full object-cover" src={url} alt={file.name} />}
        {busy && (
          <span className="absolute inset-0 grid place-items-center bg-black/15">
            <Loader2 className="size-6 animate-spin text-white drop-shadow" />
          </span>
        )}
      </button>
      {viewing && url && <ImageViewer msg={msg} url={url} onClose={() => setViewing(false)} />}
    </>
  )
}

/** Карточка файла: значок-кнопка «сохранить», имя и состояние передачи. */
export function FileCard({ msg }: { msg: Message }) {
  const m = useMessenger()
  const file = msg.file!
  const ready = file.state === 'ready'
  const mine = msg.from === 'me'
  const busy = file.state === 'loading' || msg.transfer === 'up'
  const bad = file.state === 'gone' || file.state === 'error'
  let status: React.ReactNode
  if (mine && msg.transfer === 'up') status = t('file.uploading')
  else if (file.state === 'loading') status = t('file.downloading')
  else if (file.state === 'gone') status = t('file.gone')
  else if (file.state === 'error')
    status = (
      <button className="font-semibold underline underline-offset-2" onClick={() => void m.retryDownload(msg.id)}>
        {t('file.retry')}
      </button>
    )
  else status = formatSize(file.size)

  const iconBox = mine
    ? 'bg-white/20 text-white'
    : ready
      ? 'bg-brand text-white shadow-md shadow-violet-500/30'
      : 'bg-slate-900/5 text-slate-500 dark:bg-white/8 dark:text-slate-400'

  return (
    <div className="flex min-w-0 items-center gap-3 py-1 pr-2 pl-1">
      <button
        className={`relative grid size-11 shrink-0 place-items-center rounded-2xl transition active:scale-90 ${iconBox}`}
        disabled={!ready}
        onClick={() => void saveFile(m, msg)}
        aria-label={t('file.saveNamed', { name: file.name })}
      >
        {ready && !busy ? (
          <Download className="size-5" />
        ) : busy ? (
          <Loader2 className="size-5 animate-spin" />
        ) : bad ? (
          <X className="size-5" />
        ) : (
          <FileText className="size-5" />
        )}
      </button>
      <span className="flex min-w-0 flex-col">
        {ready ? (
          <button className="truncate text-left font-semibold hover:underline" onClick={() => void saveFile(m, msg)}>
            {file.name}
          </button>
        ) : (
          <b className="truncate font-semibold">{file.name}</b>
        )}
        <small
          className={`text-xs ${bad ? (mine ? 'text-rose-100' : 'text-rose-500') : mine ? 'text-white/75' : 'muted'}`}
        >
          {status}
          {file.state !== 'ready' && file.state !== 'gone' && ` · ${formatSize(file.size)}`}
        </small>
      </span>
    </div>
  )
}
