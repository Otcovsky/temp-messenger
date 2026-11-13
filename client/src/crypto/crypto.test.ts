import { describe, expect, it } from 'vitest'
import { type Bytes, b64d, b64e, pad, unpad, utf8, fromUtf8 } from './bytes'
import { acceptInvite, completeInvite, createInvite, decodeInvite, encodeInvite, safetyNumber, type Identity } from './handshake'
import { _forceFallback, dh, generateDH, generateSigning, sign, verify } from './primitives'
import { type RatchetState, ratchetDecrypt, ratchetEncrypt } from './ratchet'

async function identity(): Promise<Identity> {
  return { dh: await generateDH(), sig: await generateSigning() }
}

async function pair() {
  const alice = await identity()
  const bob = await identity()
  const invite = await createInvite(alice, 'Алиса')
  const parsed = decodeInvite(encodeInvite(invite.payload))
  const { session: bobS, preKey } = await acceptInvite(bob, parsed)
  const { session: aliceS, theirIk } = await completeInvite(alice, invite, preKey)
  return { alice, bob, aliceS, bobS, invite, preKey, theirIk }
}

async function enc(s: RatchetState, text: string) {
  const r = await ratchetEncrypt(s, utf8(text))
  return { s: r.state, msg: { h: r.header, ct: r.ciphertext } }
}

async function dec(s: RatchetState, m: { h: any; ct: Bytes }) {
  const r = await ratchetDecrypt(s, m.h, m.ct)
  return { s: r.state, text: fromUtf8(r.plaintext) }
}

describe('handshake + double ratchet', () => {
  it('обмен в обе стороны с несколькими DH-шагами', async () => {
    let { aliceS, bobS } = await pair()
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 3; i++) {
        const e = await enc(bobS, `b${round}${i}`)
        bobS = e.s
        const d = await dec(aliceS, e.msg)
        aliceS = d.s
        expect(d.text).toBe(`b${round}${i}`)
      }
      const e = await enc(aliceS, `a${round}`)
      aliceS = e.s
      const d = await dec(bobS, e.msg)
      bobS = d.s
      expect(d.text).toBe(`a${round}`)
    }
  })

  it('сообщения не по порядку и через смену ключей', async () => {
    let { aliceS, bobS } = await pair()
    const m: { h: any; ct: Bytes }[] = []
    for (const t of ['1', '2', '3']) {
      const e = await enc(bobS, t)
      bobS = e.s
      m.push(e.msg)
    }
    let d = await dec(aliceS, m[2]) // сначала третье
    aliceS = d.s
    expect(d.text).toBe('3')
    // Алиса отвечает — у Боба будет новый DH-шаг
    const r = await enc(aliceS, 'ok')
    aliceS = r.s
    bobS = (await dec(bobS, r.msg)).s
    const e4 = await enc(bobS, '4')
    bobS = e4.s
    aliceS = (await dec(aliceS, e4.msg)).s
    // запоздавшие сообщения из старой цепочки
    d = await dec(aliceS, m[0])
    aliceS = d.s
    expect(d.text).toBe('1')
    d = await dec(aliceS, m[1])
    expect(d.text).toBe('2')
  })

  it('подделанный шифротекст отвергается, состояние не портится', async () => {
    let { aliceS, bobS } = await pair()
    const e = await enc(bobS, 'secret')
    const bad = { h: e.msg.h, ct: e.msg.ct.slice() as Bytes }
    bad.ct[0] ^= 1
    await expect(dec(aliceS, bad)).rejects.toThrow()
    expect((await dec(aliceS, e.msg)).text).toBe('secret')
  })

  it('повтор сообщения не расшифровывается второй раз', async () => {
    let { aliceS, bobS } = await pair()
    const e = await enc(bobS, 'once')
    aliceS = (await dec(aliceS, e.msg)).s
    await expect(dec(aliceS, e.msg)).rejects.toThrow()
  })

  it('ключ личности принявшего не виден в prekey-заголовке', async () => {
    const { alice, bob, invite, preKey, theirIk } = await pair()
    expect(theirIk).toEqual(bob.dh.pub)
    expect(b64d(preKey.ik).length).toBe(48)
    expect(JSON.stringify(preKey)).not.toContain(b64e(bob.dh.pub))
    // подменённый заголовок не принимается
    const forged = { ...preKey, ik: b64e(b64d(preKey.ik).map((x, i) => (i ? x : x ^ 1))) }
    await expect(completeInvite(alice, invite, forged)).rejects.toThrow()
  })

  it('открытый ключ личности от старого клиента принимается', async () => {
    const { alice, bob, invite, preKey, aliceS, bobS } = await pair()
    const legacy = await completeInvite(alice, invite, { ...preKey, ik: b64e(bob.dh.pub) })
    expect(legacy.theirIk).toEqual(bob.dh.pub)
    expect(legacy.session.rk).toEqual(aliceS.rk)
    const e = await enc(bobS, 'привет')
    expect((await dec(legacy.session, e.msg)).text).toBe('привет')
  })

  it('код безопасности одинаковый у обоих', async () => {
    const { alice, bob } = await pair()
    const a = await safetyNumber(alice.dh.pub, bob.dh.pub)
    const b = await safetyNumber(bob.dh.pub, alice.dh.pub)
    expect(a).toBe(b)
    expect(a).toMatch(/^(\d{5} ){11}\d{5}$/)
  })

  it('padding скрывает длину', () => {
    expect(pad(utf8('hi')).length).toBe(256)
    expect(pad(new Uint8Array(255)).length).toBe(256)
    expect(pad(new Uint8Array(256)).length).toBe(512)
    expect(fromUtf8(unpad(pad(utf8('привет'))))).toBe('привет')
  })

  it('битое приглашение не принимается', () => {
    expect(() => decodeInvite('abc')).toThrow()
    expect(b64d('AQID')).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('запасная JS-реализация совместима с Web Crypto', async () => {
    _forceFallback(false)
    const nat = { dh: await generateDH(), sig: await generateSigning() }
    _forceFallback(true)
    try {
      const js = { dh: await generateDH(), sig: await generateSigning() }
      expect(js.dh.priv).toBeInstanceOf(Uint8Array)
      expect(nat.dh.priv).not.toBeInstanceOf(Uint8Array)
      // DH в обе стороны даёт один и тот же секрет
      expect(await dh(js.dh.priv, nat.dh.pub)).toEqual(await dh(nat.dh.priv, js.dh.pub))
      // Подписи проверяются крест-накрест
      const data = utf8('tm')
      expect(await verify(nat.sig.pub, await sign(nat.sig.priv, data), data)).toBe(true)
      _forceFallback(false)
      expect(await verify(js.sig.pub, await sign(js.sig.priv, data), data)).toBe(true)
      _forceFallback(true)
      // Полный обмен: пригласил «нативный», принял «JS»
      const invite = await createInvite(nat, 'A')
      const { session: bobS, preKey } = await acceptInvite(js, decodeInvite(encodeInvite(invite.payload)))
      const { session: aliceS } = await completeInvite(nat, invite, preKey)
      const e = await enc(bobS, 'привет')
      expect((await dec(aliceS, e.msg)).text).toBe('привет')
    } finally {
      _forceFallback(false)
    }
  })
})
