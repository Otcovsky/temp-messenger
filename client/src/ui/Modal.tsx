import { X } from 'lucide-react'
import { useEffect } from 'react'
import { t } from '../i18n'

/**
 * Модальное окно. На телефоне — шторка снизу (до неё дотягивается большой палец),
 * на широком экране — карточка по центру.
 */
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-end justify-center bg-slate-950/50 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-[92dvh] w-full animate-sheet-up flex-col overflow-hidden rounded-t-[28px] bg-white shadow-2xl sm:animate-pop-in sm:rounded-[28px] dark:bg-surface-dark ${wide ? 'sm:max-w-xl' : 'sm:max-w-md'}`}
      >
        <div className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 rounded-full bg-slate-300 sm:hidden dark:bg-white/15" aria-hidden />
        <header className="flex shrink-0 items-center gap-2 py-2 pr-2 pl-6 sm:pt-4">
          <h2 className="flex-1 truncate text-lg font-bold">{title}</h2>
          <button className="btn-icon" onClick={onClose} aria-label={t('common.close')}>
            <X className="size-5" />
          </button>
        </header>
        <div className="overflow-y-auto overscroll-contain px-6 pt-1 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </div>
    </div>
  )
}
