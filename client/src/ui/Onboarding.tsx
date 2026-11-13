import { ArrowRight, HardDrive, Loader2, Lock, MailOpen, ShieldCheck, TriangleAlert } from 'lucide-react'
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
    <div className="min-h-dvh overflow-y-auto bg-aurora px-4 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto flex w-full max-w-md flex-col">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="relative mb-5">
            <div className="absolute inset-0 rounded-[30px] bg-brand opacity-50 blur-2xl" />
            <div className="relative grid size-22 place-items-center rounded-[30px] bg-brand text-white shadow-2xl">
              <ShieldCheck className="size-11" strokeWidth={1.75} />
            </div>
          </div>
          <h1 className="text-[32px] leading-tight font-extrabold tracking-tight">
            Temp <span className="text-brand">Messenger</span>
          </h1>
          <p className="muted mt-2 max-w-xs">Переписка, которая живёт только на вашем устройстве</p>
        </div>

        <ul className="mb-5 grid gap-2.5">
          <Feature icon={<Lock className="size-5" />} title="Сквозное шифрование">
            Ключи создаются здесь и никогда не покидают устройство
          </Feature>
          <Feature icon={<HardDrive className="size-5" />} title="Всё хранится в браузере">
            На сервере — лишь зашифрованная очередь недоставленных сообщений
          </Feature>
        </ul>

        <form className="card p-5" onSubmit={submit}>
          <IosInstallHint hasInvite={hasInvite} />
          {hasInvite && (
            <p className="note note-info mb-4">
              <MailOpen className="mt-0.5 size-5 shrink-0 text-violet-500" />
              <span>Вас пригласили в чат. Представьтесь, чтобы принять приглашение.</span>
            </p>
          )}
          <label className="section-title block" htmlFor="my-name">
            Как вас называть собеседникам
          </label>
          <input
            id="my-name"
            className="field mb-3"
            autoFocus
            maxLength={64}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Имя"
            autoComplete="nickname"
          />
          <button className="btn btn-primary w-full" disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="size-5 animate-spin" /> : null}
            {busy ? 'Создаю ключи…' : 'Начать'}
            {!busy && <ArrowRight className="size-5" />}
          </button>
          {error && <p className="note note-error mt-3">{error}</p>}
        </form>

        <p className="note note-warn mt-4">
          <TriangleAlert className="mt-0.5 size-5 shrink-0" />
          <span>
            Очистка данных сайта, удаление браузера или режим инкогнито после закрытия окна — и всё исчезнет
            безвозвратно. Восстановить нельзя.
          </span>
        </p>
      </div>
    </div>
  )
}

function Feature({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3.5 rounded-2xl bg-white/60 p-3.5 backdrop-blur dark:bg-white/[0.04]">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand text-white shadow-md shadow-violet-500/30">
        {icon}
      </span>
      <span className="flex flex-col">
        <b className="text-sm font-semibold">{title}</b>
        <span className="muted text-[13px] leading-snug">{children}</span>
      </span>
    </li>
  )
}
