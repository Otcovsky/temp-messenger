/**
 * Переводы интерфейса. t('ключ', { подстановки }) — строка на текущем языке.
 *
 * Язык: сохранённый выбор из настроек, иначе язык устройства, если он у нас есть, иначе английский.
 * Словари маленькие, поэтому все лежат в сборке сразу. Новый язык — это файл словаря
 * с теми же ключами, что в ru.ts, плюс строки в dicts.ts и LANGS.
 */
import { DICTS, type Lang } from './dicts'
import { ru } from './ru'
import type { Key, Params } from './types'

export type { Lang } from './dicts'
export type { Key, Params } from './types'

/** Языки в переключателе — каждый назван на самом себе */
export const LANGS: readonly { id: Lang; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'ru', name: 'Русский' },
]

const STORE_KEY = 'tm-lang'
const FALLBACK: Lang = 'en'

const isLang = (x: unknown): x is Lang => typeof x === 'string' && Object.hasOwn(DICTS, x)

function saved(): Lang | null {
  try {
    const v = localStorage.getItem(STORE_KEY)
    return isLang(v) ? v : null
  } catch {
    return null
  }
}

/** Первый из языков устройства, который мы знаем («ru-RU» → ru) */
export function deviceLang(): Lang {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  const list = nav?.languages?.length ? nav.languages : nav?.language ? [nav.language] : []
  for (const tag of list) {
    const base = tag.toLowerCase().split('-')[0]
    if (isLang(base)) return base
  }
  return FALLBACK
}

let lang: Lang = saved() ?? deviceLang()
let plural = new Intl.PluralRules(lang)
const listeners = new Set<() => void>()

function applyToDocument() {
  if (typeof document !== 'undefined') document.documentElement.lang = lang
}
applyToDocument()

export const getLang = (): Lang => lang

/** Человек уже выбирал язык (или выбор сделан за него и запомнен) */
export const hasSavedLang = (): boolean => saved() !== null

/** Сменить язык. persist — запомнить выбор для следующих запусков. */
export function setLang(next: Lang, persist = true): void {
  if (persist) {
    try {
      localStorage.setItem(STORE_KEY, next)
    } catch {
      /* без хранилища выбор проживёт до перезапуска */
    }
  }
  if (next === lang) return
  lang = next
  plural = new Intl.PluralRules(lang)
  applyToDocument()
  listeners.forEach((l) => l())
}

export function onLangChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Строка на текущем языке. Для ключа с формами множественного числа нужен params.n. */
export function t(key: Key, params?: Params): string {
  const entry = DICTS[lang][key] ?? ru[key]
  let s: string
  if (typeof entry === 'string') s = entry
  else {
    const form = plural.select(Number(params?.n ?? 0)) as keyof typeof entry
    s = entry[form] ?? entry.other
  }
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s
}
