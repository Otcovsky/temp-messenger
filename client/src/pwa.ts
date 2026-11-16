/**
 * Всё, что относится к PWA: регистрация service worker, обновления, установка
 * и постоянное хранилище. Состояние отдаётся React через useSyncExternalStore.
 */
import { useSyncExternalStore } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export interface PwaState {
  /** Новая версия скачана и ждёт перезапуска */
  updateReady: boolean
  /** Браузер разрешает показать свой диалог установки (Chrome, Edge, Android) */
  canInstall: boolean
  /** Хранилище помечено постоянным: браузер не сотрёт его сам. null — неизвестно */
  persisted: boolean | null
}

let state: PwaState = { updateReady: false, canInstall: false, persisted: null }
const listeners = new Set<() => void>()
let waiting: ServiceWorker | null = null
let registration: ServiceWorkerRegistration | null = null
/** Сколько ждать, что новый worker возьмёт управление, прежде чем обновляться в обход старого */
const UPDATE_TIMEOUT_MS = 3_000
let installEvent: BeforeInstallPromptEvent | null = null

function set(patch: Partial<PwaState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function usePwa(): PwaState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
  )
}

/** Открыто как установленное приложение (а не во вкладке браузера) */
export function isStandalone(): boolean {
  return (
    matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/** iPhone/iPad: там установить можно только вручную, через «Поделиться → На экран „Домой“» */
export function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export function initPwa(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    installEvent = e as BeforeInstallPromptEvent
    set({ canInstall: true })
  })
  window.addEventListener('appinstalled', () => {
    installEvent = null
    set({ canInstall: false })
  })
  void navigator.storage?.persisted?.().then((persisted) => set({ persisted }))

  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return

  // Перезагружаемся, когда страницей начал управлять новый worker — в этой вкладке
  // или в другой (тогда старый кеш уже удалён и оставаться на старом коде нельзя).
  // Первая установка worker'а не в счёт: до неё страница ничьей не была.
  let hadController = !!navigator.serviceWorker.controller
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) location.reload()
    hadController = true
  })

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      registration = reg
      const track = (w: ServiceWorker | null) => {
        if (!w) return
        const check = () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            waiting = w
            set({ updateReady: true })
          }
        }
        check()
        w.addEventListener('statechange', check)
      }
      track(reg.waiting)
      reg.addEventListener('updatefound', () => track(reg.installing))
      // Проверяем обновления при возвращении в приложение и раз в час
      const update = () => void reg.update().catch(() => {})
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && update())
      setInterval(update, 3600_000)
    } catch (e) {
      console.warn('service worker не зарегистрирован', e)
    }
  })
}

/**
 * Применить скачанное обновление: новый worker активируется, страница перезагрузится.
 *
 * Новый worker не может активироваться, пока старый занят незавершённым событием (зависший
 * запрос, обработка нажатия на уведомление) — тогда нажатие «Обновить» ничего бы не дало.
 * Поэтому, если управление не сменилось за несколько секунд, снимаем регистрацию целиком и
 * перезагружаемся: страница придёт из сети уже новой и зарегистрирует worker заново.
 */
export function applyUpdate(): void {
  waiting?.postMessage('skipWaiting')
  setTimeout(async () => {
    try {
      await registration?.unregister()
    } finally {
      location.reload()
    }
  }, UPDATE_TIMEOUT_MS)
}

/** Показать системный диалог установки (только где браузер его поддерживает) */
export async function promptInstall(): Promise<void> {
  if (!installEvent) return
  await installEvent.prompt()
  await installEvent.userChoice
  installEvent = null
  set({ canInstall: false })
}

/**
 * Попросить браузер не стирать данные сайта сам. Chrome решает молча (обычно «да»
 * для установленного приложения), Firefox спрашивает пользователя, Safari — не всегда честно.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  const persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist())
  set({ persisted })
  return persisted
}
