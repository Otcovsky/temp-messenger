/** Все словари. Отдельным модулем — его читает и сборка (vite.config.ts → тексты уведомлений в sw.js). */
import { en } from './en'
import { ru } from './ru'
import { uk } from './uk'
import type { Dict } from './types'

export type Lang = 'ru' | 'en' | 'uk'

export const DICTS: Record<Lang, Dict> = { ru, en, uk }
