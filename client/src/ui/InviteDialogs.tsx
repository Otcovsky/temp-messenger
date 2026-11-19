import { Check, ClipboardPaste, Copy, Link2, Loader2, ScanQrCode, Share2, Sparkles, X } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useMemo, useState } from 'react'
import { type InvitePayload, type PendingInvite, decodeInvite } from '../crypto/handshake'
import { shareLinkNative } from '../native'
import { getLang, t } from '../i18n'
import { rich } from '../i18n/react'
import { isNativeApp } from '../platform'
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
          setError(t('invite.qrFailed', { why: e instanceof Error ? e.message : String(e) }))
        })
  }, [link])

  const copy = async () => {
    await navigator.clipboard.writeText(link)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // На телефоне удобнее сразу отправить ссылку через системное меню «Поделиться»
  const canShare = isNativeApp || typeof navigator.share === 'function'
  const share = () =>
    isNativeApp
      ? shareLinkNative(t('invite.shareTitle'), link)
      : navigator.share({ title: t('invite.shareTitle'), url: link }).catch(() => {
          /* пользователь закрыл меню */
        })

  return (
    <Modal title={t('invite.title')} onClose={onClose}>
      {!invite ? (
        <>
          <div className="mb-5 flex flex-col items-center gap-3 pt-2 text-center">
            <div className="grid size-16 place-items-center rounded-3xl bg-brand text-white shadow-xl shadow-violet-500/30">
              <Link2 className="size-8" />
            </div>
            <p className="muted text-sm leading-relaxed">
              {t('invite.explain')}
            </p>
          </div>
          <button className="btn btn-primary w-full" onClick={create} disabled={busy}>
            {busy ? <Loader2 className="size-5 animate-spin" /> : <Sparkles className="size-5" />}
            {busy ? t('invite.creating') : t('invite.create')}
          </button>
          {error && <p className="note note-error mt-3">{error}</p>}
        </>
      ) : (
        <div className="flex flex-col items-center gap-4">
          {qr && (
            <div className="rounded-[28px] bg-brand p-1.5 shadow-xl shadow-violet-500/25">
              <img className="block rounded-[22px] bg-white p-2" src={qr} alt={t('invite.qrAlt')} width={232} height={232} />
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
              {copied ? t('invite.copied') : t('invite.copy')}
            </button>
            {canShare && (
              <button className="btn btn-primary" onClick={share}>
                <Share2 className="size-5" /> {t('invite.share')}
              </button>
            )}
          </div>
          <p className="muted text-center text-sm leading-relaxed">
            {t('invite.after')}
          </p>
        </div>
      )}

      {!!pending?.length && (
        <div className="mt-6">
          <h3 className="section-title">{t('invite.pending')}</h3>
          <ul className="grid gap-1.5">
            {pending.map((p) => (
              <li
                key={p.mailbox}
                className="flex items-center justify-between gap-3 rounded-2xl bg-slate-900/[0.03] py-1.5 pr-1.5 pl-4 text-sm dark:bg-white/[0.04]"
              >
                <span className="muted">
                  {new Date(p.createdAt).toLocaleString(getLang(), { dateStyle: 'short', timeStyle: 'short' })}
                </span>
                <button className="btn btn-sm btn-danger" onClick={() => m.cancelInvite(p.mailbox)}>
                  <X className="size-4" /> {t('invite.revoke')}
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
      setPasteError(t('join.notInvite'))
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
      setPasteError(t('join.noClipboard'))
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
    <Modal title={t('join.title')} onClose={onClose}>
      <p className="muted mb-5 text-sm leading-relaxed">
        {t('join.explain')}
      </p>
      <button className="btn btn-primary mb-5 h-14 w-full text-base" onClick={() => setScanning(true)}>
        <ScanQrCode className="size-6" /> {t('join.scan')}
      </button>
      <div className="muted mb-5 flex items-center gap-3 text-xs font-semibold tracking-wider uppercase">
        <span className="h-px flex-1 bg-slate-200 dark:bg-white/10" />
        {t('join.orLink')}
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
          placeholder={t('join.placeholder')}
        />
        {pasted.trim() ? (
          <button type="submit" className="btn btn-soft shrink-0">
            {t('join.open')}
          </button>
        ) : (
          typeof navigator.clipboard?.readText === 'function' && (
            <button type="button" className="btn btn-soft shrink-0 px-4" onClick={paste} aria-label={t('join.paste')}>
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
    <Modal title={t('accept.title')} onClose={onClose}>
      {!invite ? (
        <p className="note note-error">{t('accept.broken')}</p>
      ) : problem === null ? (
        <p className="muted flex items-center justify-center gap-2 py-8">
          <Loader2 className="size-5 animate-spin" /> {t('accept.checking')}
        </p>
      ) : problem ? (
        <>
          <p className="note note-error mb-4">{problem}</p>
          <button className="btn btn-soft w-full" onClick={onClose}>
            {t('common.close')}
          </button>
        </>
      ) : (
        <>
          <div className="mb-5 flex flex-col items-center gap-2 pt-2 text-center">
            <Avatar name={invite.n || '?'} size="xl" />
            <p className="mt-2 text-lg">
              {rich('accept.invites', { name: <b>{invite.n || t('common.noName')}</b> })}
            </p>
            <p className="muted text-sm leading-relaxed">
              {t('accept.nameNote')}
            </p>
          </div>
          {error && <p className="note note-error mb-4">{error}</p>}
          <div className="grid grid-cols-2 gap-2.5">
            <button className="btn btn-soft" onClick={onClose}>
              {t('accept.decline')}
            </button>
            <button className="btn btn-primary" onClick={accept} disabled={busy}>
              {busy && <Loader2 className="size-5 animate-spin" />}
              {busy ? t('accept.connecting') : t('accept.accept')}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
