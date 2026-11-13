import { Loader2, MessagesSquare, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Messenger } from '../core/messenger'
import { checkSupport } from '../crypto/primitives'
import { ChatView } from './ChatView'
import { AcceptInviteDialog } from './InviteDialogs'
import { MessengerContext, useMessenger, useVersion } from './hooks'
import { requestPersistence } from '../pwa'
import { Onboarding } from './Onboarding'
import { Sidebar } from './Sidebar'

type Boot =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'locked' }
  | { kind: 'ready'; m: Messenger }

/** Забираем приглашение из адреса и сразу убираем его оттуда (и из истории). */
function takeInviteFromHash(): string | null {
  const m = location.hash.match(/^#i=([A-Za-z0-9_-]+)$/)
  if (!m) return null
  history.replaceState(null, '', location.pathname + location.search)
  return m[1]
}

export function App() {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' })
  const [invite, setInvite] = useState<string | null>(takeInviteFromHash)

  useEffect(() => {
    const onHash = () => {
      const i = takeInviteFromHash()
      if (i) setInvite(i)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const problem = await checkSupport()
      if (cancelled) return // StrictMode монтирует эффект дважды
      if (problem) return setBoot({ kind: 'error', text: problem })
      // Мессенджер работает только в одной вкладке: она держит соединение и сессии.
      // Остальные ждут, пока замок освободится (вкладку закроют).
      const run = async () => {
        if (cancelled) return
        const m = await Messenger.open()
        if (m.hasAccount) m.start()
        setBoot({ kind: 'ready', m })
        await new Promise(() => {}) // держим замок, пока вкладка жива
      }
      if (navigator.locks) {
        const got = await navigator.locks.request('temp-messenger-main', { ifAvailable: true }, async (lock) => {
          if (!lock) return false
          await run()
          return true
        })
        if (got === false) {
          setBoot({ kind: 'locked' })
          navigator.locks.request('temp-messenger-main', run)
        }
      } else {
        await run()
      }
    })().catch((e) => setBoot({ kind: 'error', text: String(e?.message ?? e) }))
    return () => {
      cancelled = true
    }
  }, [])

  if (boot.kind === 'loading')
    return (
      <Center>
        <Loader2 className="size-8 animate-spin text-violet-500" />
      </Center>
    )
  if (boot.kind === 'error')
    return (
      <Center icon={<TriangleAlert className="size-7" />} title="Не получится запустить">
        {boot.text}
      </Center>
    )
  if (boot.kind === 'locked') {
    return (
      <Center icon={<MessagesSquare className="size-7" />} title="Открыто в другой вкладке">
        Мессенджер работает только в одной вкладке. Закройте ту — эта подхватит работу автоматически.
      </Center>
    )
  }
  return (
    <MessengerContext.Provider value={boot.m}>
      <Main invite={invite} clearInvite={() => setInvite(null)} />
    </MessengerContext.Provider>
  )
}

function Main({ invite, clearInvite }: { invite: string | null; clearInvite: () => void }) {
  useVersion()
  const [active, setActive] = useState<string | null>(null)
  const m = useMessenger()

  useEffect(() => {
    m.setActiveConversation(active)
  }, [m, active])

  // Ключи живут только в IndexedDB — просим браузер не стирать их сам
  useEffect(() => {
    if (m.hasAccount) void requestPersistence().catch(() => {})
  }, [m.hasAccount])

  if (!m.hasAccount) return <Onboarding hasInvite={!!invite} />

  return (
    <div className="flex h-dvh overflow-hidden md:grid md:grid-cols-[minmax(320px,380px)_1fr]">
      <Sidebar active={active} onSelect={setActive} hidden={!!active} />
      {active ? (
        <ChatView key={active} convId={active} onBack={() => setActive(null)} onDeleted={() => setActive(null)} />
      ) : (
        <section className="hidden flex-col items-center justify-center gap-4 bg-chat p-8 text-center md:flex">
          <div className="grid size-20 place-items-center rounded-[28px] bg-brand text-white shadow-xl shadow-violet-500/30">
            <ShieldCheck className="size-10" strokeWidth={1.75} />
          </div>
          <div>
            <p className="text-lg font-semibold">Выберите чат</p>
            <p className="muted mt-1">или пригласите собеседника — переписка шифруется прямо в браузере</p>
          </div>
        </section>
      )}
      {invite && (
        <AcceptInviteDialog
          code={invite}
          onClose={clearInvite}
          onAccepted={(convId) => {
            clearInvite()
            setActive(convId)
          }}
        />
      )}
    </div>
  )
}

function Center({ icon, title, children }: { icon?: React.ReactNode; title?: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-aurora p-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-4">
        {icon && (
          <div className="grid size-16 place-items-center rounded-3xl bg-brand text-white shadow-xl shadow-violet-500/30">
            {icon}
          </div>
        )}
        {title && <h1 className="text-xl font-bold">{title}</h1>}
        <div className="muted leading-relaxed">{children}</div>
      </div>
    </div>
  )
}
