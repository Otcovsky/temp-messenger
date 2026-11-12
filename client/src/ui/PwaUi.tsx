import { useState } from 'react'
import { applyUpdate, isIos, isStandalone, promptInstall, usePwa } from '../pwa'

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

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Плашка над списком чатов. Показывается, только где браузер умеет устанавливать сам
 * (Chrome, Edge, Android): системное предложение мы перехватываем, чтобы показать своё.
 * Скрытая крестиком больше не появляется — кнопка остаётся в настройках.
 */
export function InstallBanner() {
  const { canInstall } = usePwa()
  const [dismissed, setDismissed] = useState(readDismissed)
  if (!canInstall || dismissed || isStandalone()) return null
  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* без хранилища плашка просто вернётся при следующем запуске */
    }
  }
  return (
    <div className="install-banner">
      <img src="/icon-192.png" alt="" width={36} height={36} />
      <span>
        <b>Установите приложение</b>
        <small>Отдельное окно, значок и запуск без сети</small>
      </span>
      <button className="icon" onClick={dismiss} title="Скрыть" aria-label="Скрыть">
        ×
      </button>
      <button className="primary install" onClick={promptInstall}>
        Установить
      </button>
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
  const { canInstall, persisted } = usePwa()
  const standalone = isStandalone()
  return (
    <>
      <h3>Приложение</h3>
      {standalone ? (
        <p className="muted small">Открыто как установленное приложение.</p>
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
        <p className="muted small">Установить можно из меню браузера («Установить приложение» или «Добавить на главный экран»).</p>
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
