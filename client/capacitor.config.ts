import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Android-приложение: та же сборка клиента (dist), упакованная в WebView.
 * Код лежит внутри APK, а не грузится с сервера: подменить его на сервере нельзя.
 * Страница открывается с https://localhost, поэтому адрес сервера задаётся при сборке
 * (VITE_SERVER_ORIGIN, см. src/platform.ts), а сервер разрешает этот адрес для /blob (CORS).
 */
const config: CapacitorConfig = {
  appId: 'tech.tempmessenger.app',
  appName: 'Temp Messenger',
  webDir: 'dist',
  android: {
    // Отладка WebView через chrome://inspect — только в отладочной сборке
    webContentsDebuggingEnabled: false,
  },
}

export default config
