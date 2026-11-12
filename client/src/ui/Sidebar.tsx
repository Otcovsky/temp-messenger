import { useState } from 'react'
import { CreateInviteDialog, JoinDialog } from './InviteDialogs'
import { useLive, useMessenger } from './hooks'
import { Modal } from './Modal'
import { AppSection, InstallBanner } from './PwaUi'
import { formatTime } from './format'

const STATUS_TEXT = { online: 'в сети', connecting: 'подключение…', offline: 'нет связи' } as const

export function Sidebar({ active, onSelect }: { active: string | null; onSelect: (id: string) => void }) {
  const m = useMessenger()
  const conversations = useLive((m) => m.conversations(), [])
  const [inviting, setInviting] = useState(false)
  const [joining, setJoining] = useState(false)
  const [settings, setSettings] = useState(false)

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <button className="me" onClick={() => setSettings(true)} title="Настройки">
          <Avatar name={m.profile!.name} />
          <span>
            <b>{m.profile!.name}</b>
            <small className={`conn ${m.status}`}>{STATUS_TEXT[m.status]}</small>
          </span>
        </button>
      </header>
      <div className="sidebar-actions">
        <button className="primary" onClick={() => setInviting(true)}>
          + Пригласить
        </button>
        <button onClick={() => setJoining(true)}>Присоединиться</button>
      </div>
      <InstallBanner />

      <ul className="conv-list">
        {conversations?.length === 0 && <li className="muted empty-hint">Пока нет чатов</li>}
        {conversations?.map((c) => (
          <li key={c.id}>
            <button className={c.id === active ? 'conv active' : 'conv'} onClick={() => onSelect(c.id)}>
              <Avatar name={c.title} />
              <span className="conv-main">
                <span className="conv-top">
                  <b>{c.title}</b>
                  <small>{c.lastText ? formatTime(c.lastTs) : ''}</small>
                </span>
                <span className="conv-bottom">
                  <span className="preview">{c.lastText || 'Нет сообщений'}</span>
                  {c.unread > 0 && <span className="badge">{c.unread}</span>}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {inviting && <CreateInviteDialog onClose={() => setInviting(false)} />}
      {joining && <JoinDialog onClose={() => setJoining(false)} />}
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
    </aside>
  )
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const m = useMessenger()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  const wipe = async () => {
    setBusy(true)
    await m.wipeAll()
    location.reload()
  }

  return (
    <Modal title="Настройки" onClose={onClose}>
      <p className="muted">
        Все данные хранятся только в этом браузере. На сервере — лишь зашифрованные сообщения, которые ещё не
        забрал получатель (не дольше 7 дней).
      </p>
      <hr />
      <AppSection />
      <hr />
      <h3>Удалить всё</h3>
      <p className="muted small">
        Собеседники получат уведомление, что чат закрыт. Ключи, контакты и переписка будут стёрты без возможности
        восстановления.
      </p>
      {!confirm ? (
        <button className="danger" onClick={() => setConfirm(true)}>
          Удалить всё…
        </button>
      ) : (
        <div className="actions">
          <button onClick={() => setConfirm(false)} disabled={busy}>
            Отмена
          </button>
          <button className="danger" onClick={wipe} disabled={busy}>
            {busy ? 'Удаляю…' : 'Да, удалить безвозвратно'}
          </button>
        </div>
      )}
    </Modal>
  )
}

export function Avatar({ name }: { name: string }) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360
  return (
    <span className="avatar" style={{ background: `hsl(${h} 45% 45%)` }} aria-hidden>
      {[...name.trim()][0]?.toUpperCase() ?? '?'}
    </span>
  )
}
