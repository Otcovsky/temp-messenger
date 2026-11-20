import { afterEach, describe, expect, it } from 'vitest'
import { conversationPreview, messageLabel } from '../core/messenger'
import type { Conversation, Message } from '../storage/db'
import { en } from './en'
import { setLang, t } from '.'
import { ru } from './ru'
import { uk } from './uk'
import type { Entry, Key } from './types'

const forms = (e: Entry) => (typeof e === 'string' ? [e] : Object.values(e).filter((x): x is string => !!x))
const params = (e: Entry) => new Set(forms(e).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1])))

afterEach(() => setLang('ru', false))

describe('словари', () => {
  it('в переводе те же подстановки, что в русском', () => {
    for (const key of Object.keys(ru) as Key[]) {
      for (const dict of [en, uk]) expect([...params(dict[key])].sort(), key).toEqual([...params(ru[key])].sort())
    }
  })

  it('формы множественного числа выбираются по правилам языка', () => {
    setLang('ru', false)
    expect([1, 3, 5, 11, 21, 22].map((n) => t('file.count', { n }))).toEqual([
      '1 файл', '3 файла', '5 файлов', '11 файлов', '21 файл', '22 файла',
    ])
    setLang('en', false)
    expect([1, 2, 21].map((n) => t('group.members', { n }))).toEqual(['1 member', '2 members', '21 members'])
    setLang('uk', false)
    expect([1, 3, 5, 11, 21, 22].map((n) => t('file.count', { n }))).toEqual([
      '1 файл', '3 файли', '5 файлів', '11 файлів', '21 файл', '22 файли',
    ])
  })

  it('незнакомая подстановка остаётся как есть', () => {
    setLang('en', false)
    expect(t('note.joined')).toBe('{name} joined the group')
  })
})

describe('строки, записанные в базу', () => {
  const note: Message = {
    id: '1', conv: 'g', from: '', ts: 0, type: 'note', text: 'Аня теперь в группе', status: 'received',
    note: { k: 'joined', name: 'Аня' },
  }
  const conv: Conversation = {
    id: 'c', kind: 'direct', members: [], title: 'Боб', lastTs: 0, unread: 0,
    lastText: 'Пропущенный звонок', lastLabel: { call: { outcome: 'missed' }, mine: false },
  }

  it('служебная строка и звонок показываются на текущем языке', () => {
    setLang('en', false)
    expect(messageLabel(note)).toBe('Аня joined the group')
    expect(conversationPreview(conv)).toBe('Missed call')
    setLang('ru', false)
    expect(messageLabel(note)).toBe('Аня теперь в группе')
  })

  it('старая запись без пометки — как была', () => {
    setLang('en', false)
    expect(messageLabel({ ...note, note: undefined })).toBe('Аня теперь в группе')
    expect(conversationPreview({ ...conv, lastLabel: undefined })).toBe('Пропущенный звонок')
  })
})
