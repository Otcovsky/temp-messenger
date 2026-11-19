import { Check, Loader2, Lock, LogOut, ShieldCheck, Trash2, UserMinus, UserPlus, Users } from 'lucide-react'
import { useState } from 'react'
import { t } from '../i18n'
import { type GroupView, MAX_GROUP } from '../core/messenger'
import type { Contact } from '../storage/db'
import { Avatar } from './Avatar'
import { ContactNameForm } from './ContactName'
import { useLive, useMessenger } from './hooks'
import { Modal } from './Modal'

/** «3 участника», «5 участников» */
export const membersCount = (n: number): string => t('group.members', { n })

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Список людей с галочками. */
function PeoplePicker({
  people,
  picked,
  onToggle,
}: {
  people: Contact[]
  picked: Set<string>
  onToggle: (id: string) => void
}) {
  return (
    <ul className="-mx-2 grid max-h-[40dvh] gap-0.5 overflow-y-auto">
      {people.map((p) => {
        const on = picked.has(p.id)
        return (
          <li key={p.id}>
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              className={`flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left transition ${on ? 'bg-brand-soft' : 'hover:bg-slate-900/[0.03] dark:hover:bg-white/[0.04]'}`}
              onClick={() => onToggle(p.id)}
            >
              <Avatar name={p.name} size="sm" />
              <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
              <span
                className={`grid size-6 shrink-0 place-items-center rounded-full border-2 ${on ? 'border-transparent bg-brand text-white' : 'border-slate-300 dark:border-white/20'}`}
              >
                {on && <Check className="size-4" strokeWidth={3} />}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function useSelection() {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s)
      if (!next.delete(id)) next.add(id)
      return next
    })
  return { picked, toggle }
}

/** Создание группы: название и участники из своих собеседников. */
export function CreateGroupDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (gid: string) => void }) {
  const m = useMessenger()
  const people = useLive((m) => m.people(), [])
  const { picked, toggle } = useSelection()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const create = async () => {
    setBusy(true)
    setError('')
    try {
      onCreated(await m.createGroup(name, [...picked]))
    } catch (e) {
      setError(message(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={t('group.new')} onClose={onClose}>
      {people?.length === 0 ? (
        <p className="muted pb-2 text-sm leading-relaxed">
          {t('group.needContacts')}
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <label className="section-title block" htmlFor="group-name">
            {t('group.name')}
          </label>
          <input
            id="group-name"
            className="field mb-5"
            value={name}
            maxLength={64}
            placeholder={t('group.namePlaceholder')}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <h3 className="section-title">{t('group.membersTitle')}</h3>
          <PeoplePicker people={people ?? []} picked={picked} onToggle={toggle} />
          <p className="muted mt-4 mb-4 text-sm leading-relaxed">
            {t('group.pairwise', { max: MAX_GROUP })}
          </p>
          {error && <p className="note note-error mb-4">{error}</p>}
          <button className="btn btn-primary w-full" disabled={busy || !name.trim() || picked.size === 0}>
            {busy ? <Loader2 className="size-5 animate-spin" /> : <Users className="size-5" />} {t('group.create')}
          </button>
        </form>
      )}
    </Modal>
  )
}

/**
 * Раскрытый участник: своё имя для него (если несколько человек назвались одинаково) и код безопасности —
 * сверить, что знакомство через администратора не подменили.
 */
function MemberDetails({ member, contactId }: { member: GroupView['members'][number]; contactId: string }) {
  const safety = useLive((m) => m.safetyNumber(contactId), [contactId])
  return (
    <div className="mt-1 mb-2 ml-13 rounded-2xl bg-brand-soft p-3 text-sm">
      <ContactNameForm className="mb-3" contactId={contactId} name={member.name} selfName={member.selfName} />
      <p className="mb-1 flex items-center gap-1.5 font-medium">
        <ShieldCheck className="size-4" /> {t('common.safetyCode')}
      </p>
      <p className="font-mono tracking-wide [word-spacing:0.3em]">{safety ?? '…'}</p>
      <p className="muted mt-1.5 text-xs leading-relaxed">
        {t('group.memberSafetyHint')}
      </p>
    </div>
  )
}

/** Сведения о группе: участники, управление (для администратора), выход. */
export function GroupInfoDialog({ group, onClose, onDeleted }: { group: GroupView; onClose: () => void; onDeleted: () => void }) {
  const m = useMessenger()
  const people = useLive((m) => m.people(), [])
  const { picked, toggle } = useSelection()
  const [name, setName] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState('')
  const active = !group.left
  /** Создатель не выходит из группы, а удаляет её у всех */
  const owner = group.amAdmin && active

  const run = async (fn: () => Promise<void>) => {
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(message(e))
    }
  }
  const candidates = (people ?? []).filter((p) => !group.members.some((x) => x.ik === p.ik))

  return (
    <Modal title={t('group.about')} onClose={onClose}>
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <Avatar name={group.title} size="xl" />
        <p className="mt-1 text-xl font-bold">{group.title}</p>
        <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
          <Lock className="size-3.5" /> {t('common.e2e')} · {membersCount(group.members.length + (active ? 1 : 0))}
        </p>
      </div>

      {group.left && (
        <p className="note note-warn mb-5">
          {group.left === 'removed' ? t('group.removedYou') : t('group.youLeft')} {t('group.historyStays')}
        </p>
      )}

      {group.amAdmin && active && (
        <form
          className="mb-6"
          onSubmit={(e) => {
            e.preventDefault()
            if (name?.trim()) void run(() => m.renameGroup(group.id, name).then(() => setName(null)))
          }}
        >
          <label className="section-title block" htmlFor="group-title">
            {t('group.titleLabel')}
          </label>
          <div className="flex gap-2">
            <input id="group-title" className="field" value={name ?? group.title} maxLength={64} onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-soft shrink-0" disabled={name === null || !name.trim() || name.trim() === group.title}>
              {t('common.save')}
            </button>
          </div>
        </form>
      )}

      <h3 className="section-title">{t('group.membersTitle')}</h3>
      {group.members.some((x) => x.contactId) && (
        <p className="muted -mt-1 mb-2 text-xs">{t('group.tapMember')}</p>
      )}
      <ul className="-mx-2 mb-4 grid gap-0.5">
        {active && (
          <li className="flex items-center gap-3 px-2 py-2">
            <Avatar name={m.profile!.name} size="sm" />
            <span className="min-w-0 flex-1 truncate font-medium">{m.profile!.name}</span>
            <small className="muted shrink-0 text-xs">{group.amAdmin ? t('group.youCreator') : t('group.you')}</small>
          </li>
        )}
        {group.members.map((x) => (
          <li key={x.ik}>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-2 py-2 text-left transition hover:bg-slate-900/[0.03] disabled:hover:bg-transparent dark:hover:bg-white/[0.04]"
                disabled={!x.contactId}
                aria-expanded={open === x.ik}
                onClick={() => setOpen(open === x.ik ? null : x.ik)}
              >
                <Avatar name={x.name} size="sm" />
                <span className="min-w-0 flex-1 truncate font-medium">{x.name}</span>
                <small className={`shrink-0 text-xs ${x.contactId ? 'muted' : 'text-amber-600 dark:text-amber-400'}`}>
                  {!x.contactId ? t('group.connecting') : x.admin ? t('group.creator') : ''}
                </small>
              </button>
              {group.amAdmin && active && (
                <button
                  className="btn-icon size-9 shrink-0"
                  onClick={() => void run(() => m.removeGroupMember(group.id, x.ik))}
                  aria-label={t('group.removeMemberNamed', { name: x.name })}
                  title={t('group.removeMember')}
                >
                  <UserMinus className="size-4.5" />
                </button>
              )}
            </div>
            {open === x.ik && x.contactId && <MemberDetails member={x} contactId={x.contactId} />}
          </li>
        ))}
      </ul>

      {group.amAdmin && active && !adding && candidates.length > 0 && (
        <button className="btn btn-soft mb-4 w-full" onClick={() => setAdding(true)}>
          <UserPlus className="size-5" /> {t('group.addMembers')}
        </button>
      )}
      {adding && (
        <div className="mb-4 rounded-2xl bg-slate-900/[0.03] p-3 dark:bg-white/[0.04]">
          <PeoplePicker people={candidates} picked={picked} onToggle={toggle} />
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <button className="btn btn-soft" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary"
              disabled={picked.size === 0}
              onClick={() => void run(() => m.addGroupMembers(group.id, [...picked])).then(() => setAdding(false))}
            >
              {t('common.add')}
            </button>
          </div>
        </div>
      )}

      {active && (
        <p className="muted mb-5 text-sm leading-relaxed">
          {t('group.explain')}
        </p>
      )}
      {error && <p className="note note-error mb-4">{error}</p>}

      {!confirm ? (
        <button className="btn btn-danger w-full" onClick={() => setConfirm(true)}>
          {owner ? <Trash2 className="size-5" /> : <LogOut className="size-5" />}{' '}
          {owner ? t('group.delete') : active ? t('group.leave') : t('group.deleteHistory')}
        </button>
      ) : (
        <>
          <p className="mb-3 text-sm">
            {owner
              ? t('group.deleteConfirm')
              : active
                ? t('group.leaveConfirm')
                : t('group.deleteHistoryConfirm')}
          </p>
          <div className="grid grid-cols-2 gap-2.5">
            <button className="btn btn-soft" onClick={() => setConfirm(false)}>
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-danger-solid"
              onClick={() =>
                void run(async () => {
                  await (owner ? m.deleteGroup(group.id) : m.leaveGroup(group.id))
                  onClose()
                  onDeleted()
                })
              }
            >
              {owner ? t('group.deleteForAll') : active ? t('group.leaveShort') : t('common.delete')}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
