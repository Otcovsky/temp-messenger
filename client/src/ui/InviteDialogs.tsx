import QRCode from 'qrcode'
import { useEffect, useMemo, useState } from 'react'
import { type InvitePayload, type PendingInvite, decodeInvite } from '../crypto/handshake'
import { useLive, useMessenger } from './hooks'
import { Modal } from './Modal'
import { QrScanner } from './QrScanner'

export function CreateInviteDialog({ onClose }: { onClose: () => void }) {
  const m = useMessenger()
  const [invite, setInvite] = useState<PendingInvite | null>(null)
  const [qr, setQr] = useState<string>('')
  const [copied, setCopied] = useState(false)
  const pending = useLive((m) => m.listInvites(), [])
  const link = invite ? m.inviteLink(invite) : ''

  useEffect(() => {
    if (link) QRCode.toDataURL(link, { margin: 1, width: 260, errorCorrectionLevel: 'M' }).then(setQr)
  }, [link])

  const copy = async () => {
    await navigator.clipboard.writeText(link)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Modal title="Пригласить собеседника" onClose={onClose}>
      {!invite ? (
        <>
          <p className="muted">
            Создайте ссылку и передайте её собеседнику любым способом: лично (QR-код), в другом мессенджере, по почте.
            Ссылка одноразовая — по ней можно добавить только одного человека.
          </p>
          <button className="primary" onClick={async () => setInvite(await m.createInvite())}>
            Создать ссылку
          </button>
        </>
      ) : (
        <div className="invite">
          {qr && <img className="qr" src={qr} alt="QR-код приглашения" width={260} height={260} />}
          <div className="link-row">
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
            <button onClick={copy}>{copied ? 'Скопировано' : 'Копировать'}</button>
          </div>
          <p className="muted small">
            Чат появится, когда собеседник откроет ссылку. Действует 30 дней. Код безопасности потом можно сверить
            в окне чата.
          </p>
        </div>
      )}

      {!!pending?.length && (
        <>
          <hr />
          <h3>Ожидают ответа</h3>
          <ul className="pending">
            {pending.map((p) => (
              <li key={p.mailbox}>
                <span>{new Date(p.createdAt).toLocaleString()}</span>
                <button className="link danger" onClick={() => m.cancelInvite(p.mailbox)}>
                  Отозвать
                </button>
              </li>
            ))}
          </ul>
        </>
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
      <p className="muted">Откройте ссылку-приглашение, которую вам прислал собеседник, или отсканируйте его QR-код.</p>
      <form
        className="link-row"
        onSubmit={(e) => {
          e.preventDefault()
          if (pasted.trim()) openCode(pasted)
        }}
      >
        <input
          autoFocus
          value={pasted}
          onChange={(e) => {
            setPasted(e.target.value)
            setPasteError('')
          }}
          placeholder="Вставьте ссылку-приглашение"
        />
        <button type="submit" disabled={!pasted.trim()}>
          Открыть
        </button>
      </form>
      <button className="scan-button" onClick={() => setScanning(true)}>
        Сканировать QR-код
      </button>
      {pasteError && <p className="error">{pasteError}</p>}
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
        <p className="error">Ссылка повреждена или неполная.</p>
      ) : problem === null ? (
        <p className="muted">Проверяю приглашение…</p>
      ) : problem ? (
        <>
          <p className="error">{problem}</p>
          <div className="actions">
            <button onClick={onClose}>Закрыть</button>
          </div>
        </>
      ) : (
        <>
          <p>
            <b>{invite.n || 'Без имени'}</b> приглашает вас в зашифрованный чат.
          </p>
          <p className="muted small">Имя указал сам пригласивший. Убедиться, что это он, можно сверив код безопасности.</p>
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button onClick={onClose}>Отклонить</button>
            <button className="primary" onClick={accept} disabled={busy}>
              {busy ? 'Подключаю…' : 'Принять'}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
