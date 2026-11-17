import { Bell, BellOff, BellRing, Download, PhoneCall, RefreshCw, Smartphone, X } from 'lucide-react'
import { useState } from 'react'
import { applyUpdate, isIos, isStandalone, promptInstall, usePwa } from '../pwa'
import { disablePush, enablePush, testPush, usePush } from '../push'

/** Плашка «Доступно обновление»: новая версия применяется только по нажатию. */
export function UpdateToast() {
  const { updateReady } = usePwa()
  if (!updateReady) return null
  return (
    <div
      role="status"
      className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-[60] flex max-w-[calc(100%-2rem)] -translate-x-1/2 animate-pop-in items-center gap-3 rounded-full bg-slate-900/90 py-1.5 pr-1.5 pl-4 text-sm text-white shadow-2xl backdrop-blur-xl dark:bg-white/15"
    >
      <RefreshCw className="size-4 shrink-0 text-violet-300" />
      <span className="truncate">Доступна новая версия</span>
      <button className="btn btn-sm btn-primary rounded-full" onClick={applyUpdate}>
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
    <div className="mx-3 mt-2 mb-1 shrink-0 rounded-3xl bg-brand p-px shadow-lg shadow-violet-500/20">
      <div className="flex items-center gap-3 rounded-[23px] bg-white/95 p-2.5 pl-3 dark:bg-surface-dark/95">
        <img className="size-11 shrink-0 rounded-xl" src="/icon-192.png" alt="" width={44} height={44} />
        <span className="flex min-w-0 flex-col flex-1">
          <b className="text-sm font-semibold">Установите приложение</b>
          <small className="muted truncate text-xs">Значок, отдельное окно, запуск без сети</small>
        </span>
        <button className="btn btn-sm btn-primary px-3.5" onClick={promptInstall}>
          <Download className="size-4" /> Установить
        </button>
        <button className="btn-icon size-8" onClick={dismiss} title="Скрыть" aria-label="Скрыть">
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}

const IOS_STEPS = 'В Safari нажмите «Поделиться» (квадрат со стрелкой) → «На экран „Домой“».'

/** Подсказка для iPhone/iPad перед регистрацией: ставить приложение надо до первого чата. */
export function IosInstallHint({ hasInvite }: { hasInvite: boolean }) {
  if (!isIos() || isStandalone()) return null
  return (
    <div className="note note-warn mb-4">
      <Smartphone className="mt-0.5 size-5 shrink-0" />
      <div>
        <b>Сначала установите приложение.</b> На iPhone и iPad Safari стирает данные сайтов, которые давно не
        открывали, а у приложения на экране «Домой» отдельное хранилище: чаты, начатые здесь, туда не перейдут.
        <p className="mt-2">{IOS_STEPS}</p>
        {hasInvite && (
          <p className="mt-2">Ссылку-приглашение сохраните заранее: в приложении нажмите «Присоединиться» и вставьте её.</p>
        )}
      </div>
    </div>
  )
}

/** Раздел настроек: установка и состояние хранилища. */
export function AppSection() {
  const { canInstall, persisted } = usePwa()
  const standalone = isStandalone()
  return (
    <>
      <h3 className="section-title">Приложение</h3>
      <div className="grid gap-3 rounded-2xl bg-slate-900/[0.03] p-4 text-sm leading-relaxed dark:bg-white/[0.04]">
        {standalone ? (
          <p className="muted">Открыто как установленное приложение.</p>
        ) : canInstall ? (
          <>
            <p className="muted">Установите мессенджер как приложение: отдельное окно, значок и запуск без сети.</p>
            <button className="btn btn-primary w-full" onClick={promptInstall}>
              <Download className="size-5" /> Установить приложение
            </button>
          </>
        ) : isIos() ? (
          <p className="muted">
            {IOS_STEPS} Учтите: у установленного приложения своё хранилище, текущие чаты туда не перейдут.
          </p>
        ) : (
          <p className="muted">
            Установить можно из меню браузера («Установить приложение» или «Добавить на главный экран»).
          </p>
        )}
        {persisted !== null && (
          <p className="flex items-start gap-2">
            <span className={`mt-1.5 size-2 shrink-0 rounded-full ${persisted ? 'bg-emerald-500' : 'bg-amber-400'}`} />
            <span className="muted">
              Хранилище:{' '}
              {persisted
                ? 'постоянное — браузер не сотрёт данные сам.'
                : 'браузер может очистить его при нехватке места или долгом простое.'}
            </span>
          </p>
        )}
      </div>
    </>
  )
}

/** Раздел настроек: пуш-уведомления. Выключены, пока человек сам их не включит. */
export function NotificationsSection() {
  const { supported, serverReady, permission, enabled, confirmed, error, test } = usePush()
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  let body
  if (!supported) {
    body = (
      <p className="muted">
        {isIos() && !isStandalone()
          ? 'На iPhone и iPad уведомления работают только в приложении, установленном на экран «Домой».'
          : 'Этот браузер не умеет показывать уведомления от сайтов.'}
      </p>
    )
  } else if (serverReady === false) {
    body = <p className="muted">На этом сервере уведомления не настроены.</p>
  } else if (permission === 'denied') {
    body = (
      <p className="muted">
        Уведомления запрещены в настройках браузера. Разрешите их для этого сайта и вернитесь сюда.
      </p>
    )
  } else {
    body = (
      <>
        <p className="muted">
          Когда приложение закрыто, сервер будит его через пуш-сервис браузера (Google, Apple или Mozilla). В
          уведомлении нет ни текста, ни имени — только «Новое сообщение». Пуш-сервис узнаёт лишь время, когда вам
          пишут.
        </p>
        {enabled ? (
          <>
            <p className="flex items-start gap-2">
              <span
                className={`mt-1.5 size-2 shrink-0 rounded-full ${confirmed ? 'bg-emerald-500' : 'bg-amber-400'}`}
              />
              <span className="muted">
                {confirmed
                  ? 'Включены: сервер знает, как разбудить это устройство.'
                  : 'Включены, но сервер ещё не подтвердил подписку этого устройства.'}
              </span>
            </p>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                className="btn btn-primary"
                onClick={() => run(() => testPush())}
                disabled={busy || !confirmed || test?.ok === null}
              >
                <BellRing className="size-5" /> Проверить
              </button>
              <button
                className="btn btn-primary"
                onClick={() => run(() => testPush('call'))}
                disabled={busy || !confirmed || test?.ok === null}
                title="Пробное уведомление о входящем звонке"
              >
                <PhoneCall className="size-5" /> Звонок
              </button>
            </div>
            <button className="btn btn-soft w-full" onClick={() => run(disablePush)} disabled={busy}>
              <BellOff className="size-5" /> Выключить уведомления
            </button>
            {test && (
              <p className={`note ${test.ok === false ? 'note-error' : 'note-info'}`} role="status">
                {test.text}
              </p>
            )}
          </>
        ) : (
          <button
            className="btn btn-primary w-full"
            onClick={() => run(enablePush)}
            disabled={busy || serverReady === null}
          >
            <Bell className="size-5" /> {serverReady === null ? 'Нет связи с сервером' : 'Включить уведомления'}
          </button>
        )}
        {error && <p className="note note-error">{error}</p>}
      </>
    )
  }

  return (
    <>
      <h3 className="section-title mt-6">Уведомления</h3>
      <div className="grid gap-3 rounded-2xl bg-slate-900/[0.03] p-4 text-sm leading-relaxed dark:bg-white/[0.04]">
        {body}
      </div>
    </>
  )
}
