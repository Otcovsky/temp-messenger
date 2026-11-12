import { useState } from 'react'
import { applyUpdate, isAndroid, isIos, isStandalone, promptInstall, usePwa } from '../pwa'

/** Плашка «Доступно обновление»: новая версия применяется только по нажатию. */
export function UpdateToast() {
  const { updateReady } = usePwa()
  if (!updateReady) return null
  return (
    <div className="update-toast" role="status">
      <span>Доступна новая версия</span>
      <button className="primary" onClick={applyUpdate}>
        Обновить
      </button>
    </div>
  )
}

const DISMISS_KEY = 'tm-install-banner-dismissed'
// Данные сайта переживают удаление приложения, поэтому «скрыть» — не навсегда
const DISMISS_FOR_MS = 14 * 24 * 3600 * 1000

function readDismissed(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY))
    return at > 0 && Date.now() - at < DISMISS_FOR_MS
  } catch {
    return false
  }
}

const MENU_STEPS = 'Откройте меню браузера (⋮ или ≡) → «Установить приложение» или «Добавить на главный экран».'

/**
 * Плашка над списком чатов. Если браузер прислал своё предложение установки
 * (beforeinstallprompt — Chrome, Edge), даём кнопку. Но присылает он его не всегда:
 * не сразу после первого захода, не после удаления приложения или отказа, а Mi Browser,
 * Samsung Internet, Firefox — вообще никогда. Тогда на Android показываем, где
 * найти установку в меню. Скрытая крестиком плашка возвращается через 14 дней.
 */
export function InstallBanner() {
  const { canInstall, installed } = usePwa()
  const [dismissed, setDismissed] = useState(readDismissed)
  if (dismissed || installed || isStandalone()) return null
  if (!canInstall && !isAndroid()) return null
  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()))
    } catch {
      /* без хранилища плашка просто вернётся при следующем запуске */
    }
  }
  return (
    <div className="install-banner">
      <img src="/icon-192.png" alt="" width={36} height={36} />
      <span>
        <b>Установите приложение</b>
        <small>{canInstall ? 'Отдельное окно, значок и запуск без сети' : MENU_STEPS}</small>
      </span>
      <button className="icon" onClick={dismiss} title="Скрыть" aria-label="Скрыть">
        ×
      </button>
      {canInstall && (
        <button className="primary install" onClick={promptInstall}>
          Установить
        </button>
      )}
    </div>
  )
}

const IOS_STEPS = 'В Safari нажмите «Поделиться» (квадрат со стрелкой) → «На экран „Домой“».'

/** Подсказка для iPhone/iPad перед регистрацией: ставить приложение надо до первого чата. */
export function IosInstallHint({ hasInvite }: { hasInvite: boolean }) {
  if (!isIos() || isStandalone()) return null
  return (
    <div className="warn">
      <b>Сначала установите приложение.</b> На iPhone и iPad Safari стирает данные сайтов, которые давно не
      открывали, а у приложения на экране «Домой» отдельное хранилище: чаты, начатые здесь, туда не перейдут.
      <br />
      {IOS_STEPS}
      {hasInvite && (
        <>
          <br />
          Ссылку-приглашение сохраните заранее: в приложении нажмите «Присоединиться» и вставьте её.
        </>
      )}
    </div>
  )
}

/** Раздел настроек: установка и состояние хранилища. */
export function AppSection() {
  const { canInstall, persisted, installed } = usePwa()
  const standalone = isStandalone()
  return (
    <>
      <h3>Приложение</h3>
      {standalone ? (
        <p className="muted small">Открыто как установленное приложение.</p>
      ) : installed ? (
        <p className="muted small">Приложение уже установлено — его можно открыть со значка на экране.</p>
      ) : canInstall ? (
        <>
          <p className="muted small">Установите мессенджер как приложение: отдельное окно, значок и запуск без сети.</p>
          <button onClick={promptInstall}>Установить приложение</button>
        </>
      ) : isIos() ? (
        <p className="muted small">
          {IOS_STEPS} Учтите: у установленного приложения своё хранилище, текущие чаты туда не перейдут.
        </p>
      ) : (
        <p className="muted small">{MENU_STEPS}</p>
      )}
      {persisted !== null && (
        <p className="muted small">
          Хранилище:{' '}
          {persisted
            ? 'постоянное — браузер не сотрёт данные сам.'
            : 'браузер может очистить его при нехватке места или долгом простое.'}
        </p>
      )}
    </>
  )
}
