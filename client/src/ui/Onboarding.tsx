import { useState } from 'react'
import { useMessenger } from './hooks'
import { IosInstallHint } from './PwaUi'

export function Onboarding({ hasInvite }: { hasInvite: boolean }) {
  const m = useMessenger()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError('')
    try {
      await m.createAccount(name)
      m.start()
    } catch (err) {
      // Раньше кнопка навсегда оставалась в «Создаю ключи…» без объяснений
      console.error('Не удалось создать аккаунт', err)
      setError(`Не удалось создать ключи: ${err instanceof Error ? err.message : String(err)}`)
      setBusy(false)
    }
  }

  return (
    <div className="center-screen">
      <form className="card onboarding" onSubmit={submit}>
        <h1>Temp Messenger</h1>
        <p className="muted">
          Мессенджер живёт только в этом браузере. Ключи шифрования и переписка хранятся здесь же — на сервере
          остаётся лишь зашифрованная очередь недоставленных сообщений.
        </p>
        <p className="warn">
          Очистка данных сайта, удаление браузера или режим инкогнито после закрытия окна — и всё исчезнет
          безвозвратно. Восстановить нельзя.
        </p>
        <IosInstallHint hasInvite={hasInvite} />
        {hasInvite && <p className="muted">Вас пригласили в чат. Представьтесь, чтобы принять приглашение.</p>}
        <label>
          Как вас называть собеседникам
          <input autoFocus maxLength={64} value={name} onChange={(e) => setName(e.target.value)} placeholder="Имя" />
        </label>
        <button className="primary" disabled={busy || !name.trim()}>
          {busy ? 'Создаю ключи…' : 'Начать'}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  )
}
