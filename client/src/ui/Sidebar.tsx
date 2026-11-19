import { ChevronRight, KeyRound, MessageCirclePlus, ScanQrCode, Trash2, UserPlus, Users } from 'lucide-react'
import { useState } from 'react'
import { conversationPreview } from '../core/messenger'
import { t } from '../i18n'
import { Avatar } from './Avatar'
import { CallsSection } from './CallUi'
import { CreateGroupDialog } from './GroupUi'
import { CreateInviteDialog, JoinDialog } from './InviteDialogs'
import { LanguagePicker } from './LanguagePicker'
import { useLive, useMessenger } from './hooks'
import { Modal } from './Modal'
import { AppSection, InstallBanner, NotificationsSection } from './PwaUi'
import { formatTime } from './format'

export { Avatar }

const STATUS = {
  online: { text: 'status.online', dot: 'bg-emerald-500' },
  connecting: { text: 'status.connecting', dot: 'bg-amber-400 animate-pulse' },
  offline: { text: 'status.offline', dot: 'bg-rose-500' },
} as const

export function Sidebar({
  active,
  onSelect,
  hidden,
}: {
  active: string | null
  onSelect: (id: string) => void
  /** На телефоне список прячется, пока открыт чат */
  hidden: boolean
}) {
  const m = useMessenger()
  const conversations = useLive((m) => m.conversations(), [])
  const [dialog, setDialog] = useState<'new' | 'invite' | 'join' | 'group' | 'settings' | null>(null)
  const close = () => setDialog(null)
  const status = STATUS[m.status]

  return (
    <aside
      className={`relative min-h-0 w-full flex-col border-slate-200/70 bg-white md:flex md:border-r dark:border-white/6 dark:bg-surface-dark ${hidden ? 'hidden' : 'flex'}`}
    >
      <header className="shrink-0 bg-aurora px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-4">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[28px] leading-tight font-extrabold tracking-tight">Temp Messenger</h1>
            <p className="muted flex items-center gap-1.5 text-[13px]">
              <span className={`size-2 rounded-full ${status.dot}`} />
              {t(status.text)}
            </p>
          </div>
          <button
            className="rounded-full p-0.5 ring-2 ring-white/70 transition active:scale-95 dark:ring-white/10"
            onClick={() => setDialog('settings')}
            title={t('sidebar.settings')}
            aria-label={t('sidebar.settings')}
          >
            <Avatar name={m.profile!.name} size="sm" />
          </button>
        </div>
      </header>

      <InstallBanner />

      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-1 pb-28">
        {conversations?.length === 0 && (
          <li>
            <EmptyList onInvite={() => setDialog('invite')} onJoin={() => setDialog('join')} />
          </li>
        )}
        {conversations?.map((c) => {
          const isActive = c.id === active
          return (
            <li key={c.id}>
              <button
                className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition active:scale-[0.99] ${isActive ? 'bg-brand-soft' : 'hover:bg-slate-900/[0.03] active:bg-slate-900/5 dark:hover:bg-white/[0.04] dark:active:bg-white/8'}`}
                onClick={() => onSelect(c.id)}
              >
                <span className="relative shrink-0">
                  <Avatar name={c.title} />
                  {c.kind === 'group' && (
                    <span className="absolute -right-0.5 -bottom-0.5 grid size-5.5 place-items-center rounded-full bg-white text-violet-600 shadow ring-1 ring-slate-200 dark:bg-surface-2-dark dark:text-violet-300 dark:ring-white/10">
                      <Users className="size-3.5" aria-label={t('common.group')} />
                    </span>
                  )}
                </span>
                <span className="flex min-w-0 flex-col flex-1 gap-0.5">
                  <span className="flex items-baseline gap-2">
                    <b className="flex-1 truncate text-base font-semibold">{c.title}</b>
                    <small className={`shrink-0 text-xs ${c.unread > 0 ? 'font-semibold text-violet-600 dark:text-violet-400' : 'muted'}`}>
                      {c.lastText ? formatTime(c.lastTs) : ''}
                    </small>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="muted flex-1 truncate text-sm">{conversationPreview(c) || t('sidebar.noMessages')}</span>
                    {c.unread > 0 && (
                      <span className="grid h-5.5 min-w-5.5 place-items-center rounded-full bg-brand px-1.5 text-xs font-bold text-white shadow-md shadow-violet-500/30">
                        {c.unread}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {/* Плавающая кнопка «новый чат» — под большим пальцем */}
      <button
        className="absolute right-5 bottom-[max(1.25rem,env(safe-area-inset-bottom))] grid size-15 place-items-center rounded-[22px] bg-brand text-white shadow-xl shadow-violet-500/40 transition hover:brightness-110 active:scale-90"
        onClick={() => setDialog('new')}
        aria-label={t('sidebar.newChat')}
        title={t('sidebar.newChat')}
      >
        <MessageCirclePlus className="size-7" />
      </button>

      {dialog === 'new' && (
        <NewChatDialog
          onClose={close}
          onInvite={() => setDialog('invite')}
          onJoin={() => setDialog('join')}
          onGroup={() => setDialog('group')}
        />
      )}
      {dialog === 'group' && (
        <CreateGroupDialog
          onClose={close}
          onCreated={(gid) => {
            close()
            onSelect(gid)
          }}
        />
      )}
      {dialog === 'invite' && <CreateInviteDialog onClose={close} />}
      {dialog === 'join' && <JoinDialog onClose={close} />}
      {dialog === 'settings' && <SettingsDialog onClose={close} />}
    </aside>
  )
}

function EmptyList({ onInvite, onJoin }: { onInvite: () => void; onJoin: () => void }) {
  return (
    <div className="flex flex-col items-center px-6 pt-10 text-center">
      <div className="relative mb-5">
        <div className="absolute inset-0 rounded-[32px] bg-brand opacity-40 blur-2xl" />
        <div className="relative grid size-24 place-items-center rounded-[32px] bg-brand text-white shadow-xl">
          <MessageCirclePlus className="size-11" strokeWidth={1.75} />
        </div>
      </div>
      <p className="text-lg font-bold">{t('sidebar.empty.title')}</p>
      <p className="muted mt-1 mb-6 max-w-xs text-sm leading-relaxed">
        {t('sidebar.empty.text')}
      </p>
      <div className="grid w-full max-w-xs gap-2.5">
        <button className="btn btn-primary" onClick={onInvite}>
          <UserPlus className="size-5" /> {t('sidebar.invite')}
        </button>
        <button className="btn btn-soft" onClick={onJoin}>
          <ScanQrCode className="size-5" /> {t('sidebar.join')}
        </button>
      </div>
    </div>
  )
}

function NewChatDialog({
  onClose,
  onInvite,
  onJoin,
  onGroup,
}: {
  onClose: () => void
  onInvite: () => void
  onJoin: () => void
  onGroup: () => void
}) {
  return (
    <Modal title={t('sidebar.newChat')} onClose={onClose}>
      <div className="grid gap-2.5">
        <ChoiceRow
          icon={<UserPlus className="size-6" />}
          title={t('newChat.invite.title')}
          text={t('newChat.invite.text')}
          onClick={onInvite}
          accent
        />
        <ChoiceRow
          icon={<ScanQrCode className="size-6" />}
          title={t('newChat.join.title')}
          text={t('newChat.join.text')}
          onClick={onJoin}
        />
        <ChoiceRow
          icon={<Users className="size-6" />}
          title={t('newChat.group.title')}
          text={t('newChat.group.text')}
          onClick={onGroup}
        />
      </div>
    </Modal>
  )
}

function ChoiceRow({
  icon,
  title,
  text,
  onClick,
  accent = false,
}: {
  icon: React.ReactNode
  title: string
  text: string
  onClick: () => void
  accent?: boolean
}) {
  return (
    <button
      className="flex items-center gap-4 rounded-2xl bg-slate-900/[0.03] p-3.5 text-left transition hover:bg-slate-900/5 active:scale-[0.98] dark:bg-white/[0.04] dark:hover:bg-white/8"
      onClick={onClick}
    >
      <span
        className={`grid size-12 shrink-0 place-items-center rounded-2xl ${accent ? 'bg-brand text-white shadow-lg shadow-violet-500/30' : 'bg-violet-500/10 text-violet-600 dark:text-violet-300'}`}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-col flex-1">
        <b className="font-semibold">{title}</b>
        <span className="muted text-sm">{text}</span>
      </span>
      <ChevronRight className="size-5 text-slate-400" />
    </button>
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
    <Modal title={t('settings.title')} onClose={onClose}>
      <div className="mb-5 flex items-center gap-4 rounded-3xl bg-brand-soft p-4">
        <Avatar name={m.profile!.name} size="lg" />
        <div className="min-w-0">
          <p className="truncate text-lg font-bold">{m.profile!.name}</p>
          <p className="muted flex items-center gap-1.5 text-sm">
            <KeyRound className="size-3.5" /> {t('settings.keysHere')}
          </p>
        </div>
      </div>
      <p className="muted mb-6 text-sm leading-relaxed">
        {t('settings.storage')}
      </p>

      <LanguageSection />
      <AppSection />
      <NotificationsSection />
      <CallsSection />

      <h3 className="section-title mt-6">{t('settings.wipe.title')}</h3>
      <p className="muted mb-3 text-sm leading-relaxed">
        {t('settings.wipe.text')}
      </p>
      {!confirm ? (
        <button className="btn btn-danger w-full" onClick={() => setConfirm(true)}>
          <Trash2 className="size-5" /> {t('settings.wipe.button')}
        </button>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          <button className="btn btn-soft" onClick={() => setConfirm(false)} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-danger-solid" onClick={wipe} disabled={busy}>
            {busy ? t('settings.wipe.busy') : t('settings.wipe.confirm')}
          </button>
        </div>
      )}
    </Modal>
  )
}

function LanguageSection() {
  return (
    <>
      <h3 className="section-title">{t('settings.language')}</h3>
      <LanguagePicker className="mb-6" />
    </>
  )
}
