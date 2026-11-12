import { useEffect, useState } from 'react'
import { Messenger } from '../core/messenger'
import { checkSupport } from '../crypto/primitives'
import { ChatView } from './ChatView'
import { AcceptInviteDialog } from './InviteDialogs'
import { MessengerContext, useMessenger, useVersion } from './hooks'
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

  if (boot.kind === 'loading') return <Center>Загрузка…</Center>
  if (boot.kind === 'error') return <Center>{boot.text}</Center>
  if (boot.kind === 'locked') {
    return (
      <Center>
        Мессенджер уже открыт в другой вкладке.
        <br />
        Закройте её — эта вкладка подхватит работу автоматически.
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

  if (!m.hasAccount) return <Onboarding hasInvite={!!invite} />

  return (
    <div className="app" data-view={active ? 'chat' : 'list'}>
      <Sidebar active={active} onSelect={setActive} />
      {active ? (
        <ChatView key={active} convId={active} onBack={() => setActive(null)} onDeleted={() => setActive(null)} />
      ) : (
        <section className="chat empty">
          <p>Выберите чат или пригласите собеседника.</p>
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

function Center({ children }: { children: React.ReactNode }) {
  return <div className="center-screen">{children}</div>
}
