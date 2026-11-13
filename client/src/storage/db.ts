/**
 * Локальное хранилище в IndexedDB. Всё состояние мессенджера живёт здесь:
 * очистка данных сайта = полное и безвозвратное удаление личности и переписки.
 */
import { type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames, deleteDB, openDB } from 'idb'
import type { Identity, PendingInvite, PreKeyHeader } from '../crypto/handshake'
import { type KeyPair, KEY_PROBE_DB } from '../crypto/primitives'
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
  /** Писать больше некуда: собеседник удалил чат или сервер не нашёл его ящик */
  gone?: boolean
  /**
   * Откуда известно, что писать некуда. 'goodbye' — собеседник сам удалил чат, это навсегда.
   * 'no_mailbox' — так ответил сервер: ящик мог просто истечь, и если собеседник снова
   * напишет, пометка снимается. Нет значения — запись от прежней версии.
   */
  goneBy?: 'goodbye' | 'no_mailbox'
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
  type: 'text' | 'file'
  /** У файла — подпись к нему (или пустая строка) */
  text: string
  status: MessageStatus
  /** Для входящих: отправлена ли квитанция «прочитано» */
  readSent?: boolean
  file?: FileInfo
  /**
   * Незаконченная передача файла: 'up' — ещё не загружен на сервер, 'down' — ещё не скачан.
   * По этому полю (индекс byTransfer) передачи возобновляются после перезапуска.
   */
  transfer?: 'up' | 'down'
  /** Файлы, отправленные одной пачкой, показываются одним пузырём-альбомом */
  album?: string
}

export interface FileInfo {
  name: string
  mime: string
  /** Размер исходного файла */
  size: number
  /** id зашифрованного файла на сервере */
  blob: string
  /** Ключ шифрования файла, base64url */
  key: string
  /**
   * ready — файл есть в базе (таблица files); loading — скачивается;
   * error — скачать или расшифровать не удалось, можно повторить; gone — на сервере его уже нет.
   */
  state: 'ready' | 'loading' | 'error' | 'gone'
  /**
   * Размер картинки в пикселях — запоминается локально при первом показе, по сети не передаётся.
   * Зная его, лента сразу занимает под картинку место и не прыгает, пока та грузится.
   */
  w?: number
  h?: number
}

/** Содержимое файла. Ключ — id сообщения. */
export interface StoredFile {
  id: string
  data: ArrayBuffer
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
  messages: { key: string; value: Message; indexes: { byConvTs: [string, number]; byTransfer: string } }
  files: { key: string; value: StoredFile }
  outbox: { key: string; value: OutboxItem; indexes: { byCreated: number } }
}

export type DB = IDBPDatabase<Schema>

export function openStore(): Promise<DB> {
  return openDB<Schema>(DB_NAME, 2, {
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        db.createObjectStore('meta')
        db.createObjectStore('invites', { keyPath: 'mailbox' })
        db.createObjectStore('contacts', { keyPath: 'id' }).createIndex('byMyMailbox', 'myMailbox', { unique: true })
        db.createObjectStore('conversations', { keyPath: 'id' })
        db.createObjectStore('sessions', { keyPath: 'contactId' })
        db.createObjectStore('messages', { keyPath: 'id' }).createIndex('byConvTs', ['conv', 'ts'])
        db.createObjectStore('outbox', { keyPath: 'id' }).createIndex('byCreated', 'createdAt')
      }
      if (oldVersion < 2) {
        // Файлы
        tx.objectStore('messages').createIndex('byTransfer', 'transfer')
        db.createObjectStore('files', { keyPath: 'id' })
      }
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
  await deleteDB(KEY_PROBE_DB).catch(() => {}) // след проверки ключей в старых версиях
  try {
    localStorage.clear()
  } catch {
    /* недоступно — не страшно */
  }
}

type Stores = StoreNames<Schema>[]
export type WriteTx<S extends Stores> = IDBPTransaction<Schema, S, 'readwrite'>

/**
 * Запись в несколько хранилищ: либо всё, либо ничего. Простое Promise.all([put…, tx.done])
 * этого не гарантирует: если put бросает синхронно (например, DataCloneError, когда браузер
 * не умеет сохранить ключ), уже поставленные в очередь операции молча фиксируются.
 */
export async function writeAll<S extends Stores>(
  db: DB,
  stores: S,
  ops: (tx: WriteTx<S>) => Promise<unknown>[],
): Promise<void> {
  const tx = db.transaction(stores, 'readwrite')
  tx.done.catch(() => {}) // ошибку отдаём ниже; здесь — только чтобы не было «необработанного» отказа
  try {
    await Promise.all([...ops(tx), tx.done])
  } catch (e) {
    try {
      tx.abort()
    } catch {
      /* уже завершена или откатана */
    }
    throw e
  }
}

/**
 * Чтение и запись одной транзакцией: либо всё, либо ничего. Внутри fn можно ждать только
 * операции самой транзакции — на любом другом await браузер её закроет.
 */
export async function transact<S extends Stores, T>(db: DB, stores: S, fn: (tx: WriteTx<S>) => Promise<T>): Promise<T> {
  const tx = db.transaction(stores, 'readwrite')
  tx.done.catch(() => {})
  try {
    const out = await fn(tx)
    await tx.done
    return out
  } catch (e) {
    try {
      tx.abort()
    } catch {
      /* уже завершена или откатана */
    }
    throw e
  }
}

// --- meta ----------------------------------------------------------------

export const getIdentity = (db: DB) => db.get('meta', 'identity') as Promise<Identity | undefined>
export const getAuthKey = (db: DB) => db.get('meta', 'auth') as Promise<KeyPair | undefined>
export const getProfile = (db: DB) => db.get('meta', 'profile') as Promise<Profile | undefined>

export async function saveAccount(db: DB, identity: Identity, auth: KeyPair, profile: Profile): Promise<void> {
  await writeAll(db, ['meta'], (tx) => {
    const meta = tx.objectStore('meta')
    return [meta.put(identity, 'identity'), meta.put(auth, 'auth'), meta.put(profile, 'profile')]
  })
}

// --- ящики, которые надо закрыть на сервере ----------------------------------
// Хранятся, пока сервер не ответит unregistered: без связи закроем при следующем подключении.

const UNREGISTER = 'unregister'

export async function pendingUnregisters(db: DB): Promise<string[]> {
  return ((await db.get('meta', UNREGISTER)) as string[] | undefined) ?? []
}

async function editUnregisters(db: DB, fn: (list: string[]) => string[]): Promise<void> {
  const tx = db.transaction('meta', 'readwrite')
  const list = ((await tx.store.get(UNREGISTER)) as string[] | undefined) ?? []
  await Promise.all([tx.store.put(fn(list), UNREGISTER), tx.done])
}

export const queueUnregister = (db: DB, mailbox: string) =>
  editUnregisters(db, (list) => (list.includes(mailbox) ? list : [...list, mailbox]))

export const dequeueUnregister = (db: DB, mailbox: string) =>
  editUnregisters(db, (list) => list.filter((mb) => mb !== mailbox))

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
