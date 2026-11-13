import { Check, ClipboardPaste, Copy, Link2, Loader2, ScanQrCode, Share2, Sparkles, X } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useMemo, useState } from 'react'
import { type InvitePayload, type PendingInvite, decodeInvite } from '../crypto/handshake'
import { Avatar } from './Avatar'
import { useLive, useMessenger } from './hooks'
import { Modal } from './Modal'
import { QrScanner } from './QrScanner'

export function CreateInviteDialog({ onClose }: { onClose: () => void }) {
  const m = useMessenger()
  const [invite, setInvite] = useState<PendingInvite | null>(null)
  const [qr, setQr] = useState<string>('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useLive((m) => m.listInvites(), [])

  const create = async () => {
    setBusy(true)
    setError('')
    try {
      setInvite(await m.createInvite())
    } catch (e) {
      console.error('Не удалось создать приглашение', e)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const link = invite ? m.inviteLink(invite) : ''

  useEffect(() => {
    if (link)
      QRCode.toDataURL(link, { margin: 1, width: 260, errorCorrectionLevel: 'M' })
        .then(setQr)
        .catch((e) => {
          console.error('Не удалось нарисовать QR-код', e)
          setError(`QR-код не получился (${e instanceof Error ? e.message : e}). Ссылку можно скопировать.`)
        })
  }, [link])

  const copy = async () => {
    await navigator.clipboard.writeText(link)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // На телефоне удобнее сразу отправить ссылку через системное меню «Поделиться»
  const canShare = typeof navigator.share === 'function'
  const share = () =>
    navigator.share({ title: 'Приглашение в Temp Messenger', url: link }).catch(() => {
      /* пользователь закрыл меню */
    })

  return (
    <Modal title="Пригласить собеседника" onClose={onClose}>
      {!invite ? (
        <>
          <div className="mb-5 flex flex-col items-center gap-3 pt-2 text-center">
            <div className="grid size-16 place-items-center rounded-3xl bg-brand text-white shadow-xl shadow-violet-500/30">
              <Link2 className="size-8" />
            </div>
            <p className="muted text-sm leading-relaxed">
              Создайте ссылку и передайте её собеседнику любым способом: лично (QR-код), в другом мессенджере, по
              почте. Ссылка одноразовая — по ней можно добавить только одного человека.
            </p>
          </div>
          <button className="btn btn-primary w-full" onClick={create} disabled={busy}>
            {busy ? <Loader2 className="size-5 animate-spin" /> : <Sparkles className="size-5" />}
            {busy ? 'Создаю…' : 'Создать ссылку'}
          </button>
          {error && <p className="note note-error mt-3">{error}</p>}
        </>
      ) : (
        <div className="flex flex-col items-center gap-4">
          {qr && (
            <div className="rounded-[28px] bg-brand p-1.5 shadow-xl shadow-violet-500/25">
              <img className="block rounded-[22px] bg-white p-2" src={qr} alt="QR-код приглашения" width={232} height={232} />
            </div>
          )}
          {error && <p className="note note-error w-full">{error}</p>}
          <input
            className="field text-center text-sm text-slate-500 dark:text-slate-400"
            readOnly
            value={link}
            onFocus={(e) => e.target.select()}
          />
          <div className={`grid w-full gap-2.5 ${canShare ? 'grid-cols-2' : ''}`}>
            <button className={`btn ${canShare ? 'btn-soft' : 'btn-primary'}`} onClick={copy}>
              {copied ? <Check className="size-5" /> : <Copy className="size-5" />}
              {copied ? 'Скопировано' : 'Копировать'}
            </button>
            {canShare && (
              <button className="btn btn-primary" onClick={share}>
                <Share2 className="size-5" /> Поделиться
              </button>
            )}
          </div>
          <p className="muted text-center text-sm leading-relaxed">
            Чат появится, когда собеседник откроет ссылку. Действует 30 дней. Код безопасности потом можно сверить в
            окне чата.
          </p>
        </div>
      )}

      {!!pending?.length && (
        <div className="mt-6">
          <h3 className="section-title">Ожидают ответа</h3>
          <ul className="grid gap-1.5">
            {pending.map((p) => (
              <li
                key={p.mailbox}
                className="flex items-center justify-between gap-3 rounded-2xl bg-slate-900/[0.03] py-1.5 pr-1.5 pl-4 text-sm dark:bg-white/[0.04]"
              >
                <span className="muted">
                  {new Date(p.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                </span>
                <button className="btn btn-sm btn-danger" onClick={() => m.cancelInvite(p.mailbox)}>
                  <X className="size-4" /> Отозвать
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  )
}

/** Подключиться по чужому приглашению: вставить ссылку или отсканировать QR-код. */
export function JoinDialog({ onClose }: { onClose: () => void }) {
  const [pasted, setPasted] = useState('')
  const [pasteError, setPasteError] = useState('')
  const [scanning, setScanning] = useState(false)

  const openCode = (text: string) => {
    const match = text.match(/#i=([A-Za-z0-9_-]+)/)
    const code = match ? match[1] : text.trim()
    try {
      decodeInvite(code)
      location.hash = `i=${code}` // App подхватит через hashchange
      onClose()
    } catch {
      setPasteError('Это не похоже на ссылку-приглашение')
    }
  }

  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText()
      if (t) {
        setPasted(t)
        openCode(t)
      }
    } catch {
      setPasteError('Браузер не дал прочитать буфер обмена — вставьте ссылку в поле вручную')
    }
  }

  if (scanning) {
    return (
      <QrScanner
        onClose={() => setScanning(false)}
        onResult={(text) => {
          setScanning(false)
          openCode(text)
        }}
      />
    )
  }

  return (
    <Modal title="Присоединиться к чату" onClose={onClose}>
      <p className="muted mb-5 text-sm leading-relaxed">
        Откройте ссылку-приглашение, которую вам прислал собеседник, или отсканируйте его QR-код.
      </p>
      <button className="btn btn-primary mb-5 h-14 w-full text-base" onClick={() => setScanning(true)}>
        <ScanQrCode className="size-6" /> Сканировать QR-код
      </button>
      <div className="muted mb-5 flex items-center gap-3 text-xs font-semibold tracking-wider uppercase">
        <span className="h-px flex-1 bg-slate-200 dark:bg-white/10" />
        или ссылкой
        <span className="h-px flex-1 bg-slate-200 dark:bg-white/10" />
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (pasted.trim()) openCode(pasted)
        }}
      >
        <input
          className="field"
          value={pasted}
          onChange={(e) => {
            setPasted(e.target.value)
            setPasteError('')
          }}
          placeholder="Ссылка-приглашение"
        />
        {pasted.trim() ? (
          <button type="submit" className="btn btn-soft shrink-0">
            Открыть
          </button>
        ) : (
          typeof navigator.clipboard?.readText === 'function' && (
            <button type="button" className="btn btn-soft shrink-0 px-4" onClick={paste} aria-label="Вставить из буфера">
              <ClipboardPaste className="size-5" />
            </button>
          )
        )}
      </form>
      {pasteError && <p className="note note-error mt-3">{pasteError}</p>}
    </Modal>
  )
}

export function AcceptInviteDialog({
  code,
  onClose,
  onAccepted,
}: {
  code: string
  onClose: () => void
  onAccepted: (convId: string) => void
}) {
  const m = useMessenger()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // null — ещё проверяем, '' — приглашение живо, иначе причина, почему принять нельзя
  const [problem, setProblem] = useState<string | null>(null)
  const invite = useMemo<InvitePayload | null>(() => {
    try {
      return decodeInvite(code)
    } catch {
      return null
    }
  }, [code])

  useEffect(() => {
    if (!invite) return
    let cancelled = false
    ;(async () => {
      // Ссылку открыли повторно, а чат уже есть — просто открываем его
      const existing = await m.existingChatForInvite(invite)
      if (cancelled) return
      if (existing) return onAccepted(existing)
      const p = await m.checkInvite(invite).catch((e) => (e instanceof Error ? e.message : String(e)))
      if (!cancelled) setProblem(p ?? '')
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, invite])

  const accept = async () => {
    if (!invite) return
    setBusy(true)
    try {
      onAccepted(await m.acceptInvite(invite))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal title="Приглашение в чат" onClose={onClose}>
      {!invite ? (
        <p className="note note-error">Ссылка повреждена или неполная.</p>
      ) : problem === null ? (
        <p className="muted flex items-center justify-center gap-2 py-8">
          <Loader2 className="size-5 animate-spin" /> Проверяю приглашение…
        </p>
      ) : problem ? (
        <>
          <p className="note note-error mb-4">{problem}</p>
          <button className="btn btn-soft w-full" onClick={onClose}>
            Закрыть
          </button>
        </>
      ) : (
        <>
          <div className="mb-5 flex flex-col items-center gap-2 pt-2 text-center">
            <Avatar name={invite.n || '?'} size="xl" />
            <p className="mt-2 text-lg">
              <b>{invite.n || 'Без имени'}</b> приглашает вас
              <br />в зашифрованный чат
            </p>
            <p className="muted text-sm leading-relaxed">
              Имя указал сам пригласивший. Убедиться, что это он, можно сверив код безопасности.
            </p>
          </div>
          {error && <p className="note note-error mb-4">{error}</p>}
          <div className="grid grid-cols-2 gap-2.5">
            <button className="btn btn-soft" onClick={onClose}>
              Отклонить
            </button>
            <button className="btn btn-primary" onClick={accept} disabled={busy}>
              {busy && <Loader2 className="size-5 animate-spin" />}
              {busy ? 'Подключаю…' : 'Принять'}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
