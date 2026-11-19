import { FileText, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { isInlineMime } from './FileMessage'
import { formatSize } from './format'

/** Сколько файлов можно приложить к одному сообщению */
export const MAX_ATTACHMENTS = 10

/**
 * Файлы, выбранные для отправки, — над полем ввода. Пока они здесь, текст в поле станет
 * подписью к ним; пустое поле — файлы уйдут без подписи.
 */
export function AttachmentTray({
  files,
  onRemove,
  onClear,
  onAdd,
}: {
  files: File[]
  onRemove: (index: number) => void
  onClear: () => void
  onAdd: () => void
}) {
  const total = files.reduce((s, f) => s + f.size, 0)
  return (
    <div className="mb-2 animate-pop-in">
      <div className="mb-1.5 flex items-center gap-2 px-1.5 text-xs">
        <span className="muted flex-1 truncate">
          {files.length === 1 ? files[0].name : t('file.count', { n: files.length })} ·{' '}
          {formatSize(total)}
          <span className="max-sm:hidden">{t('file.captionHint')}</span>
        </span>
        <button type="button" className="font-semibold text-violet-600 dark:text-violet-400" onClick={onClear}>
          {t('file.clear')}
        </button>
      </div>
      <ul className="no-scrollbar flex gap-2 overflow-x-auto px-1 pt-1.5 pb-0.5">
        {files.map((f, i) => (
          <li key={`${f.name}-${f.size}-${f.lastModified}-${i}`} className="relative shrink-0">
            <Thumb file={f} />
            <button
              type="button"
              className="absolute -top-1.5 -right-1.5 grid size-6 place-items-center rounded-full bg-slate-900/80 text-white shadow ring-2 ring-white transition active:scale-90 dark:ring-surface-dark"
              onClick={() => onRemove(i)}
              aria-label={t('file.remove', { name: f.name })}
            >
              <X className="size-3.5" strokeWidth={3} />
            </button>
          </li>
        ))}
        {files.length < MAX_ATTACHMENTS && (
          <li className="shrink-0">
            <button
              type="button"
              className="grid size-18 place-items-center rounded-2xl border-2 border-dashed border-slate-300 text-slate-400 transition active:scale-95 dark:border-white/15 dark:text-slate-500"
              onClick={onAdd}
              aria-label={t('file.addMore')}
              title={t('file.addMoreShort')}
            >
              <Plus className="size-6" />
            </button>
          </li>
        )}
      </ul>
    </div>
  )
}

/** Миниатюра: картинка — превью, остальное — значок с расширением и размером. */
function Thumb({ file }: { file: File }) {
  const image = isInlineMime(file.type)
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!image) return
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file, image])

  if (image) {
    return (
      <div className="size-18 overflow-hidden rounded-2xl bg-slate-200 dark:bg-white/8">
        {url && <img className="size-full object-cover" src={url} alt={file.name} />}
      </div>
    )
  }
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.slice(0, 5).toUpperCase() : t('file.noExt')
  return (
    <div
      className="flex size-18 flex-col items-center justify-center gap-0.5 rounded-2xl bg-brand-soft px-1 text-violet-600 dark:text-violet-300"
      title={file.name}
    >
      <FileText className="size-6" />
      <span className="max-w-full truncate text-[10px] font-bold">{ext}</span>
      <span className="muted text-[10px]">{formatSize(file.size)}</span>
    </div>
  )
}
