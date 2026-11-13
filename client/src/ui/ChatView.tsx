import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Message } from '../storage/db'
import { FileMessage } from './FileMessage'
import { formatDay } from './format'
import { useLive, useMessenger } from './hooks'
import { Modal } from './Modal'
import { Avatar } from './Sidebar'

export function ChatView({ convId, onBack, onDeleted }: { convId: string; onBack: () => void; onDeleted: () => void }) {
  const m = useMessenger()
  const contact = useLive((m) => m.contact(convId), [convId])
  const messages = useLive((m) => m.messages(convId), [convId])
  const [text, setText] = useState('')
  const [info, setInfo] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  /** Список прокручен до конца: тогда новые сообщения и подгрузившиеся картинки его не сдвигают вверх */
  const atBottom = useRef(true)
  const count = messages?.length ?? 0

  const scrollToEnd = () => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  useLayoutEffect(scrollToEnd, [count])

  useEffect(() => {
    // Новое сообщение пришло, пока чат открыт
    void m.markRead(convId)
  }, [m, convId, count])

  const send = async () => {
    const t = text
    if (!t.trim()) return
    setText('')
    setError('')
    try {
      await m.sendText(convId, t)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    inputRef.current?.focus()
  }

  const sendFiles = async (files: Iterable<File>) => {
    setError('')
    for (const f of files) {
      try {
        await m.sendFile(convId, f)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    }
  }

  if (contact === undefined && messages === undefined) return <section className="chat" />
  if (!contact) return <section className="chat empty"><p>Чат удалён.</p></section>

  const canWrite = !contact.gone && !!contact.theirMailbox
  const hasFiles = (e: React.DragEvent) => canWrite && e.dataTransfer.types.includes('Files')

  return (
    <section
      className={dragging ? 'chat dragging' : 'chat'}
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
        void sendFiles(e.dataTransfer.files)
      }}
    >
      <header className="chat-head">
        <button className="icon back" onClick={onBack} aria-label="Назад">
          ←
        </button>
        <Avatar name={contact.name} />
        <button className="chat-title" onClick={() => setInfo(true)}>
          <b>{contact.name}</b>
          <small className="muted">{contact.gone ? 'удалил(а) чат' : 'сквозное шифрование · о чате'}</small>
        </button>
      </header>

      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {messages?.length === 0 && (
          <p className="muted center small">
            Чат создан. Сообщения шифруются в браузере и расшифровываются только у собеседника.
          </p>
        )}
        {messages?.map((msg, i) => (
          <MessageRow
            key={msg.id}
            msg={msg}
            prev={messages[i - 1]}
            onRetry={() => void m.retry(msg.id).catch((e) => setError(e instanceof Error ? e.message : String(e)))}
            onMediaLoad={() => atBottom.current && scrollToEnd()}
          />
        ))}
      </div>

      {contact.gone && <div className="banner">Собеседник удалил этот чат. Новые сообщения не будут доставлены.</div>}
      {error && <div className="banner error">{error}</div>}

      <form
        className="composer"
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
            void sendFiles(files)
          }}
        />
        <button
          type="button"
          className="icon attach"
          disabled={!canWrite}
          onClick={() => fileRef.current?.click()}
          aria-label="Прикрепить файл"
          title="Прикрепить файл"
        >
          📎
        </button>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          disabled={!canWrite}
          placeholder={canWrite ? 'Сообщение' : 'Писать некуда'}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            // Вставленная картинка или файл из буфера обмена уходит как файл
            const files = [...e.clipboardData.files]
            if (!files.length) return
            e.preventDefault()
            void sendFiles(files)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button className="primary" disabled={!canWrite || !text.trim()} aria-label="Отправить">
          ➤
        </button>
      </form>

      {info && <ChatInfo convId={convId} onClose={() => setInfo(false)} onDeleted={onDeleted} />}
    </section>
  )
}

function MessageRow({
  msg,
  prev,
  onRetry,
  onMediaLoad,
}: {
  msg: Message
  prev?: Message
  onRetry: () => void
  onMediaLoad: () => void
}) {
  const mine = msg.from === 'me'
  const newDay = !prev || new Date(prev.ts).toDateString() !== new Date(msg.ts).toDateString()
  return (
    <>
      {newDay && <div className="day">{formatDay(msg.ts)}</div>}
      <div className={mine ? 'msg mine' : 'msg'}>
        <div className={msg.type === 'file' ? 'bubble file' : 'bubble'}>
          {msg.type === 'file' && msg.file ? (
            <FileMessage msg={msg} onMediaLoad={onMediaLoad} />
          ) : (
            <span className="text">{msg.text}</span>
          )}
          <span className="meta">
            {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {mine && <StatusMark status={msg.status} onRetry={onRetry} />}
          </span>
        </div>
      </div>
    </>
  )
}

function StatusMark({ status, onRetry }: { status: Message['status']; onRetry: () => void }) {
  switch (status) {
    case 'pending':
      return <span className="st" title="Ожидает отправки">🕓</span>
    case 'sent':
      return <span className="st" title="Отправлено на сервер">✓</span>
    case 'delivered':
      return <span className="st" title="Доставлено">✓✓</span>
    case 'read':
      return <span className="st read" title="Прочитано">✓✓</span>
    case 'failed':
      return (
        <button className="st failed" title="Не отправлено — повторить" onClick={onRetry}>
          ⚠ повторить
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
      <label>
        Имя собеседника (видно только вам)
        <div className="link-row">
          <input value={name ?? contact.name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          <button disabled={name === null || !name.trim()} onClick={() => m.renameContact(convId, name!).then(() => setName(null))}>
            Сохранить
          </button>
        </div>
      </label>

      <h3>Код безопасности</h3>
      <p className="safety">{safety ?? '…'}</p>
      <p className="muted small">
        Сверьте этот код с собеседником при встрече или по телефону. Если коды совпадают, никто не вклинился между вами.
      </p>

      <hr />
      {!confirm ? (
        <button className="danger" onClick={() => setConfirm(true)}>
          Удалить чат…
        </button>
      ) : (
        <>
          <p className="small">Переписка удалится у вас, собеседник получит уведомление, что чат закрыт.</p>
          <div className="actions">
            <button onClick={() => setConfirm(false)}>Отмена</button>
            <button
              className="danger"
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
