/**
 * Где запущен клиент: на сайте (в браузере или установленным PWA) или внутри Android-приложения.
 */
import { Capacitor } from '@capacitor/core'

/** Внутри нативного приложения (Capacitor), а не в браузере */
export const isNativeApp = Capacitor.isNativePlatform()

/** Сервер по умолчанию для приложения, если при сборке не задан VITE_SERVER_ORIGIN */
const DEFAULT_APP_SERVER = 'https://chat.tempmessenger.tech'

/**
 * Адрес сервера (https://host). Сайт работает с тем сервером, откуда загружен.
 * Приложение открывается с https://localhost, поэтому его сервер зашит при сборке.
 */
export function serverOrigin(): string {
  return isNativeApp
    ? (import.meta.env.VITE_SERVER_ORIGIN || DEFAULT_APP_SERVER).replace(/\/+$/, '')
    : location.origin
}
