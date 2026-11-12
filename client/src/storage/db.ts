/**
 * Локальное хранилище в IndexedDB. Всё состояние мессенджера живёт здесь:
 * очистка данных сайта = полное и безвозвратное удаление личности и переписки.
 */
import { type DBSchema, type IDBPDatabase, deleteDB, openDB } from 'idb'
import type { Identity, PendingInvite, PreKeyHeader } from '../crypto/handshake'
import type { KeyPair } from '../crypto/primitives'
import type { RatchetState } from '../crypto/ratchet'

export const DB_NAME = 'temp-messenger'

export interface Profile {
  name: string
  createdAt: number
}

export interface Contact {
  id: string
  name: string
  /** Мой ящик для этого собеседника (сюда пишет он) */
  myMailbox: string
  /** Его ящик для меня. null — пока не пришёл hello (я пригласивший). */
  theirMailbox: string | null
  ik: string
  sigPub: string | null
  createdAt: number
  /** Собеседник удалил чат: писать больше некуда */
  gone?: boolean
}

export interface Conversation {
  id: string
  kind: 'direct' | 'group'
  /** Id контактов-участников (без меня) */
  members: string[]
  title: string
  lastTs: number
  lastText: string
  unread: number
}

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'received'

export interface Message {
  id: string
  conv: string
  /** 'me' или id контакта */
  from: string
  /** Время отправки по часам отправителя */
  ts: number
  type: 'text'
  text: string
  status: MessageStatus
  /** Для входящих: отправлена ли квитанция «прочитано» */
  readSent?: boolean
}

export interface StoredSession {
  contactId: string
  state: RatchetState
  /** Пока собеседник не ответил ни разу, к сообщениям прикладывается prekey-заголовок */
  preKey?: PreKeyHeader
}

export interface OutboxItem {
  id: string
  to: string[]
  payload: string
  createdAt: number
  /** id сообщения в messages, если это пользовательское сообщение */
  msgId?: string
}

interface Schema extends DBSchema {
  meta: { key: string; value: unknown }
  invites: { key: string; value: PendingInvite }
  contacts: { key: string; value: Contact; indexes: { byMyMailbox: string } }
  conversations: { key: string; value: Conversation }
  sessions: { key: string; value: StoredSession }
  messages: { key: string; value: Message; indexes: { byConvTs: [string, number] } }
  outbox: { key: string; value: OutboxItem; indexes: { byCreated: number } }
}

export type DB = IDBPDatabase<Schema>

export function openStore(): Promise<DB> {
  return openDB<Schema>(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore('meta')
      db.createObjectStore('invites', { keyPath: 'mailbox' })
      db.createObjectStore('contacts', { keyPath: 'id' }).createIndex('byMyMailbox', 'myMailbox', { unique: true })
      db.createObjectStore('conversations', { keyPath: 'id' })
      db.createObjectStore('sessions', { keyPath: 'contactId' })
      db.createObjectStore('messages', { keyPath: 'id' }).createIndex('byConvTs', ['conv', 'ts'])
      db.createObjectStore('outbox', { keyPath: 'id' }).createIndex('byCreated', 'createdAt')
    },
    blocking() {
      // Другая вкладка хочет удалить/обновить базу — уступаем
      location.reload()
    },
  })
}

export async function wipeStore(db: DB | null): Promise<void> {
  db?.close()
  await deleteDB(DB_NAME)
  try {
    localStorage.clear()
  } catch {
    /* недоступно — не страшно */
  }
}

// --- meta ----------------------------------------------------------------

export const getIdentity = (db: DB) => db.get('meta', 'identity') as Promise<Identity | undefined>
export const getAuthKey = (db: DB) => db.get('meta', 'auth') as Promise<KeyPair | undefined>
export const getProfile = (db: DB) => db.get('meta', 'profile') as Promise<Profile | undefined>

export async function saveAccount(db: DB, identity: Identity, auth: KeyPair, profile: Profile): Promise<void> {
  const tx = db.transaction('meta', 'readwrite')
  await Promise.all([
    tx.store.put(identity, 'identity'),
    tx.store.put(auth, 'auth'),
    tx.store.put(profile, 'profile'),
    tx.done,
  ])
}

/** Все мои ящики: незакрытые приглашения + ящики контактов. */
export async function allMailboxes(db: DB): Promise<string[]> {
  return (await mailboxRegistrations(db)).map((r) => r.mailbox)
}

/** Все свои ящики с пометкой, какие из них — ещё не принятые приглашения. */
export async function mailboxRegistrations(db: DB): Promise<{ mailbox: string; invite: boolean }[]> {
  const [invites, contacts] = await Promise.all([db.getAllKeys('invites'), db.getAll('contacts')])
  return [
    ...invites.map((mailbox) => ({ mailbox, invite: true })),
    ...contacts.map((c) => ({ mailbox: c.myMailbox, invite: false })),
  ]
}

export async function listMessages(db: DB, conv: string): Promise<Message[]> {
  return db.getAllFromIndex('messages', 'byConvTs', IDBKeyRange.bound([conv, -Infinity], [conv, Infinity]))
}

export async function listConversations(db: DB): Promise<Conversation[]> {
  const all = await db.getAll('conversations')
  return all.sort((a, b) => b.lastTs - a.lastTs)
}
