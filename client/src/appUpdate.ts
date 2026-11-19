/**
 * Обновления Android-приложения. Код чата лежит внутри APK, и сам он не обновляется:
 * приложение сверяет свою версию с download/version.json на сайте (его пишет site/build.sh)
 * и, если там новее, показывает плашку со ссылкой на новый APK. Ставит его Android, поверх старого.
 *
 * Из version.json берутся только номера версий. Адрес скачивания зашит здесь: подменённый
 * файл не может увести человека на чужой APK.
 */
import { CapacitorHttp } from '@capacitor/core'
import { useSyncExternalStore } from 'react'
import { isNativeApp } from './platform'

declare const __APK_VERSION__: { code: number; name: string }

/** Версия этой сборки (versionCode/versionName из android/app/build.gradle) */
export const APP_VERSION = __APK_VERSION__

const SITE = 'https://tempmessenger.tech'
export const VERSION_URL = `${SITE}/download/version.json`
export const DOWNLOAD_URL = `${SITE}/download/temp-messenger.apk`

/** Проверять не чаще раза в час — при запуске и при возвращении в приложение */
const CHECK_EVERY_MS = 3600_000
const DISMISS_KEY = 'tm-apk-update-dismissed'

export interface LatestVersion {
  versionCode: number
  versionName: string
  /** Версии старше этой сервер может не понимать — обновиться нужно обязательно */
  minVersionCode: number
}

export interface AppUpdateState {
  /** Новая версия на сайте, о которой стоит сказать; null — показывать нечего */
  available: { name: string; required: boolean } | null
}

/** Разобрать version.json; всё подозрительное — null (тогда просто молчим) */
export function parseLatest(data: unknown): LatestVersion | null {
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      return null
    }
  }
  if (!data || typeof data !== 'object') return null
  const { versionCode, versionName, minVersionCode } = data as Record<string, unknown>
  const isCode = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0
  if (!isCode(versionCode) || typeof versionName !== 'string') return null
  // Имя показывается в плашке: только короткое и из безобидных символов
  if (!/^[\w.+-]{1,32}$/.test(versionName)) return null
  return { versionCode, versionName, minVersionCode: isCode(minVersionCode) ? minVersionCode : 1 }
}

/**
 * Что показать. Скрытое человеком предложение (dismissedCode) не возвращается, пока не выйдет
 * версия ещё новее; обязательное обновление скрыть нельзя.
 */
export function decide(current: number, latest: LatestVersion | null, dismissedCode: number): AppUpdateState['available'] {
  if (!latest || latest.versionCode <= current) return null
  const required = current < latest.minVersionCode
  if (!required && latest.versionCode <= dismissedCode) return null
  return { name: latest.versionName, required }
}

let state: AppUpdateState = { available: null }
const listeners = new Set<() => void>()
let latest: LatestVersion | null = null
let lastCheck = 0
let checking = false
/** Скрытое в этом запуске — на случай, если хранилище недоступно */
let dismissedNow = 0

function set(next: AppUpdateState) {
  state = next
  listeners.forEach((l) => l())
}

export function useAppUpdate(): AppUpdateState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
  )
}

function readDismissed(): number {
  try {
    return Math.max(dismissedNow, Number(localStorage.getItem(DISMISS_KEY)) || 0)
  } catch {
    return dismissedNow
  }
}

function refresh() {
  set({ available: decide(APP_VERSION.code, latest, readDismissed()) })
}

/**
 * Запрос идёт через сетевой модуль Android (CapacitorHttp), а не fetch: страница приложения
 * открыта с https://localhost, и браузерный запрос на сайт упёрся бы в CORS.
 */
async function fetchLatest(): Promise<LatestVersion | null> {
  const res = await CapacitorHttp.get({
    url: VERSION_URL,
    responseType: 'json',
    headers: { 'Cache-Control': 'no-cache' },
    connectTimeout: 10_000,
    readTimeout: 10_000,
  })
  return res.status === 200 ? parseLatest(res.data) : null
}

async function check(): Promise<void> {
  if (checking || Date.now() - lastCheck < CHECK_EVERY_MS) return
  checking = true
  try {
    const found = await fetchLatest()
    lastCheck = Date.now()
    if (found) {
      latest = found
      refresh()
    }
  } catch {
    /* нет сети — попробуем при следующем возвращении в приложение */
  } finally {
    checking = false
  }
}

/** Только в Android-приложении: сайт и PWA обновляются через service worker (pwa.ts) */
export function initAppUpdate(): void {
  if (!isNativeApp) return
  void check()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check()
  })
}

/** «Позже»: не напоминать об этой версии */
export function dismissAppUpdate(): void {
  if (!latest) return
  dismissedNow = latest.versionCode
  try {
    localStorage.setItem(DISMISS_KEY, String(latest.versionCode))
  } catch {
    /* без хранилища плашка вернётся при следующем запуске */
  }
  refresh()
}
