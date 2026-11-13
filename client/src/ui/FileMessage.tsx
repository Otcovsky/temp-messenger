import { useEffect, useState } from 'react'
import type { Messenger } from '../core/messenger'
import type { Message } from '../storage/db'
import { formatSize } from './format'
import { useMessenger } from './hooks'
import { Modal } from './Modal'

/**
 * Картинки, которые показываются прямо в чате. Только растровые: SVG может содержать скрипты,
 * и открытый как страница он выполнился бы от имени приложения.
 */
const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/

/** Адрес blob: для показа файла из базы. Освобождается, когда компонент уходит с экрана. */
function useFileUrl(msgId: string, enabled: boolean, mime: string): string | null {
  const m = useMessenger()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    let made: string | null = null
    void m.fileData(msgId).then((data) => {
      if (!alive || !data) return
      made = URL.createObjectURL(new Blob([data], { type: mime }))
      setUrl(made)
    })
    return () => {
      alive = false
      if (made) URL.revokeObjectURL(made)
      setUrl(null)
    }
  }, [m, msgId, enabled, mime])
  return url
}

/** Сохранить файл на устройство. Тип octet-stream — чтобы браузер скачал файл, а не открыл его. */
async function saveFile(m: Messenger, msg: Message) {
  const data = await m.fileData(msg.id)
  if (!data || !msg.file) return
  const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = msg.file.name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function FileMessage({ msg, onMediaLoad }: { msg: Message; onMediaLoad: () => void }) {
  const m = useMessenger()
  const file = msg.file!
  const ready = file.state === 'ready'
  const isImage = INLINE_IMAGE.test(file.mime)
  const imageUrl = useFileUrl(msg.id, ready && isImage, file.mime)
  const [viewing, setViewing] = useState(false)

  if (imageUrl) {
    return (
      <>
        <button className="file-image" onClick={() => setViewing(true)} aria-label={`Открыть ${file.name}`}>
          <img src={imageUrl} alt={file.name} onLoad={onMediaLoad} />
        </button>
        {viewing && (
          <Modal title={file.name} onClose={() => setViewing(false)}>
            <img className="file-view" src={imageUrl} alt={file.name} />
            <div className="actions">
              <button className="primary" onClick={() => void saveFile(m, msg)}>
                Сохранить
              </button>
            </div>
          </Modal>
        )}
      </>
    )
  }

  const mine = msg.from === 'me'
  let status: React.ReactNode
  if (mine && msg.transfer === 'up') status = 'отправляется…'
  else if (file.state === 'loading') status = 'скачивается…'
  else if (file.state === 'gone') status = 'файл больше недоступен'
  else if (file.state === 'error')
    status = (
      <button className="link danger" onClick={() => void m.retryDownload(msg.id)}>
        не скачался — повторить
      </button>
    )
  else status = formatSize(file.size)

  return (
    <div className="file-card">
      <button className="file-icon" disabled={!ready} onClick={() => void saveFile(m, msg)} aria-label={`Сохранить ${file.name}`}>
        {ready ? '⤓' : file.state === 'loading' || msg.transfer === 'up' ? '…' : '✕'}
      </button>
      <span className="file-info">
        {ready ? (
          <button className="link file-name" onClick={() => void saveFile(m, msg)}>
            {file.name}
          </button>
        ) : (
          <b className="file-name">{file.name}</b>
        )}
        <small className={file.state === 'gone' || file.state === 'error' ? 'error' : 'muted'}>
          {status}
          {file.state !== 'ready' && file.state !== 'gone' && ` · ${formatSize(file.size)}`}
        </small>
      </span>
    </div>
  )
}
