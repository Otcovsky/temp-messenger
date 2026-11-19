/**
 * Язык нужен и там, где страницы нет: уведомления по пушу показывает service worker (sw.js)
 * или Android-приложение (TmNotifier). Им выбранный язык передаётся заранее:
 * service worker'у — через Cache Storage (localStorage ему недоступен), приложению — плагином.
 */
import { getLang, onLangChange } from '.'
import { TmPush } from '../native'
import { isNativeApp } from '../platform'

/** Те же имена читает sw.js. Кеш не начинается с «tm-»: такие sw.js удаляет при обновлении. */
const PREFS_CACHE = 'prefs'
const LANG_URL = '/__prefs/lang'

async function share(lang: string) {
  if (isNativeApp) return TmPush.setLanguage({ lang }).catch(() => {})
  if (typeof caches === 'undefined') return
  try {
    const cache = await caches.open(PREFS_CACHE)
    await cache.put(LANG_URL, new Response(lang, { headers: { 'Content-Type': 'text/plain' } }))
  } catch {
    /* без Cache Storage уведомления будут на языке устройства */
  }
}

export function initLangSync(): void {
  void share(getLang())
  onLangChange(() => void share(getLang()))
}
