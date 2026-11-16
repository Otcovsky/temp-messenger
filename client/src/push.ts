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
  /** Почему подписка не удалась (текст для человека) */
  error: string | null
}

const FLAG = 'tm-push'
/** Метка всех наших уведомлений: новое заменяет старое, а не копится */
const TAG = 'tm-msg'

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
  error: null,
}
const listeners = new Set<() => void>()
let messenger: Messenger | null = null

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

/** Связать пуши с мессенджером. Вызывается один раз, до m.start(). */
export function initPush(m: Messenger): void {
  messenger = m
  m.onPush = (e) => {
    if (e.t === 'ready') {
      set({ serverReady: !!m.pushKey })
      void sync()
    } else if (!e.ok) {
      set({ error: refusal(e.code) })
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

/**
 * Привести подписку в соответствие с настройкой. Вызывается при каждом подключении:
 * браузер может сменить адрес подписки сам, а сервер — потерять её или сменить ключ.
 */
async function sync(): Promise<void> {
  const m = messenger
  if (!supported || !m || !state.enabled) return
  const key = m.pushKey
  if (!key) return
  set({ permission: Notification.permission })
  if (Notification.permission !== 'granted') {
    // Разрешение отозвали в настройках браузера
    writeFlag(false)
    set({ enabled: false })
    m.setPushEndpoint(null)
    return
  }
  try {
    const reg = await navigator.serviceWorker.ready
    let sub = await reg.pushManager.getSubscription()
    const subKey = sub?.options.applicationServerKey
    if (sub && (!subKey || b64e(new Uint8Array(subKey)) !== key)) {
      await sub.unsubscribe() // подписка выдана под другой ключ сервера
      sub = null
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64d(key) })
    set({ error: null })
    m.setPushEndpoint(sub.endpoint)
  } catch (e) {
    console.warn('Не удалось подписаться на уведомления', e)
    set({ error: 'Браузер не выдал подписку на уведомления. Проверьте связь и попробуйте ещё раз.' })
  }
}

/** Включить уведомления. Вызывать только из обработчика нажатия: иначе браузер не спросит разрешение. */
export async function enablePush(): Promise<void> {
  if (!supported) return
  const permission = await Notification.requestPermission()
  set({ permission, error: null })
  if (permission !== 'granted') return
  writeFlag(true)
  set({ enabled: true })
  await sync()
}

export async function disablePush(): Promise<void> {
  writeFlag(false)
  set({ enabled: false, error: null })
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
