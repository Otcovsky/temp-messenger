import { getLang, t } from '../i18n'

/** Время сообщения: «14:05» или «2:05 PM» — по обычаю текущего языка */
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' })
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return formatClock(ts)
  return d.toLocaleDateString(getLang(), { day: 'numeric', month: 'short' })
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return t('size.b', { n: bytes })
  if (bytes < 1024 * 1024) return t('size.kb', { n: Math.round(bytes / 1024) })
  const mb = new Intl.NumberFormat(getLang(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)
  return t('size.mb', { n: mb })
}

export function formatDay(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return t('day.today')
  if (d.toDateString() === yesterday.toDateString()) return t('day.yesterday')
  return d.toLocaleDateString(getLang(), {
    day: 'numeric',
    month: 'long',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
}
