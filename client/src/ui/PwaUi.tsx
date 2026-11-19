import { Bell, BellOff, BellRing, Download, PhoneCall, RefreshCw, Smartphone, X } from 'lucide-react'
import { useState } from 'react'
import { APP_VERSION, DOWNLOAD_URL, dismissAppUpdate, useAppUpdate } from '../appUpdate'
import { t } from '../i18n'
import { isNativeApp } from '../platform'
import { applyUpdate, isIos, isStandalone, promptInstall, usePwa } from '../pwa'
import { disablePush, enablePush, testPush, usePush } from '../push'

const TOAST =
  'fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-[60] flex max-w-[calc(100%-2rem)] -translate-x-1/2 animate-pop-in items-center gap-3 rounded-full bg-slate-900/90 py-1.5 pr-1.5 pl-4 text-sm text-white shadow-2xl backdrop-blur-xl dark:bg-white/15'

/**
 * Плашка «Доступно обновление»: новая версия применяется только по нажатию.
 * На сайте и в PWA — новый service worker, в Android-приложении — новый APK с сайта.
 */
export function UpdateToast() {
  const { updateReady } = usePwa()
  const { available } = useAppUpdate()
  if (available) {
    return (
      <div role="status" className={TOAST}>
        <Download className="size-4 shrink-0 text-violet-300" />
        <span className="min-w-0 truncate">
          {t(available.required ? 'appUpdate.required' : 'appUpdate.available', { version: available.name })}
        </span>
        {/* Ссылка вне приложения: Android откроет её в браузере, тот скачает APK */}
        <a className="btn btn-sm btn-primary shrink-0 rounded-full" href={DOWNLOAD_URL}>
          {t('appUpdate.download')}
        </a>
        {!available.required && (
          <button
            className="btn-icon size-8 shrink-0 text-white/70"
            onClick={dismissAppUpdate}
            title={t('appUpdate.later')}
            aria-label={t('appUpdate.later')}
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    )
  }
  if (!updateReady) return null
  return (
    <div role="status" className={TOAST}>
      <RefreshCw className="size-4 shrink-0 text-violet-300" />
      <span className="truncate">{t('pwa.updateReady')}</span>
      <button className="btn btn-sm btn-primary rounded-full" onClick={applyUpdate}>
        {t('pwa.update')}
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
          <b className="text-sm font-semibold">{t('pwa.install.title')}</b>
          <small className="muted truncate text-xs">{t('pwa.install.text')}</small>
        </span>
        <button className="btn btn-sm btn-primary px-3.5" onClick={promptInstall}>
          <Download className="size-4" /> {t('pwa.install')}
        </button>
        <button className="btn-icon size-8" onClick={dismiss} title={t('pwa.hide')} aria-label={t('pwa.hide')}>
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}

/** Подсказка для iPhone/iPad перед регистрацией: ставить приложение надо до первого чата. */
export function IosInstallHint({ hasInvite }: { hasInvite: boolean }) {
  if (!isIos() || isStandalone()) return null
  return (
    <div className="note note-warn mb-4">
      <Smartphone className="mt-0.5 size-5 shrink-0" />
      <div>
        <b>{t('pwa.iosFirst')}</b> {t('pwa.iosWhy')}
        <p className="mt-2">{t('pwa.iosSteps')}</p>
        {hasInvite && (
          <p className="mt-2">{t('pwa.iosInvite')}</p>
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
      <h3 className="section-title">{t('pwa.section')}</h3>
      <div className="grid gap-3 rounded-2xl bg-slate-900/[0.03] p-4 text-sm leading-relaxed dark:bg-white/[0.04]">
        {isNativeApp ? (
          <p className="muted">{t('appUpdate.current', { version: APP_VERSION.name })}</p>
        ) : standalone ? (
          <p className="muted">{t('pwa.standalone')}</p>
        ) : canInstall ? (
          <>
            <p className="muted">{t('pwa.installExplain')}</p>
            <button className="btn btn-primary w-full" onClick={promptInstall}>
              <Download className="size-5" /> {t('pwa.installApp')}
            </button>
          </>
        ) : isIos() ? (
          <p className="muted">
            {t('pwa.iosSteps')} {t('pwa.iosNote')}
          </p>
        ) : (
          <p className="muted">
            {t('pwa.menuInstall')}
          </p>
        )}
        {persisted !== null && (
          <p className="flex items-start gap-2">
            <span className={`mt-1.5 size-2 shrink-0 rounded-full ${persisted ? 'bg-emerald-500' : 'bg-amber-400'}`} />
            <span className="muted">
              {t('pwa.storage')} {persisted ? t('pwa.persisted') : t('pwa.notPersisted')}
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
          ? t('push.iosOnly')
          : t('push.unsupported')}
      </p>
    )
  } else if (serverReady === false) {
    body = <p className="muted">{t('push.notConfigured')}</p>
  } else if (permission === 'denied') {
    body = (
      <p className="muted">
        {isNativeApp
          ? t('push.deniedNative')
          : t('push.deniedWeb')}
      </p>
    )
  } else {
    body = (
      <>
        <p className="muted">
          {isNativeApp ? t('push.howNative') : t('push.howWeb')} {t('push.privacy')}
        </p>
        {enabled ? (
          <>
            <p className="flex items-start gap-2">
              <span
                className={`mt-1.5 size-2 shrink-0 rounded-full ${confirmed ? 'bg-emerald-500' : 'bg-amber-400'}`}
              />
              <span className="muted">
                {confirmed
                  ? t('push.confirmed')
                  : t('push.unconfirmed')}
              </span>
            </p>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                className="btn btn-primary"
                onClick={() => run(() => testPush())}
                disabled={busy || !confirmed || test?.ok === null}
              >
                <BellRing className="size-5" /> {t('push.test')}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => run(() => testPush('call'))}
                disabled={busy || !confirmed || test?.ok === null}
                title={t('push.testCallTitle')}
              >
                <PhoneCall className="size-5" /> {t('push.testCall')}
              </button>
            </div>
            <button className="btn btn-soft w-full" onClick={() => run(disablePush)} disabled={busy}>
              <BellOff className="size-5" /> {t('push.disable')}
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
            <Bell className="size-5" /> {serverReady === null ? t('common.noConnection') : t('push.enable')}
          </button>
        )}
        {error && <p className="note note-error">{error}</p>}
      </>
    )
  }

  return (
    <>
      <h3 className="section-title mt-6">{t('push.section')}</h3>
      <div className="grid gap-3 rounded-2xl bg-slate-900/[0.03] p-4 text-sm leading-relaxed dark:bg-white/[0.04]">
        {body}
      </div>
    </>
  )
}
