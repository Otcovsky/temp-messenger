import { Check, Loader2, Lock, LogOut, ShieldCheck, UserMinus, UserPlus, Users } from 'lucide-react'
import { useState } from 'react'
import { type GroupView, MAX_GROUP } from '../core/messenger'
import type { Contact } from '../storage/db'
import { Avatar } from './Avatar'
import { useLive, useMessenger } from './hooks'
import { Modal } from './Modal'

/** «3 участника», «5 участников» */
export function membersCount(n: number): string {
  const d = n % 10
  const h = n % 100
  const word = d === 1 && h !== 11 ? 'участник' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'участника' : 'участников'
  return `${n} ${word}`
}

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
    <Modal title="Новая группа" onClose={onClose}>
      {people?.length === 0 ? (
        <p className="muted pb-2 text-sm leading-relaxed">
          В группу можно позвать только тех, с кем у вас уже есть чат. Сначала пригласите хотя бы одного собеседника.
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <label className="section-title block" htmlFor="group-name">
            Название
          </label>
          <input
            id="group-name"
            className="field mb-5"
            value={name}
            maxLength={64}
            placeholder="Например, «Семья»"
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <h3 className="section-title">Участники</h3>
          <PeoplePicker people={people ?? []} picked={picked} onToggle={toggle} />
          <p className="muted mt-4 mb-4 text-sm leading-relaxed">
            Незнакомых между собой участников вы представите друг другу автоматически: у каждой пары будет свой
            шифрованный канал. До {MAX_GROUP} человек.
          </p>
          {error && <p className="note note-error mb-4">{error}</p>}
          <button className="btn btn-primary w-full" disabled={busy || !name.trim() || picked.size === 0}>
            {busy ? <Loader2 className="size-5 animate-spin" /> : <Users className="size-5" />} Создать группу
          </button>
        </form>
      )}
    </Modal>
  )
}

/** Код безопасности участника: сверить, что знакомство через администратора не подменили. */
function MemberSafety({ contactId }: { contactId: string }) {
  const safety = useLive((m) => m.safetyNumber(contactId), [contactId])
  return (
    <div className="mt-1 mb-2 ml-13 rounded-2xl bg-brand-soft p-3 text-sm">
      <p className="mb-1 flex items-center gap-1.5 font-medium">
        <ShieldCheck className="size-4" /> Код безопасности
      </p>
      <p className="font-mono tracking-wide [word-spacing:0.3em]">{safety ?? '…'}</p>
      <p className="muted mt-1.5 text-xs leading-relaxed">
        Сверьте его с этим человеком лично или по телефону: так вы убедитесь, что вас познакомили без подмены.
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
    <Modal title="О группе" onClose={onClose}>
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <Avatar name={group.title} size="xl" />
        <p className="mt-1 text-xl font-bold">{group.title}</p>
        <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
          <Lock className="size-3.5" /> сквозное шифрование · {membersCount(group.members.length + (active ? 1 : 0))}
        </p>
      </div>

      {group.left && (
        <p className="note note-warn mb-5">
          {group.left === 'removed' ? 'Администратор удалил вас из этой группы.' : 'Вы вышли из этой группы.'} Переписка
          осталась только у вас.
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
            Название (видно всем участникам)
          </label>
          <div className="flex gap-2">
            <input id="group-title" className="field" value={name ?? group.title} maxLength={64} onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-soft shrink-0" disabled={name === null || !name.trim() || name.trim() === group.title}>
              Сохранить
            </button>
          </div>
        </form>
      )}

      <h3 className="section-title">Участники</h3>
      <ul className="-mx-2 mb-4 grid gap-0.5">
        {active && (
          <li className="flex items-center gap-3 px-2 py-2">
            <Avatar name={m.profile!.name} size="sm" />
            <span className="min-w-0 flex-1 truncate font-medium">{m.profile!.name}</span>
            <small className="muted shrink-0 text-xs">{group.amAdmin ? 'вы, администратор' : 'вы'}</small>
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
                  {!x.contactId ? 'подключается…' : x.admin ? 'администратор' : ''}
                </small>
              </button>
              {group.amAdmin && active && (
                <button
                  className="btn-icon size-9 shrink-0"
                  onClick={() => void run(() => m.removeGroupMember(group.id, x.ik))}
                  aria-label={`Удалить из группы: ${x.name}`}
                  title="Удалить из группы"
                >
                  <UserMinus className="size-4.5" />
                </button>
              )}
            </div>
            {open === x.ik && x.contactId && <MemberSafety contactId={x.contactId} />}
          </li>
        ))}
      </ul>

      {group.amAdmin && active && !adding && candidates.length > 0 && (
        <button className="btn btn-soft mb-4 w-full" onClick={() => setAdding(true)}>
          <UserPlus className="size-5" /> Добавить участников
        </button>
      )}
      {adding && (
        <div className="mb-4 rounded-2xl bg-slate-900/[0.03] p-3 dark:bg-white/[0.04]">
          <PeoplePicker people={candidates} picked={picked} onToggle={toggle} />
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <button className="btn btn-soft" onClick={() => setAdding(false)}>
              Отмена
            </button>
            <button
              className="btn btn-primary"
              disabled={picked.size === 0}
              onClick={() => void run(() => m.addGroupMembers(group.id, [...picked])).then(() => setAdding(false))}
            >
              Добавить
            </button>
          </div>
        </div>
      )}

      {active && (
        <p className="muted mb-5 text-sm leading-relaxed">
          Каждое сообщение шифруется отдельно для каждого участника. Новые участники не видят прежнюю переписку. Тот, у
          кого ещё «подключается», пока не получает ваши сообщения. Состав группы меняет только администратор.
        </p>
      )}
      {error && <p className="note note-error mb-4">{error}</p>}

      {!confirm ? (
        <button className="btn btn-danger w-full" onClick={() => setConfirm(true)}>
          <LogOut className="size-5" /> {active ? 'Выйти из группы…' : 'Удалить переписку…'}
        </button>
      ) : (
        <>
          <p className="mb-3 text-sm">
            {active
              ? group.amAdmin
                ? 'Переписка удалится у вас, а управление группой перейдёт другому участнику.'
                : 'Переписка удалится у вас, участники увидят, что вы вышли.'
              : 'Переписка этой группы удалится с этого устройства.'}
          </p>
          <div className="grid grid-cols-2 gap-2.5">
            <button className="btn btn-soft" onClick={() => setConfirm(false)}>
              Отмена
            </button>
            <button
              className="btn btn-danger-solid"
              onClick={async () => {
                await m.leaveGroup(group.id)
                onClose()
                onDeleted()
              }}
            >
              {active ? 'Выйти' : 'Удалить'}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
