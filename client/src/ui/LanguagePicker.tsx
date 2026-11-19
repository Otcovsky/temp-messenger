import { LANGS, setLang, t } from '../i18n'
import { useLang } from '../i18n/react'

/**
 * Выбор языка — сегменты с названием каждого языка на нём самом. Меняется сразу, без перезагрузки:
 * открытые чаты и звонок не прерываются. compact — маленький, для экрана первого входа.
 */
export function LanguagePicker({ compact = false, className = '' }: { compact?: boolean; className?: string }) {
  const lang = useLang()
  return (
    <div
      className={`grid gap-1 rounded-2xl bg-slate-900/[0.04] p-1 dark:bg-white/[0.05] ${className}`}
      style={{ gridTemplateColumns: `repeat(${LANGS.length}, minmax(0, 1fr))` }}
      role="radiogroup"
      aria-label={t('settings.language')}
    >
      {LANGS.map((l) => (
        <button
          key={l.id}
          type="button"
          role="radio"
          aria-checked={lang === l.id}
          lang={l.id}
          className={`rounded-xl font-semibold transition ${compact ? 'px-3 py-1 text-xs' : 'py-2 text-sm'} ${lang === l.id ? 'bg-white text-violet-700 shadow-sm dark:bg-white/15 dark:text-white' : 'muted hover:bg-white/50 dark:hover:bg-white/5'}`}
          onClick={() => setLang(l.id)}
        >
          {l.name}
        </button>
      ))}
    </div>
  )
}
