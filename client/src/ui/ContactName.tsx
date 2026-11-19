import { useState } from 'react'
import { t } from '../i18n'
import { useMessenger } from './hooks'

/**
 * Своё имя для собеседника или участника группы — видно только мне.
 * Нужно, когда несколько человек назвали себя одинаково («Аня», «Аня»…).
 */
export function ContactNameForm({
  contactId,
  name,
  selfName,
  className = '',
}: {
  contactId: string
  name: string
  /** Как человек назвал себя сам — подсказка, если у меня он подписан иначе */
  selfName?: string
  className?: string
}) {
  const m = useMessenger()
  const [draft, setDraft] = useState<string | null>(null)
  const inputId = `contact-name-${contactId}`
  const value = draft ?? name
  const changed = draft !== null && !!draft.trim() && draft.trim() !== name

  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault()
        if (changed) void m.renameContact(contactId, draft!).then(() => setDraft(null))
      }}
    >
      <label className="section-title block" htmlFor={inputId}>
        {t('contact.nameLabel')}
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          className="field"
          value={value}
          maxLength={64}
          enterKeyHint="done"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn btn-soft shrink-0" disabled={!changed}>
          {t('common.save')}
        </button>
      </div>
      {selfName && selfName !== name && <p className="muted mt-1.5 text-xs">{t('contact.selfName', { name: selfName })}</p>}
    </form>
  )
}
