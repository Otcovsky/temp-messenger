import type { ru } from './ru'

/** Ключ перевода. Набор ключей задаёт русский словарь. */
export type Key = keyof typeof ru
/** Формы множественного числа по Intl.PluralRules; чего у языка нет — берётся other */
export type Plural = { one: string; few?: string; many?: string; other: string }
export type Entry = string | Plural
/** Словарь языка: ровно те же ключи, что в ru.ts */
export type Dict = { [K in Key]: Entry }
export type Params = Record<string, string | number>
