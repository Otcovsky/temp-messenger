/**
 * Первичный обмен ключами через приглашение (упрощённый X3DH без сервера prekeys).
 *
 * Пригласивший (A) передаёт по стороннему каналу (ссылка/QR): IK_A, SIG_A, E_A, ящик M_A.
 * Принявший (B) создаёт одноразовый EK_B и считает
 *   SK = HKDF(0xFF*32 || DH(IK_B, E_A) || DH(EK_B, IK_A) || DH(EK_B, E_A))
 * и запускает Double Ratchet, где E_A служит первым ratchet-ключом A.
 * A получает IK_B и EK_B в заголовке первого сообщения и считает то же SK.
 *
 * IK_B в заголовке зашифрован ключом из DH(EK_B, E_A): заголовок видит сервер, а ключ
 * личности у человека один на все чаты — по открытому IK_B сервер связал бы их между собой.
 */
import { type Bytes, b64d, b64e, compare, concat, randomId, utf8 } from './bytes'
import { type KeyPair, aesGcmDecrypt, aesGcmEncrypt, dh, generateDH, hkdf, sha256 } from './primitives'
import { type RatchetState, initReceiver, initSender } from './ratchet'

export interface Identity {
  dh: KeyPair // X25519 — ключ личности для обмена ключами
  sig: KeyPair // Ed25519 — для подписей (понадобится для групп)
}

/** То, что лежит в ссылке-приглашении. Ключи — base64url. */
export interface InvitePayload {
  v: 1
  ik: string
  sk: string
  e: string
  m: string
  n?: string // отображаемое имя пригласившего (необязательно)
}

/** Заголовок первых сообщений принявшего, пока пригласивший не ответил. */
export interface PreKeyHeader {
  /** IK принявшего, зашифрованный (48 байт). Клиенты до этой правки слали его открытым (32 байта). */
  ik: string
  ek: string
  e: string
}

const F = new Uint8Array(32).fill(0xff)
const ZERO32 = new Uint8Array(32)
const INFO = utf8('TM-X3DH-v1')
const INFO_PREKEY = utf8('TM-PreKey-v1')

/**
 * Ключ и IV, которыми закрыт IK принявшего в prekey-заголовке. EK_B одноразовый, и шифруется
 * этим ключом ровно одно значение, поэтому постоянный IV безопасен.
 */
async function preKeySeal(dhEphemeral: Bytes): Promise<[Bytes, Bytes]> {
  const out = await hkdf(dhEphemeral, ZERO32, INFO_PREKEY, 44)
  return [out.slice(0, 32), out.slice(32)]
}

async function deriveSK(dh1: Bytes, dh2: Bytes, dh3: Bytes): Promise<Bytes> {
  return hkdf(concat(F, dh1, dh2, dh3), ZERO32, INFO, 32)
}

export interface PendingInvite {
  mailbox: string
  ephemeral: KeyPair
  payload: InvitePayload
  createdAt: number
}

export async function createInvite(id: Identity, name?: string): Promise<PendingInvite> {
  const ephemeral = await generateDH()
  const mailbox = randomId()
  const payload: InvitePayload = { v: 1, ik: b64e(id.dh.pub), sk: b64e(id.sig.pub), e: b64e(ephemeral.pub), m: mailbox }
  if (name) payload.n = name.slice(0, 64)
  return { mailbox, ephemeral, payload, createdAt: Date.now() }
}

export function encodeInvite(p: InvitePayload): string {
  return b64e(utf8(JSON.stringify(p)))
}

export function decodeInvite(s: string): InvitePayload {
  const p = JSON.parse(new TextDecoder().decode(b64d(s.trim())))
  const ok =
    p && p.v === 1 && [p.ik, p.sk, p.e].every((k: unknown) => typeof k === 'string' && b64d(k).length === 32) &&
    typeof p.m === 'string' && /^[A-Za-z0-9_-]{22}$/.test(p.m) && (p.n === undefined || typeof p.n === 'string')
  if (!ok) throw new Error('Неверное приглашение')
  return p as InvitePayload
}

/** Сторона B: принять приглашение. Возвращает сессию и заголовок для первых сообщений. */
export async function acceptInvite(
  me: Identity,
  invite: InvitePayload,
): Promise<{ session: RatchetState; preKey: PreKeyHeader }> {
  const ikA = b64d(invite.ik)
  const eA = b64d(invite.e)
  const ek = await generateDH()
  const dh3 = await dh(ek.priv, eA)
  const sk = await deriveSK(await dh(me.dh.priv, eA), await dh(ek.priv, ikA), dh3)
  const session = await initSender(sk, eA, concat(me.dh.pub, ikA))
  const [key, iv] = await preKeySeal(dh3)
  const sealedIk = await aesGcmEncrypt(key, iv, me.dh.pub, concat(ek.pub, eA))
  return { session, preKey: { ik: b64e(sealedIk), ek: b64e(ek.pub), e: invite.e } }
}

/** Сторона A: получила первое сообщение по своему приглашению. Возвращает сессию и IK принявшего. */
export async function completeInvite(
  me: Identity,
  invite: PendingInvite,
  pk: PreKeyHeader,
): Promise<{ session: RatchetState; theirIk: Bytes }> {
  if (pk.e !== invite.payload.e) throw new Error('Сообщение не к этому приглашению')
  const ekB = b64d(pk.ek)
  const e = invite.ephemeral
  const dh3 = await dh(e.priv, ekB)
  let ikB = b64d(pk.ik)
  if (ikB.length !== 32) {
    // 32 байта — открытый IK от клиента до этой правки, иначе — зашифрованный
    const [key, iv] = await preKeySeal(dh3)
    ikB = await aesGcmDecrypt(key, iv, ikB, concat(ekB, e.pub))
    if (ikB.length !== 32) throw new Error('bad prekey header')
  }
  const sk = await deriveSK(await dh(e.priv, ikB), await dh(me.dh.priv, ekB), dh3)
  return { session: initReceiver(sk, e, concat(ikB, me.dh.pub)), theirIk: ikB }
}

/**
 * Код безопасности: одинаковый у обоих собеседников. Если совпадает при сверке
 * вживую или по другому каналу — посредника (MITM) нет.
 */
export async function safetyNumber(myIk: Bytes, theirIk: Bytes): Promise<string> {
  const [a, b] = [myIk, theirIk].sort(compare)
  const h = await sha256(utf8('TM-Safety-v1'), a, b)
  const groups: string[] = []
  for (let i = 0; i < 12; i++) {
    const v = ((h[i * 2] << 16) | (h[i * 2 + 1] << 8) | h[24 + (i % 8)]) % 100000
    groups.push(v.toString().padStart(5, '0'))
  }
  return groups.join(' ')
}
