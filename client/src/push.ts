/**
 * Пуш-уведомления: подписка браузера у его пуш-сервиса и передача её адреса ретранслятору.
 *
 * Пуш приходит пустым — в нём нет ни текста, ни отправителя; service worker показывает
 * одно и то же «Новое сообщение». Включаются только явным нажатием в настройках.
 * Состояние отдаётся React через useSyncExternalStore, как в pwa.ts.
 */
import { useSyncExternalStore } from 'react'
import type { Messenger } from './core/messenger'
import { b64d, b64e } from './crypto/bytes'

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
/** Метка всех наших уведомлений: новое заменяет старое, а не копится */
const TAG = 'tm-msg'
/** Сколько ждать service worker: без него подписаться нельзя, а ждать вечно незачем */
const SW_TIMEOUT_MS = 8_000
const TEST_TIMEOUT_MS = 20_000

const supported =
  import.meta.env.PROD &&
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in globalThis &&
  'Notification' in globalThis

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
  permission: supported ? Notification.permission : 'default',
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
  return code === 'bad_endpoint'
    ? 'Сервер не знает пуш-сервис этого браузера. Попробуйте Chrome, Firefox или Safari.'
    : 'Сервер не поддерживает уведомления.'
}

function endTest(text: string, ok: boolean) {
  clearTimeout(testTimer)
  set({ test: { text, ok } })
}

/** Связать пуши с мессенджером. Вызывается один раз, до m.start(). */
export function initPush(m: Messenger): void {
  messenger = m
  m.onPush = (e) => {
    if (e.t === 'ready') {
      set({ serverReady: !!m.pushKey, confirmed: false })
      void sync()
    } else if (e.t === 'test') {
      onTestResult(e.status)
    } else if (e.ok) {
      set({ confirmed: true, error: null })
    } else if (e.code === 'no_subscription') {
      // Сервер подписку не знает (потерял или её удалил пуш-сервис) — заводим заново
      set({ confirmed: false })
      endTest('Сервер не знал подписку этого устройства. Отправил её заново — нажмите «Проверить» ещё раз.', false)
      void sync()
    } else {
      set({ confirmed: false, error: refusal(e.code) })
    }
  }
  if (!supported) return
  // Приложение на экране — уведомления больше не нужны
  const clear = () => document.visibilityState === 'visible' && void clearNotifications()
  document.addEventListener('visibilitychange', clear)
  clear()
}

async function clearNotifications() {
  const reg = await navigator.serviceWorker.getRegistration()
  for (const n of (await reg?.getNotifications({ tag: TAG })) ?? []) n.close()
}

function activeWorker(): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('service worker не запущен')), SW_TIMEOUT_MS)),
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
    if (!m.setPushEndpoint(sub.endpoint)) set({ error: 'Нет связи с сервером. Подписка отправится, когда связь появится.' })
  } catch (e) {
    console.warn('Не удалось подписаться на уведомления', e)
    const why = e instanceof Error ? e.message : String(e)
    set({ error: `Браузер не выдал подписку на уведомления (${why}). Проверьте связь и попробуйте ещё раз.` })
  }
}

/** Включить уведомления. Вызывать только из обработчика нажатия: иначе браузер не спросит разрешение. */
export async function enablePush(): Promise<void> {
  if (!supported) return
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
export async function testPush(): Promise<void> {
  if (!supported || !messenger) return
  set({ test: { text: 'Отправляю пробное уведомление…', ok: null } })
  try {
    ;(await activeWorker()).active?.postMessage('pushTest')
  } catch {
    return endTest('Service worker не запущен — перезапустите приложение.', false)
  }
  if (!messenger.testPush()) return endTest('Нет связи с сервером.', false)
  clearTimeout(testTimer)
  testTimer = setTimeout(() => endTest('Сервер не ответил на проверку.', false), TEST_TIMEOUT_MS)
}

function onTestResult(status: number) {
  if (status >= 200 && status < 300) {
    endTest(
      'Пуш-сервис принял уведомление — оно должно появиться за несколько секунд. Если его нет, проверьте в ' +
        'настройках телефона, что браузеру (или приложению) разрешены уведомления и не включён режим «Не беспокоить».',
      true,
    )
  } else if (status === 404 || status === 410) {
    endTest('Пуш-сервис ответил, что подписки больше нет. Получаю новую — нажмите «Проверить» ещё раз.', false)
    void sync(true)
  } else if (status === 0) {
    endTest('Сервер не смог связаться с пуш-сервисом браузера.', false)
  } else {
    endTest(`Пуш-сервис отклонил уведомление (HTTP ${status}).`, false)
  }
}
