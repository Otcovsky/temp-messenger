/**
 * Пуш-уведомления: подписка браузера у его пуш-сервиса и передача её адреса ретранслятору.
 *
 * Пуш приходит пустым — в нём нет ни текста, ни отправителя; service worker показывает
 * одно и то же «Новое сообщение». Включаются только явным нажатием в настройках.
 * В Android-приложении вместо Web Push — Firebase (FCM): токен и уведомления даёт плагин TmPush.
 * Состояние отдаётся React через useSyncExternalStore, как в pwa.ts.
 */
import { useSyncExternalStore } from 'react'
import type { Messenger } from './core/messenger'
import { b64d, b64e } from './crypto/bytes'
import { t } from './i18n'
import { type NativePermission, TmPush } from './native'
import { isNativeApp } from './platform'

export interface PushState {
  /** Браузер умеет Web Push и service worker работает (в режиме разработки его нет) */
  supported: boolean
  /** Сервер прислал свой ключ, то есть умеет слать пуши. null — ещё не было связи */
  serverReady: boolean | null
  permission: NotificationPermission
  /** Пользователь включил уведомления на этом устройстве */
  enabled: boolean
  /** Сервер подтвердил, что знает подписку этого браузера (в текущем подключении) */
  confirmed: boolean
  /** Почему подписка не удалась (текст для человека) */
  error: string | null
  /** Ход и итог проверки кнопкой «Проверить» */
  test: { text: string; ok: boolean | null } | null
}

const FLAG = 'tm-push'
/** Метки уведомлений (те же, что в sw.js): новое с той же меткой заменяет старое, а не копится */
const TAG = 'tm-msg'
const CALL_TAG = 'tm-call'
const MISSED_TAG = 'tm-missed'
/** Как часто «звонит» уведомление о входящем звонке */
const RING_EVERY_MS = 3_000
/** Сколько ждать service worker: без него подписаться нельзя, а ждать вечно незачем */
const SW_TIMEOUT_MS = 8_000
const TEST_TIMEOUT_MS = 20_000

/** Браузер с Web Push. В Android-приложении его нет (WebView не умеет) — там FCM */
const webSupported =
  import.meta.env.PROD &&
  !isNativeApp &&
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in globalThis &&
  'Notification' in globalThis
const supported = webSupported || isNativeApp

function fromNative(p: NativePermission): NotificationPermission {
  return p === 'prompt' ? 'default' : p
}

function readFlag(): boolean {
  try {
    return localStorage.getItem(FLAG) === '1'
  } catch {
    return false
  }
}

function writeFlag(on: boolean) {
  try {
    if (on) localStorage.setItem(FLAG, '1')
    else localStorage.removeItem(FLAG)
  } catch {
    /* без хранилища настройка проживёт до перезапуска */
  }
}

let state: PushState = {
  supported,
  serverReady: null,
  permission: webSupported ? Notification.permission : 'default',
  enabled: supported && readFlag(),
  confirmed: false,
  error: null,
  test: null,
}
const listeners = new Set<() => void>()
let messenger: Messenger | null = null
let testTimer: ReturnType<typeof setTimeout> | undefined

function set(patch: Partial<PushState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function usePush(): PushState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
  )
}

function refusal(code: string): string {
  if (code === 'bad_endpoint') return t('push.badEndpoint')
  if (code === 'bad_keys') return t('push.badKeys')
  return t('push.serverNoPush')
}

function endTest(text: string, ok: boolean) {
  clearTimeout(testTimer)
  set({ test: { text, ok } })
}

/** Связать пуши с мессенджером. Вызывается один раз, до m.start(). */
export function initPush(m: Messenger): void {
  messenger = m
  m.onPush = (e) => {
    if (e.t === 'incoming') {
      void notifyIfHidden(t('notify.message'))
    } else if (e.t === 'ready') {
      set({ serverReady: isNativeApp ? m.pushFcm : !!m.pushKey, confirmed: false })
      void sync()
    } else if (e.t === 'test') {
      onTestResult(e.status)
    } else if (e.ok) {
      set({ confirmed: true, error: null })
    } else if (e.code === 'no_subscription') {
      // Сервер подписку не знает (потерял или её удалил пуш-сервис) — заводим заново
      set({ confirmed: false })
      endTest(t('push.resubscribed'), false)
      void sync()
    } else {
      set({ confirmed: false, error: refusal(e.code) })
    }
  }
  if (isNativeApp) {
    // Уведомления убирает сам плагин, когда приложение выходит на экран
    void TmPush.status()
      .then((s) => set({ permission: fromNative(s.permission) }))
      .catch(() => {})
    return
  }
  if (!supported) return
  // Приложение на экране — уведомления больше не нужны
  const clear = () => {
    if (document.visibilityState !== 'visible') return
    clearInterval(ringTimer)
    void clearNotifications()
  }
  document.addEventListener('visibilitychange', clear)
  clear()
}

async function clearNotifications(tag?: string) {
  const reg = await navigator.serviceWorker.getRegistration()
  for (const n of (await reg?.getNotifications(tag ? { tag } : undefined)) ?? []) n.close()
}

async function showHidden(title: string, options: NotificationOptions & Record<string, unknown>) {
  if (!webSupported || !state.enabled || document.visibilityState === 'visible') return
  if (Notification.permission !== 'granted') return
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    await reg?.showNotification(title, { icon: '/icon-192.png', ...options })
  } catch (e) {
    console.warn('Не удалось показать уведомление', e)
  }
}

let ringTimer: ReturnType<typeof setInterval> | undefined

/**
 * Уведомления о звонке, когда приложение свёрнуто, но ещё работает (если оно закрыто, то же
 * самое делает service worker по пушу). ring — «звонить»: уведомление со звуком и вибрацией,
 * повторяется, пока не ответят; stop — перестать; missed — заменить на «Пропущенный звонок».
 */
export function callAlert(kind: 'ring' | 'stop' | 'missed'): void {
  clearInterval(ringTimer)
  if (isNativeApp) {
    // Мелодия звонка повторяется сама (FLAG_INSISTENT), повторять уведомление не нужно
    if (state.enabled || kind === 'stop') void TmPush.show({ kind: kind === 'ring' ? 'call' : kind }).catch(() => {})
    return
  }
  if (!supported) return
  if (kind === 'ring') {
    const ring = () =>
      void showHidden(t('notify.call'), {
        body: t('notify.callBody'),
        tag: CALL_TAG,
        renotify: true,
        requireInteraction: true,
        vibrate: [600, 200, 600, 200, 600],
      })
    ring()
    ringTimer = setInterval(ring, RING_EVERY_MS)
    return
  }
  void clearNotifications(CALL_TAG).then(() => {
    if (kind === 'missed') return showHidden(t('notify.missed'), { tag: MISSED_TAG, renotify: true })
  })
}

/**
 * Сообщение пришло, пока приложение свёрнуто, но ещё работает. Сервер пуш не пошлёт: сообщение
 * уже забрано. Поэтому уведомление показываем сами — такое же, как по пушу (о звонке — со своим текстом).
 */
export function notifyIfHidden(body: string): Promise<void> {
  if (isNativeApp) return state.enabled ? TmPush.show({ kind: 'msg' }).catch(() => {}) : Promise.resolve()
  return showHidden('Temp Messenger', { body, tag: TAG, renotify: true })
}

function activeWorker(): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('service worker timeout')), SW_TIMEOUT_MS)),
  ])
}

/**
 * Привести подписку в соответствие с настройкой. Вызывается при каждом подключении:
 * браузер может сменить адрес подписки сам, а сервер — потерять её или сменить ключ.
 * renew — выбросить текущую подписку и получить новую (пуш-сервис сказал, что старой нет).
 */
async function sync(renew = false): Promise<void> {
  const m = messenger
  if (!supported || !m || !state.enabled) return
  if (isNativeApp) return syncNative(m, renew)
  const key = m.pushKey
  if (!key) return
  set({ permission: Notification.permission })
  if (Notification.permission !== 'granted') {
    // Разрешение отозвали в настройках браузера
    writeFlag(false)
    set({ enabled: false, confirmed: false })
    m.setPushEndpoint(null)
    return
  }
  try {
    const reg = await activeWorker()
    let sub = await reg.pushManager.getSubscription()
    const subKey = sub?.options.applicationServerKey
    if (sub && (renew || !subKey || b64e(new Uint8Array(subKey)) !== key)) {
      await sub.unsubscribe() // подписка выдана под другой ключ сервера или уже не действует
      sub = null
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64d(key) })
    set({ error: null })
    // Ключи подписки нужны серверу, чтобы зашифровать пометку «звонок»: пуш-сервис её не прочтёт
    const keys = sub.toJSON().keys ?? {}
    if (!m.setPushEndpoint({ endpoint: sub.endpoint, p256dh: keys.p256dh, auth: keys.auth })) set({ error: t('push.offlineLater') })
  } catch (e) {
    console.warn('Не удалось подписаться на уведомления', e)
    const why = e instanceof Error ? e.message : String(e)
    set({ error: t('push.subscribeFailed', { why }) })
  }
}

/** То же для Android-приложения: токен FCM вместо подписки браузера. */
async function syncNative(m: Messenger, renew: boolean): Promise<void> {
  if (!m.pushFcm) return
  try {
    const s = await TmPush.status()
    set({ permission: fromNative(s.permission) })
    if (s.permission !== 'granted') {
      // Уведомления запретили в настройках телефона
      writeFlag(false)
      set({ enabled: false, confirmed: false })
      m.setPushEndpoint(null)
      return
    }
    if (!s.available) {
      set({ error: t('push.noFirebase') })
      return
    }
    if (renew) await TmPush.unregister() // Google сказал, что токена больше нет: берём новый
    const { token, key } = await TmPush.register()
    set({ error: null })
    if (!m.setPushEndpoint({ fcm: token, key })) set({ error: t('push.offlineLater') })
  } catch (e) {
    console.warn('Не удалось получить токен FCM', e)
    const why = e instanceof Error ? e.message : String(e)
    set({
      error: t('push.fcmFailed', { why }),
    })
  }
}

/** Включить уведомления. Вызывать только из обработчика нажатия: иначе браузер не спросит разрешение. */
export async function enablePush(): Promise<void> {
  if (!supported) return
  if (isNativeApp) {
    const { permission } = await TmPush.requestPermission()
    set({ permission: fromNative(permission), error: null, test: null })
    if (permission !== 'granted') return
    writeFlag(true)
    set({ enabled: true })
    return sync()
  }
  const permission = await Notification.requestPermission()
  set({ permission, error: null, test: null })
  if (permission !== 'granted') return
  writeFlag(true)
  set({ enabled: true })
  await sync()
}

export async function disablePush(): Promise<void> {
  writeFlag(false)
  set({ enabled: false, confirmed: false, error: null, test: null })
  // Если связи нет, сервер узнает об отписке от пуш-сервиса: тот ответит, что подписки больше нет
  messenger?.setPushEndpoint(null)
  if (isNativeApp) return TmPush.unregister().catch(() => {})
  if (!supported) return
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    await (await reg?.pushManager.getSubscription())?.unsubscribe()
    await clearNotifications()
  } catch (e) {
    console.warn('Не удалось отменить подписку на уведомления', e)
  }
}

/**
 * Проверка всей цепочки: сервер шлёт пробный пуш на это устройство и сообщает ответ пуш-сервиса.
 * Service worker предупреждён и покажет уведомление, хотя приложение открыто.
 */
export async function testPush(kind?: 'call'): Promise<void> {
  if (!supported || !messenger) return
  testKind = kind
  set({ test: { text: kind ? t('push.testingCall') : t('push.testing'), ok: null } })
  try {
    if (isNativeApp) await TmPush.expectTest()
    else (await activeWorker()).active?.postMessage('pushTest')
  } catch {
    return endTest(t('push.noWorker'), false)
  }
  if (!messenger.testPush(kind)) return endTest(t('push.testOffline'), false)
  clearTimeout(testTimer)
  testTimer = setTimeout(() => endTest(t('push.testTimeout'), false), TEST_TIMEOUT_MS)
}

let testKind: 'call' | undefined

function onTestResult(status: number) {
  if (status >= 200 && status < 300) {
    endTest(
      `${testKind ? t('push.testOkCall') : t('push.testOk')} ${t('push.testOkHint')}`,
      true,
    )
  } else if (status === 404 || status === 410) {
    endTest(t('push.testGone'), false)
    void sync(true)
  } else if (status === 0) {
    endTest(isNativeApp ? t('push.testNoFirebase') : t('push.testNoService'), false)
  } else {
    endTest(t('push.testRejected', { status }), false)
  }
}
