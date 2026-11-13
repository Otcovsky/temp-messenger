import {
  Check,
  CheckCheck,
  ChevronLeft,
  CircleAlert,
  Clock,
  Info,
  Lock,
  Paperclip,
  SendHorizontal,
  ShieldCheck,
  Trash2,
  UserX,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MAX_FILE } from '../core/messenger'
import type { Message } from '../storage/db'
import { AttachmentTray, MAX_ATTACHMENTS } from './AttachmentTray'
import { Avatar } from './Avatar'
import { FileCard, FileMessage, MediaTile, isInlineImage, isInlineMime } from './FileMessage'
import { formatDay } from './format'
import { useLive, useMessenger } from './hooks'
import { Modal } from './Modal'

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

export function ChatView({ convId, onBack, onDeleted }: { convId: string; onBack: () => void; onDeleted: () => void }) {
  const m = useMessenger()
  const contact = useLive((m) => m.contact(convId), [convId])
  const messages = useLive((m) => m.messages(convId), [convId])
  const [text, setText] = useState('')
  const [info, setInfo] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  /** Выбранные, но ещё не отправленные файлы: текст в поле станет подписью к ним */
  const [staged, setStaged] = useState<File[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  /**
   * Лента прижата к последнему сообщению: что бы ни выросло (картинки, новые сообщения,
   * клавиатура сжала экран) — низ остаётся на месте. Открепить её может только сам пользователь.
   */
  const pinned = useRef(true)
  /** Когда пользователь последний раз сам крутил ленту (колесо, палец, полоса прокрутки) */
  const userScrollAt = useRef(-Infinity)
  /** Сообщения, что уже были в чате при открытии: они появляются сразу, без анимации */
  const initial = useRef<Set<string> | null>(null)
  if (!initial.current && messages) initial.current = new Set(messages.map((msg) => msg.id))
  const count = messages?.length ?? 0

  const scrollToEnd = () => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  useLayoutEffect(() => {
    pinned.current = true
    scrollToEnd()
  }, [count])

  useEffect(() => {
    // Новое сообщение пришло, пока чат открыт
    void m.markRead(convId)
  }, [m, convId, count])

  // Высота ленты или её содержимого изменилась — если лента прижата к низу, возвращаем её туда.
  // ResizeObserver срабатывает после раскладки, но до отрисовки, так что сдвиг не успевает мелькнуть.
  const ready = !!contact && !!messages
  useLayoutEffect(() => {
    const el = listRef.current
    const content = contentRef.current
    if (!el || !content) return
    if (pinned.current) scrollToEnd()
    const ro = new ResizeObserver(() => pinned.current && scrollToEnd())
    ro.observe(el)
    ro.observe(content)
    return () => ro.disconnect()
  }, [ready])

  const userScroll = () => {
    userScrollAt.current = performance.now()
  }

  const send = async () => {
    const t = text
    const files = staged
    if (!t.trim() && !files.length) return
    setText('')
    setStaged([])
    setError('')
    try {
      if (!files.length) await m.sendText(convId, t)
      // Несколько файлов уходят альбомом — одним пузырём с общей подписью
      else await m.sendFiles(convId, files, t)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    inputRef.current?.focus()
  }

  /** Отложить файлы до отправки. Негодные (пустые, слишком большие) отсеиваем сразу. */
  const stage = (files: Iterable<File>) => {
    const ok: File[] = []
    const bad: string[] = []
    for (const f of files) {
      if (f.size > MAX_FILE) bad.push(`«${f.name}» больше ${MAX_FILE / 1024 / 1024} МБ`)
      else if (!f.size) bad.push(`«${f.name}» — пустой файл`)
      else ok.push(f)
    }
    const room = MAX_ATTACHMENTS - staged.length
    if (ok.length > room) bad.push(`за раз можно отправить не больше ${MAX_ATTACHMENTS} файлов`)
    setError(bad.length ? `Не добавлено: ${bad.join('; ')}.` : '')
    if (!ok.length || room <= 0) return
    setStaged((s) => [...s, ...ok].slice(0, MAX_ATTACHMENTS))
    // На компьютере сразу ставим курсор в поле подписи; на телефоне не открываем клавиатуру сами
    if (matchMedia('(pointer: fine)').matches) inputRef.current?.focus()
  }

  const shell = 'flex min-h-0 min-w-0 flex-1 flex-col bg-chat max-md:animate-slide-in'
  if (contact === undefined && messages === undefined) return <section className={shell} />
  if (!contact)
    return (
      <section className={`${shell} items-center justify-center`}>
        <p className="muted">Чат удалён.</p>
      </section>
    )

  const items = groupAlbums(messages ?? [])
  const canWrite = !contact.gone && !!contact.theirMailbox
  const hasFiles = (e: React.DragEvent) => canWrite && e.dataTransfer.types.includes('Files')
  const canSend = canWrite && (!!text.trim() || staged.length > 0)

  return (
    <section
      className={`${shell} relative`}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        setDragging(false)
        if (!hasFiles(e)) return
        e.preventDefault()
        stage(e.dataTransfer.files)
      }}
    >
      <header className="z-20 flex shrink-0 items-center gap-1 border-b border-slate-200/70 bg-white/85 px-1.5 pt-[env(safe-area-inset-top)] backdrop-blur-xl md:px-3 dark:border-white/6 dark:bg-surface-dark/85">
        <button className="btn-icon md:hidden" onClick={onBack} aria-label="Назад">
          <ChevronLeft className="size-7" />
        </button>
        <button className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl py-2 pr-2 text-left" onClick={() => setInfo(true)}>
          <Avatar name={contact.name} size="sm" />
          <span className="flex min-w-0 flex-col">
            <b className="truncate text-base font-semibold">{contact.name}</b>
            {contact.gone ? (
              <small className="truncate text-xs text-rose-500">удалил(а) чат</small>
            ) : (
              <small className="flex items-center gap-1 truncate text-xs text-emerald-600 dark:text-emerald-400">
                <Lock className="size-3" /> сквозное шифрование
              </small>
            )}
          </span>
        </button>
        <button className="btn-icon" onClick={() => setInfo(true)} aria-label="О чате" title="О чате">
          <Info className="size-5.5" />
        </button>
      </header>

      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-3 pt-3 pb-2 md:px-6"
        ref={listRef}
        onWheel={userScroll}
        onTouchMove={userScroll}
        onKeyDown={userScroll}
        // Нажатие на саму ленту, а не на сообщение, — это полоса прокрутки
        onPointerDown={(e) => e.target === e.currentTarget && userScroll()}
        onScroll={(e) => {
          const el = e.currentTarget
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) pinned.current = true
          // Прокрутку от подгрузки картинок и подстройки браузера за пользовательскую не считаем:
          // раньше из-за неё лента «отклеивалась» от низа и застревала посреди чата
          else if (performance.now() - userScrollAt.current < 1000) pinned.current = false
        }}
      >
        <div ref={contentRef} className="flex flex-1 flex-col">
          {messages?.length === 0 && (
            <div className="m-auto flex max-w-xs flex-col items-center gap-3 rounded-3xl bg-white/70 p-6 text-center shadow-sm backdrop-blur dark:bg-white/5">
              <div className="grid size-14 place-items-center rounded-2xl bg-brand text-white shadow-lg shadow-violet-500/30">
                <ShieldCheck className="size-7" />
              </div>
              <p className="font-semibold">Чат создан</p>
              <p className="muted text-sm leading-relaxed">
                Сообщения шифруются в браузере и расшифровываются только у собеседника.
              </p>
            </div>
          )}
          {items.map((item, i) => (
            <MessageRow
              key={item.parts[0].id}
              parts={item.parts}
              prev={items[i - 1]?.parts[0]}
              next={items[i + 1]?.parts[0]}
              onRetry={() => {
                for (const p of item.parts)
                  if (p.status === 'failed')
                    void m.retry(p.id).catch((e) => setError(e instanceof Error ? e.message : String(e)))
              }}
              animate={!initial.current?.has(item.parts[0].id)}
            />
          ))}
        </div>
      </div>

      {contact.gone && (
        <div className="flex shrink-0 items-center gap-2 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-200">
          <UserX className="size-4 shrink-0" /> Собеседник удалил этот чат. Новые сообщения не будут доставлены.
        </div>
      )}
      {error && (
        <div className="flex shrink-0 items-center gap-2 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-700 dark:text-rose-300">
          <CircleAlert className="size-4 shrink-0" /> {error}
        </div>
      )}

      <form
        className="shrink-0 border-t border-slate-200/70 bg-white/85 px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur-xl md:px-4 md:pb-3 dark:border-white/6 dark:bg-surface-dark/85"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = '' // чтобы тот же файл можно было выбрать снова
            stage(files)
          }}
        />
        {staged.length > 0 && canWrite && (
          <AttachmentTray
            files={staged}
            onRemove={(i) => setStaged((s) => s.filter((_, j) => j !== i))}
            onClear={() => setStaged([])}
            onAdd={() => fileRef.current?.click()}
          />
        )}
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 items-end rounded-[24px] bg-slate-900/[0.05] transition focus-within:bg-slate-900/[0.07] dark:bg-white/[0.06] dark:focus-within:bg-white/[0.09]">
            <button
              type="button"
              className="btn-icon"
              disabled={!canWrite}
              onClick={() => fileRef.current?.click()}
              aria-label="Прикрепить файл"
              title="Прикрепить файл"
            >
              <Paperclip className="size-5.5" />
            </button>
            <textarea
              ref={inputRef}
              rows={1}
              value={text}
              disabled={!canWrite}
              placeholder={!canWrite ? 'Писать некуда' : staged.length ? 'Добавить подпись…' : 'Сообщение'}
              className="composer-input max-h-40 min-h-11 min-w-0 flex-1 resize-none bg-transparent py-2.5 pr-4 text-base leading-6 outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500"
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                // Вставленная картинка или файл из буфера обмена встаёт в очередь на отправку
                const files = [...e.clipboardData.files]
                if (!files.length) return
                e.preventDefault()
                stage(files)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
          </div>
          <button
            className={`grid size-11 shrink-0 place-items-center rounded-full text-white transition active:scale-90 ${canSend ? 'bg-brand shadow-lg shadow-violet-500/35' : 'bg-slate-300 dark:bg-white/10 dark:text-slate-500'}`}
            disabled={!canSend}
            aria-label="Отправить"
            // Не забираем фокус у поля: иначе на телефоне клавиатура прячется после каждой отправки
            onMouseDown={(e) => e.preventDefault()}
          >
            <SendHorizontal className="size-5.5" />
          </button>
        </div>
      </form>

      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-30 grid place-items-center rounded-3xl border-2 border-dashed border-violet-500 bg-violet-500/10 backdrop-blur-sm">
          <p className="flex items-center gap-2 font-semibold text-violet-700 dark:text-violet-300">
            <Paperclip className="size-5" /> Отпустите, чтобы прикрепить
          </p>
        </div>
      )}

      {info && <ChatInfo convId={convId} onClose={() => setInfo(false)} onDeleted={onDeleted} />}
    </section>
  )
}

/**
 * Элементы ленты: обычное сообщение или альбом — файлы одной пачки. Альбом встаёт на место
 * своего первого файла, даже если между его файлами успели вклиниться другие сообщения.
 */
function groupAlbums(messages: Message[]): { parts: Message[] }[] {
  const albums = new Map<string, Message[]>()
  const key = (msg: Message) => `${msg.from}:${msg.album}`
  for (const msg of messages) {
    if (!msg.album || msg.type !== 'file') continue
    const list = albums.get(key(msg))
    if (list) list.push(msg)
    else albums.set(key(msg), [msg])
  }
  const items: { parts: Message[] }[] = []
  const placed = new Set<string>()
  for (const msg of messages) {
    if (!msg.album || msg.type !== 'file') {
      items.push({ parts: [msg] })
      continue
    }
    if (placed.has(key(msg))) continue
    placed.add(key(msg))
    items.push({ parts: albums.get(key(msg))! })
  }
  return items
}

/** Худший статус из файлов альбома: «прочитано» — только когда прочитаны все. */
const STATUS_RANK: Record<Message['status'], number> = { failed: 0, pending: 1, sent: 2, delivered: 3, read: 4, received: 5 }
const worstStatus = (parts: Message[]) =>
  parts.reduce((w, p) => (STATUS_RANK[p.status] < STATUS_RANK[w] ? p.status : w), parts[0].status)

function MessageRow({
  parts,
  prev,
  next,
  onRetry,
  animate,
}: {
  parts: Message[]
  prev?: Message
  next?: Message
  onRetry: () => void
  /** Сообщение пришло или отправлено при открытом чате — пузырь появляется с анимацией */
  animate: boolean
}) {
  const msg = parts[0]
  const mine = msg.from === 'me'
  const newDay = !prev || !sameDay(prev.ts, msg.ts)
  const groupStart = !prev || newDay || prev.from !== msg.from
  const groupEnd = !next || next.from !== msg.from || !sameDay(next.ts, msg.ts)

  // Хвостик — только у последнего пузыря в серии подряд идущих сообщений
  const shape = mine
    ? `rounded-[20px] ${groupEnd ? 'rounded-br-md' : 'rounded-br-lg'} ${groupStart ? '' : 'rounded-tr-lg'}`
    : `rounded-[20px] ${groupEnd ? 'rounded-bl-md' : 'rounded-bl-lg'} ${groupStart ? '' : 'rounded-tl-lg'}`
  const color = mine
    ? 'bg-brand text-white shadow-md shadow-violet-500/20'
    : 'bg-white text-slate-900 shadow-sm shadow-slate-900/5 dark:bg-surface-2-dark dark:text-slate-100 dark:shadow-black/20'
  const pop = animate ? 'animate-pop-in' : ''

  return (
    <>
      {newDay && (
        <div className="sticky top-1 z-10 my-3 self-center rounded-full bg-white/80 px-3 py-1 text-xs font-medium text-slate-500 shadow-sm backdrop-blur dark:bg-surface-2-dark/80 dark:text-slate-400">
          {formatDay(msg.ts)}
        </div>
      )}
      <div className={`flex ${mine ? 'justify-end' : 'justify-start'} ${groupStart ? 'mt-2' : 'mt-0.5'}`}>
        {parts.length > 1 ? (
          <AlbumBubble parts={parts} mine={mine} className={`${shape} ${color} ${pop}`} onRetry={onRetry} />
        ) : (
          <SingleBubble msg={msg} mine={mine} shape={`${shape} ${pop}`} color={color} onRetry={onRetry} />
        )}
      </div>
    </>
  )
}

function SingleBubble({
  msg,
  mine,
  shape,
  color,
  onRetry,
}: {
  msg: Message
  mine: boolean
  shape: string
  color: string
  onRetry: () => void
}) {
  const isFile = msg.type === 'file' && !!msg.file
  const isImage = isFile && isInlineImage(msg)
  const caption = isFile ? msg.text : ''
  /** Картинка без подписи: пузырь — тонкая рамка, время поверх картинки */
  const bare = isImage && !caption
  return (
    <div
      className={`relative max-w-[min(560px,82%)] ${shape} ${bare ? 'bg-slate-200 p-0.5 shadow-sm dark:bg-surface-2-dark' : color} ${isImage ? (caption ? 'p-1' : '') : isFile ? 'p-1.5' : 'px-3.5 py-2'}`}
    >
      {isFile ? <FileMessage msg={msg} /> : <span className={TEXT}>{msg.text}</span>}
      {caption ? (
        // Подпись внутри того же пузыря, что и файл. Под картинкой не шире её самой
        <div className={`px-2 pt-1.5 pb-1 ${isImage ? 'w-0 min-w-full' : ''}`}>
          <span className={TEXT}>{caption}</span>
          <Meta msg={msg} mine={mine} onRetry={onRetry} />
        </div>
      ) : (
        <Meta msg={msg} mine={mine} onRetry={onRetry} overlay={bare} inset={isFile} />
      )}
    </div>
  )
}

/**
 * Альбом: картинки сеткой (нечётное число — первая на всю ширину), остальные файлы списком,
 * подпись внизу. Время — последнего файла, статус — худший из всех.
 */
function AlbumBubble({
  parts,
  mine,
  className,
  onRetry,
}: {
  parts: Message[]
  mine: boolean
  className: string
  onRetry: () => void
}) {
  const showable = (p: Message) => isInlineMime(p.file!.mime) && p.file!.state !== 'gone' && p.file!.state !== 'error'
  const media = parts.filter(showable)
  const docs = parts.filter((p) => !showable(p))
  const caption = parts.find((p) => p.text)?.text ?? ''
  const summary = { ...parts[parts.length - 1], status: worstStatus(parts) }
  const odd = media.length % 2 === 1

  return (
    <div
      className={`relative p-1 ${className} ${media.length ? 'w-[min(320px,75vw)]' : 'max-w-[min(560px,82%)]'}`}
    >
      {media.length > 0 && (
        <div className="grid grid-cols-2 gap-0.5 overflow-hidden rounded-[16px]">
          {media.map((p, i) => (
            <MediaTile
              key={p.id}
              msg={p}
              className={odd && i === 0 ? (media.length === 1 ? 'col-span-2 aspect-[4/3]' : 'col-span-2 aspect-[2/1]') : 'aspect-square'}
            />
          ))}
        </div>
      )}
      {docs.length > 0 && (
        <div className={`flex flex-col gap-0.5 px-0.5 ${media.length ? 'pt-1.5' : 'pt-0.5'}`}>
          {docs.map((p) => (
            <FileCard key={p.id} msg={p} />
          ))}
        </div>
      )}
      {caption ? (
        <div className="px-2 pt-1.5 pb-1">
          <span className={TEXT}>{caption}</span>
          <Meta msg={summary} mine={mine} onRetry={onRetry} />
        </div>
      ) : (
        <Meta msg={summary} mine={mine} onRetry={onRetry} overlay={!docs.length} inset={!!docs.length} />
      )}
    </div>
  )
}

const TEXT = 'text-[15.5px] leading-[1.4] break-words whitespace-pre-wrap [overflow-wrap:anywhere]'

/** Время и статус доставки: в углу пузыря или (у картинки без подписи) поверх неё. */
function Meta({
  msg,
  mine,
  onRetry,
  overlay = false,
  inset = false,
}: {
  msg: Message
  mine: boolean
  onRetry: () => void
  overlay?: boolean
  inset?: boolean
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] tabular-nums ${
        overlay
          ? 'absolute right-3 bottom-3 rounded-full bg-black/45 px-2 py-0.5 text-white backdrop-blur-sm'
          : `float-right ml-2.5 translate-y-1.5 ${inset ? 'mr-1.5 mb-0.5' : ''} ${mine ? 'text-white/75' : 'text-slate-400 dark:text-slate-500'}`
      }`}
    >
      {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      {mine && <StatusMark status={msg.status} onRetry={onRetry} />}
    </span>
  )
}

function StatusMark({ status, onRetry }: { status: Message['status']; onRetry: () => void }) {
  const cls = 'size-3.5'
  switch (status) {
    case 'pending':
      return <Clock className={cls} aria-label="Ожидает отправки" />
    case 'sent':
      return <Check className={cls} aria-label="Отправлено на сервер" />
    case 'delivered':
      return <CheckCheck className={cls} aria-label="Доставлено" />
    case 'read':
      return <CheckCheck className={`${cls} text-cyan-200`} strokeWidth={2.75} aria-label="Прочитано" />
    case 'failed':
      return (
        <button
          className="inline-flex items-center gap-1 rounded-full bg-rose-500 px-2 py-0.5 font-semibold text-white"
          title="Не отправлено — повторить"
          onClick={onRetry}
        >
          <CircleAlert className="size-3" /> повторить
        </button>
      )
    default:
      return null
  }
}

function ChatInfo({ convId, onClose, onDeleted }: { convId: string; onClose: () => void; onDeleted: () => void }) {
  const m = useMessenger()
  const contact = useLive((m) => m.contact(convId), [convId])
  const safety = useLive((m) => m.safetyNumber(convId), [convId])
  const [name, setName] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)

  if (!contact) return null
  return (
    <Modal title="О чате" onClose={onClose}>
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <Avatar name={contact.name} size="xl" />
        <p className="mt-1 text-xl font-bold">{contact.name}</p>
        <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
          <Lock className="size-3.5" /> сквозное шифрование
        </p>
      </div>

      <form
        className="mb-6"
        onSubmit={(e) => {
          e.preventDefault()
          if (name?.trim()) void m.renameContact(convId, name).then(() => setName(null))
        }}
      >
        <label className="section-title block" htmlFor="contact-name">
          Имя собеседника (видно только вам)
        </label>
        <div className="flex gap-2">
          <input
            id="contact-name"
            className="field"
            value={name ?? contact.name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn btn-soft shrink-0" disabled={name === null || !name.trim()}>
            Сохранить
          </button>
        </div>
      </form>

      <h3 className="section-title flex items-center gap-1.5">
        <ShieldCheck className="size-4" /> Код безопасности
      </h3>
      <p className="mb-2 rounded-2xl bg-brand-soft p-4 text-center font-mono text-lg font-medium tracking-wide [word-spacing:0.45em]">
        {safety ?? '…'}
      </p>
      <p className="muted mb-6 text-sm leading-relaxed">
        Сверьте этот код с собеседником при встрече или по телефону. Если коды совпадают, никто не вклинился между вами.
      </p>

      {!confirm ? (
        <button className="btn btn-danger w-full" onClick={() => setConfirm(true)}>
          <Trash2 className="size-5" /> Удалить чат…
        </button>
      ) : (
        <>
          <p className="mb-3 text-sm">Переписка удалится у вас, собеседник получит уведомление, что чат закрыт.</p>
          <div className="grid grid-cols-2 gap-2.5">
            <button className="btn btn-soft" onClick={() => setConfirm(false)}>
              Отмена
            </button>
            <button
              className="btn btn-danger-solid"
              onClick={async () => {
                await m.deleteConversation(convId)
                onClose()
                onDeleted()
              }}
            >
              Удалить
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
