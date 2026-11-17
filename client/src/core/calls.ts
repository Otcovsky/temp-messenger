/**
 * Аудиозвонки один на один на WebRTC.
 *
 * Сигналы (offer, answer, адреса, завершение) идут обычными зашифрованными сообщениями через
 * Messenger, так что сервер о звонке не знает. Звук шифруется самим WebRTC (DTLS-SRTP), а отпечаток
 * его ключа лежит в sdp, который пришёл по сквозному каналу, — подменить собеседника нельзя.
 *
 * По умолчанию звук идёт только через TURN-сервер (если он настроен): так собеседник не видит
 * IP-адрес. Прямое соединение включается в настройках.
 *
 * Видео: в любом звонке сразу согласуется видеодорожка, пусть и пустая. Поэтому камеру можно
 * включить и выключить посреди разговора без повторного согласования — дорожке просто
 * подставляется (или убирается) источник, а собеседнику уходит сигнал call-media.
 *
 * Одновременно возможен один звонок. Состояние отдаётся React через useSyncExternalStore.
 */
import { useSyncExternalStore } from 'react'
import { randomId } from '../crypto/bytes'
import type { CallContent, CallEndReason } from '../protocol/envelope'
import { callAlert } from '../push'
import type { CallInfo, Contact } from '../storage/db'
import type { Messenger } from './messenger'

export interface CallState {
  id: string
  contactId: string
  name: string
  /** Звоню я (иначе — мне) */
  mine: boolean
  /**
   * outgoing — жду ответа; incoming — мне звонят; connecting — ответили, соединяемся;
   * active — разговор; ended — закончился (экран ещё пару секунд показывает, чем).
   */
  phase: 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended'
  muted: boolean
  /** Когда установилось соединение, мс */
  startedAt: number | null
  /** Связь пропала и, возможно, вернётся */
  unstable: boolean
  /** Чем закончился звонок — текст для человека */
  note: string | null
  /** Звонок начат как видеозвонок */
  video: boolean
  /** Моя камера включена */
  camera: boolean
  /** Камера смотрит на меня — своё изображение показываем зеркально */
  front: boolean
  /** Собеседник показывает видео */
  remoteCamera: boolean
  /** В соединении есть видеодорожка, то есть камеру можно включить */
  canVideo: boolean
}

/** Сколько исходящий вызов ждёт ответа */
const RING_MS = 45_000
/** Сколько входящий звонит, если звонящий так и не сообщил, что передумал */
const INCOMING_MS = 60_000
/** Сколько ждать соединения после ответа */
const CONNECT_MS = 25_000
/** Сколько ждать, что пропавшая связь вернётся */
const RECOVER_MS = 12_000
/** Сколько ждать сбора своих адресов перед отправкой offer/answer; опоздавшие уйдут отдельно */
const GATHER_MS = 2_500
const ENDED_SCREEN_MS = 2_200
const MAX_SDP = 20_000
const MAX_CANDIDATES = 50
/**
 * Потолок видеопотока, бит/с. Через TURN-сервер — ниже: он ограничивает каждый поток
 * (max-bps в deploy/calls-setup.sh), и видео должно уместиться вместе со звуком.
 */
const VIDEO_BITRATE_RELAY = 350_000
const VIDEO_BITRATE_DIRECT = 1_200_000
const DIRECT_FLAG = 'tm-call-direct'

interface Session {
  id: string
  contactId: string
  mine: boolean
  createdAt: number
  pc: RTCPeerConnection | null
  local: MediaStream | null
  /** sdp входящего предложения, пока на него не ответили */
  offer: string | null
  /** На звонок ответили (я или собеседник) */
  answered: boolean
  /** Моё предложение или ответ уже отправлены — можно досылать адреса */
  localSent: boolean
  remoteSet: boolean
  remoteCandidates: RTCIceCandidateInit[]
  localCandidates: RTCIceCandidateInit[]
  connectedAt: number | null
  /** Звук разрешён только через TURN (а не напрямую) */
  relayOnly: boolean
  /** TURN-сервер выдал хотя бы один адрес */
  gotRelay: boolean
  /** Звонок начат как видеозвонок или кто-то включал камеру — так он и запишется в ленту */
  video: boolean
  /** Дорожка моей камеры, пока она включена */
  camTrack: MediaStreamTrack | null
  /** Куда подставляется дорожка камеры; null — в соединении нет видео (собеседник его не умеет) */
  videoSender: RTCRtpSender | null
  facing: 'user' | 'environment'
  /** Всё, что приходит от собеседника: звук и видео */
  remote: MediaStream
  timers: Set<ReturnType<typeof setTimeout>>
  flushTimer?: ReturnType<typeof setTimeout>
  recoverTimer?: ReturnType<typeof setTimeout>
}

let messenger: Messenger | null = null
let cur: Session | null = null
let state: CallState | null = null
const listeners = new Set<() => void>()
let audio: HTMLAudioElement | null = null
/** Моя камера для окошка предпросмотра */
let preview: MediaStream | null = null
let wakeLock: { release(): Promise<void> } | null = null

function set(next: CallState | null) {
  state = next
  listeners.forEach((l) => l())
}

function patch(p: Partial<CallState>) {
  if (state) set({ ...state, ...p })
}

export function useCall(): CallState | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
  )
}

/** Разрешено ли прямое соединение (собеседник увидит IP-адрес). По умолчанию — нет. */
export function directAllowed(): boolean {
  try {
    return localStorage.getItem(DIRECT_FLAG) === '1'
  } catch {
    return false
  }
}

export function setDirectAllowed(on: boolean): void {
  try {
    if (on) localStorage.setItem(DIRECT_FLAG, '1')
    else localStorage.removeItem(DIRECT_FLAG)
  } catch {
    /* без хранилища настройка не сохранится */
  }
}

/** Потоки для экрана звонка: local — моя камера (или null), remote — собеседник. */
export function callMedia(): { local: MediaStream | null; remote: MediaStream | null } {
  return { local: preview, remote: cur?.remote ?? null }
}

/** Умеет ли браузер звонить вообще */
export function callsSupported(): boolean {
  return typeof RTCPeerConnection !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

/** Связать звонки с мессенджером. Вызывается один раз, до m.start(). */
export function initCalls(m: Messenger): void {
  messenger = m
  m.onCall = (contact, c) => void onSignal(contact, c).catch((e) => console.warn('Сигнал звонка не обработан', e))
  // Закрыли вкладку посреди звонка — собеседник не должен ждать, пока связь отвалится сама
  window.addEventListener('pagehide', () => cur && hangup())
}

// --- звук ------------------------------------------------------------------

function remoteAudio(): HTMLAudioElement {
  if (!audio) {
    audio = document.createElement('audio')
    audio.id = 'tm-call-audio'
    audio.autoplay = true
    audio.hidden = true
    document.body.append(audio)
  }
  return audio
}

/**
 * Вызывается прямо из обработчика нажатия («Позвонить», «Ответить»): iOS разрешает
 * воспроизведение, только если оно началось по действию человека.
 */
function unlockAudio() {
  void remoteAudio().play().catch(() => {})
  try {
    tones ??= new AudioContext()
    void tones.resume()
  } catch {
    /* без гудков обойдёмся */
  }
}

let tones: AudioContext | null = null
let toneTimer: ReturnType<typeof setInterval> | undefined

function beep(freq: number, at: number, len: number, gain: number) {
  if (!tones) return
  const osc = tones.createOscillator()
  const vol = tones.createGain()
  osc.frequency.value = freq
  const t = tones.currentTime + at
  vol.gain.setValueAtTime(0, t)
  vol.gain.linearRampToValueAtTime(gain, t + 0.03)
  vol.gain.setValueAtTime(gain, t + len - 0.05)
  vol.gain.linearRampToValueAtTime(0, t + len)
  osc.connect(vol).connect(tones.destination)
  osc.start(t)
  osc.stop(t + len + 0.02)
}

/** ring — мне звонят (две трели и вибрация); ringback — гудок, пока жду ответа. */
function startTone(kind: 'ring' | 'ringback') {
  stopTone()
  try {
    tones ??= new AudioContext()
    void tones.resume()
  } catch {
    return
  }
  const play = () => {
    if (kind === 'ring') {
      beep(880, 0, 0.35, 0.55)
      beep(1100, 0.45, 0.35, 0.55)
      navigator.vibrate?.([350, 100, 350])
    } else {
      beep(425, 0, 1, 0.06)
    }
  }
  play()
  toneTimer = setInterval(play, kind === 'ring' ? 2200 : 4000)
}

function stopTone() {
  clearInterval(toneTimer)
  toneTimer = undefined
  navigator.vibrate?.(0)
}

const AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
const videoOf = (facing: Session['facing']): MediaTrackConstraints => ({
  facingMode: facing,
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 24, max: 30 },
})

/**
 * Микрофон и, если просили, камера — одним запросом: на iPhone отдельный запрос камеры
 * может заглушить уже включённый микрофон. Камера недоступна — звоним без неё.
 */
async function capture(s: Session, withCamera: boolean): Promise<void> {
  if (withCamera) {
    try {
      const both = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: videoOf(s.facing) })
      s.local = new MediaStream(both.getAudioTracks())
      s.camTrack = both.getVideoTracks()[0] ?? null
      return
    } catch (e) {
      console.warn('Камера недоступна, звоню без видео', e)
    }
  }
  s.local = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: false })
}

function stopMedia(s: Session) {
  s.local?.getTracks().forEach((t) => t.stop())
  s.camTrack?.stop()
  s.camTrack = null
}

/** Показать (или убрать) свою камеру в окошке предпросмотра и в состоянии для экрана. */
function showCamera(s: Session) {
  preview = s.camTrack ? new MediaStream([s.camTrack]) : null
  if (s.camTrack) s.video = true
  patch({ camera: !!s.camTrack, front: s.facing === 'user' })
}

// --- соединение --------------------------------------------------------------

function newSession(id: string, contact: Contact, mine: boolean, video: boolean): Session {
  const s: Session = {
    id, contactId: contact.id, mine, createdAt: Date.now(), pc: null, local: null, offer: null,
    answered: false, localSent: false, remoteSet: false, remoteCandidates: [], localCandidates: [],
    connectedAt: null, relayOnly: false, gotRelay: false, video, camTrack: null, videoSender: null,
    facing: 'user', remote: new MediaStream(), timers: new Set(),
  }
  cur = s
  preview = null
  set({
    id, contactId: contact.id, name: contact.name, mine, phase: mine ? 'outgoing' : 'incoming',
    muted: false, startedAt: null, unstable: false, note: null,
    // Входящий видеозвонок: собеседник уже показывает камеру
    video, camera: false, front: true, remoteCamera: video && !mine, canVideo: false,
  })
  return s
}

/** Этот звонок всё ещё текущий? (Функцией, а не сравнением: за время await звонок мог смениться.) */
function alive(s: Session): boolean {
  return cur === s
}

function later(s: Session, ms: number, fn: () => void) {
  const t = setTimeout(() => {
    s.timers.delete(t)
    if (alive(s)) fn()
  }, ms)
  s.timers.add(t)
  return t
}

async function setupPeer(s: Session): Promise<RTCPeerConnection | null> {
  const servers = await messenger!.iceServers().catch((e) => {
    console.warn('Сервер не выдал адреса для звонка, пробую напрямую', e)
    return [] as RTCIceServer[]
  })
  if (!alive(s)) return null
  const hasTurn = servers.some((x) => !!x.credential)
  // Только через TURN — собеседник не узнает IP. Без TURN выбора нет: иначе не соединиться вовсе
  s.relayOnly = hasTurn && !directAllowed()
  const pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: s.relayOnly ? 'relay' : 'all' })
  s.pc = pc
  for (const track of s.local!.getTracks()) pc.addTrack(track, s.local!)
  // Звонящий заводит видеодорожку сам; отвечающий подключается к той, что пришла в предложении
  if (s.mine) await useVideo(s, pc.addTransceiver('video', { direction: 'sendrecv' }))
  pc.ontrack = (e) => {
    s.remote.addTrack(e.track)
    const el = remoteAudio()
    if (el.srcObject !== s.remote) el.srcObject = s.remote
    void el.play().catch((err) => console.warn('Звук собеседника не запустился', err))
  }
  pc.onicecandidate = (e) => {
    if (!e.candidate) return
    if (e.candidate.type === 'relay') s.gotRelay = true
    if (!s.localSent) return // до отправки offer/answer адреса едут внутри sdp
    s.localCandidates.push(e.candidate.toJSON())
    clearTimeout(s.flushTimer)
    s.flushTimer = setTimeout(() => flushLocalCandidates(s), 150)
  }
  pc.onconnectionstatechange = () => alive(s) && onConnection(s)
  return pc
}

/** Запомнить видеодорожку соединения и подставить в неё камеру, если она уже включена. */
async function useVideo(s: Session, t: RTCRtpTransceiver | undefined) {
  if (!t) return // собеседник видео не предлагал (клиент старой версии)
  t.direction = 'sendrecv'
  s.videoSender = t.sender
  if (s.camTrack) await t.sender.replaceTrack(s.camTrack)
  patch({ canVideo: true })
}

/** Подобрать потолок видеопотока под путь, которым пошло соединение. */
async function tuneVideo(s: Session) {
  const sender = s.videoSender
  if (!s.pc || !sender) return
  try {
    let relayed = s.relayOnly
    const stats = await s.pc.getStats()
    stats.forEach((r) => {
      if (r.type !== 'candidate-pair' || !r.nominated || r.state !== 'succeeded') return
      const local = stats.get(r.localCandidateId)
      const remote = stats.get(r.remoteCandidateId)
      if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') relayed = true
    })
    const params = sender.getParameters()
    if (!params.encodings?.length) return
    params.encodings[0].maxBitrate = relayed ? VIDEO_BITRATE_RELAY : VIDEO_BITRATE_DIRECT
    await sender.setParameters(params)
  } catch (e) {
    console.warn('Не удалось ограничить видеопоток', e)
  }
}

function flushLocalCandidates(s: Session) {
  if (!alive(s) || !s.localCandidates.length) return
  const candidates = s.localCandidates.splice(0)
  void messenger!
    .sendCall(s.contactId, { type: 'call-ice', body: { call: s.id, candidates } })
    .catch((e) => console.warn('Адреса для звонка не отправлены', e))
}

/** Дождаться, пока браузер соберёт свои адреса, но не дольше GATHER_MS. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    const check = () => pc.iceGatheringState === 'complete' && done()
    const timer = setTimeout(done, GATHER_MS)
    pc.addEventListener('icegatheringstatechange', check)
  })
}

async function addRemoteCandidates(s: Session, list: RTCIceCandidateInit[]) {
  for (const c of list) {
    try {
      await s.pc?.addIceCandidate(c)
    } catch (e) {
      console.warn('Адрес собеседника не подошёл', e)
    }
  }
}

function onConnection(s: Session) {
  const st = s.pc!.connectionState
  if (st === 'connected') {
    clearTimeout(s.recoverTimer)
    s.connectedAt ??= Date.now()
    patch({ phase: 'active', startedAt: s.connectedAt, unstable: false })
    void tuneVideo(s)
    void navigator.wakeLock
      ?.request('screen')
      .then((l) => {
        if (alive(s)) wakeLock = l
        else void l.release()
      })
      .catch(() => {})
  } else if (st === 'disconnected') {
    patch({ unstable: true })
    clearTimeout(s.recoverTimer)
    s.recoverTimer = later(s, RECOVER_MS, () => lost(s))
  } else if (st === 'failed') {
    lost(s)
  }
}

function lost(s: Session) {
  finish(s, {
    outcome: s.connectedAt ? 'answered' : 'failed',
    send: 'failed',
    note: s.connectedAt
      ? 'Связь потеряна'
      : s.relayOnly && !s.gotRelay
        ? 'Сервер звонков недоступен из этой сети'
        : 'Не удалось соединиться',
  })
}

interface Ending {
  /** Что записать в ленту чата; нет — ничего не записывать */
  outcome?: CallInfo['outcome']
  /** Сообщить собеседнику, что звонок закончен */
  send?: CallEndReason
  /** Сообщение о конце хранить на сервере долго: по нему собеседник узнает о пропущенном */
  keep?: boolean
  note: string
}

function finish(s: Session, end: Ending) {
  if (!alive(s)) return
  cur = null
  s.timers.forEach(clearTimeout)
  clearTimeout(s.flushTimer)
  stopTone()
  if (!s.mine) callAlert(end.outcome === 'missed' ? 'missed' : 'stop')
  if (s.pc) {
    s.pc.ontrack = s.pc.onicecandidate = s.pc.onconnectionstatechange = null
    s.pc.close()
  }
  stopMedia(s)
  preview = null
  if (audio) audio.srcObject = null
  void wakeLock?.release().catch(() => {})
  wakeLock = null

  const m = messenger!
  // Собеседник знает о звонке, только если до него дошло моё предложение (или звонил он сам)
  const known = !s.mine || s.localSent
  if (end.send && known) {
    void m
      .sendCall(s.contactId, { type: 'call-end', body: { call: s.id, reason: end.send } }, end.keep)
      .catch((e) => console.warn('Собеседник не узнал о конце звонка', e))
  }
  if (end.outcome && known) {
    const duration = s.connectedAt ? (Date.now() - s.connectedAt) / 1000 : undefined
    const info: CallInfo = {
      outcome: end.outcome,
      ...(end.outcome === 'answered' ? { duration } : {}),
      ...(s.video ? { video: true } : {}),
    }
    void m.addCallRecord(s.contactId, s.id, s.mine, s.createdAt, info).catch((e) => console.warn('Звонок не записан', e))
  }
  patch({ phase: 'ended', note: end.note, unstable: false, camera: false, remoteCamera: false })
  setTimeout(() => state?.id === s.id && state.phase === 'ended' && set(null), ENDED_SCREEN_MS)
}

/** Показать на экране звонка, почему он не начался, не заводя сам звонок. */
function refuse(contact: Contact, note: string) {
  const id = randomId()
  set({
    id, contactId: contact.id, name: contact.name, mine: true, phase: 'ended',
    muted: false, startedAt: null, unstable: false, note,
    video: false, camera: false, front: true, remoteCamera: false, canVideo: false,
  })
  setTimeout(() => state?.id === id && set(null), ENDED_SCREEN_MS)
}

// --- действия человека ---------------------------------------------------------

/** Позвонить собеседнику (video — сразу с камерой). Вызывать из обработчика нажатия. */
export async function startCall(contactId: string, video = false): Promise<void> {
  const m = messenger
  if (!m || cur || state) return
  const contact = await m.contact(contactId)
  if (!contact || contact.gone || !contact.theirMailbox) return
  if (!callsSupported()) return refuse(contact, 'Этот браузер не умеет звонить')
  if (m.status !== 'online') return refuse(contact, 'Нет связи с сервером')

  const s = newSession(randomId(), contact, true, video)
  unlockAudio()
  startTone('ringback')
  try {
    await capture(s, video)
  } catch (e) {
    console.warn('Микрофон недоступен', e)
    return finish(s, { note: 'Нет доступа к микрофону' })
  }
  if (!alive(s)) return stopMedia(s)
  showCamera(s)
  try {
    const pc = await setupPeer(s)
    if (!pc) return
    await pc.setLocalDescription(await pc.createOffer())
    await gathered(pc)
    if (!alive(s)) return
    // Отметка — до await: адреса, найденные, пока предложение уходит, должны уйти следом, а не пропасть
    const sdp = pc.localDescription!.sdp
    s.localSent = true
    await m.sendCall(contactId, { type: 'call-offer', body: { call: s.id, sdp, ...(s.camTrack ? { video: true } : {}) } })
  } catch (e) {
    console.warn('Звонок не начался', e)
    return finish(s, { note: 'Не удалось начать звонок' })
  }
  later(s, RING_MS, () => finish(s, { outcome: 'noanswer', send: 'timeout', keep: true, note: 'Нет ответа' }))
}

/** Ответить на входящий звонок (video — со своей камерой). Вызывать из обработчика нажатия. */
export async function acceptCall(video = false): Promise<void> {
  const s = cur
  const m = messenger
  if (!s || !m || s.mine || s.answered || !s.offer) return
  s.answered = true
  s.timers.forEach(clearTimeout)
  stopTone()
  callAlert('stop')
  unlockAudio()
  patch({ phase: 'connecting' })
  try {
    await capture(s, video)
  } catch (e) {
    console.warn('Микрофон недоступен', e)
    return finish(s, { outcome: 'failed', send: 'failed', note: 'Нет доступа к микрофону' })
  }
  if (!alive(s)) return stopMedia(s)
  showCamera(s)
  try {
    const pc = await setupPeer(s)
    if (!pc) return
    await pc.setRemoteDescription({ type: 'offer', sdp: s.offer })
    s.remoteSet = true
    await useVideo(s, pc.getTransceivers().find((t) => t.receiver.track.kind === 'video'))
    await addRemoteCandidates(s, s.remoteCandidates.splice(0))
    await pc.setLocalDescription(await pc.createAnswer())
    await gathered(pc)
    if (!alive(s)) return
    const sdp = pc.localDescription!.sdp
    s.localSent = true
    await m.sendCall(s.contactId, {
      type: 'call-answer',
      body: { call: s.id, sdp, ...(s.camTrack ? { video: true } : {}) },
    })
  } catch (e) {
    console.warn('Не удалось ответить на звонок', e)
    return finish(s, { outcome: 'failed', send: 'failed', note: 'Не удалось соединиться' })
  }
  later(s, CONNECT_MS, () => !s.connectedAt && lost(s))
}

/** Положить трубку: отклонить входящий, отменить исходящий или закончить разговор. */
export function hangup(): void {
  const s = cur
  if (!s) {
    if (state?.phase === 'ended') set(null)
    return
  }
  if (!s.answered) {
    if (s.mine) finish(s, { outcome: 'cancelled', send: 'hangup', keep: true, note: 'Звонок отменён' })
    else finish(s, { outcome: 'declined', send: 'decline', note: 'Звонок отклонён' })
  } else {
    finish(s, { outcome: s.connectedAt ? 'answered' : 'failed', send: 'hangup', note: 'Звонок завершён' })
  }
}

export function toggleMute(): void {
  const s = cur
  if (!s?.local || !state) return
  const muted = !state.muted
  s.local.getAudioTracks().forEach((t) => (t.enabled = !muted))
  patch({ muted })
}

/** Включить или выключить свою камеру посреди звонка. Вызывать из обработчика нажатия. */
export async function toggleCamera(): Promise<void> {
  const s = cur
  if (!s?.videoSender || !s.answered) return
  if (s.camTrack) {
    s.camTrack.stop()
    s.camTrack = null
    await s.videoSender.replaceTrack(null).catch(() => {})
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: videoOf(s.facing) })
      if (!alive(s)) return stream.getTracks().forEach((t) => t.stop())
      s.camTrack = stream.getVideoTracks()[0]
      await s.videoSender.replaceTrack(s.camTrack)
    } catch (e) {
      console.warn('Камера недоступна', e)
      s.camTrack?.stop()
      s.camTrack = null
    }
  }
  if (!alive(s)) return
  showCamera(s)
  void messenger!
    .sendCall(s.contactId, { type: 'call-media', body: { call: s.id, video: !!s.camTrack } })
    .catch((e) => console.warn('Собеседник не узнал о камере', e))
}

/** Переключить камеру: передняя ↔ задняя. */
export async function switchCamera(): Promise<void> {
  const s = cur
  if (!s?.videoSender || !s.camTrack) return
  const facing = s.facing === 'user' ? 'environment' : 'user'
  // Сначала отпускаем прежнюю: многие телефоны не дают открыть две камеры сразу
  s.camTrack.stop()
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoOf(facing) })
    if (!alive(s)) return stream.getTracks().forEach((t) => t.stop())
    s.facing = facing
    s.camTrack = stream.getVideoTracks()[0]
  } catch (e) {
    console.warn('Вторая камера недоступна, возвращаю прежнюю', e)
    try {
      const back = await navigator.mediaDevices.getUserMedia({ video: videoOf(s.facing) })
      if (!alive(s)) return back.getTracks().forEach((t) => t.stop())
      s.camTrack = back.getVideoTracks()[0]
    } catch {
      s.camTrack = null
    }
  }
  await s.videoSender.replaceTrack(s.camTrack).catch(() => {})
  if (!alive(s)) return
  const was = state?.camera
  showCamera(s)
  if (was && !s.camTrack) {
    void messenger!.sendCall(s.contactId, { type: 'call-media', body: { call: s.id, video: false } }).catch(() => {})
  }
}

// --- сигналы от собеседника -------------------------------------------------------

async function onSignal(contact: Contact, c: CallContent): Promise<void> {
  const m = messenger!
  const id = c.body.call
  switch (c.type) {
    case 'call-offer': {
      const sdp = c.body.sdp
      if (typeof sdp !== 'string' || !sdp || sdp.length > MAX_SDP) return
      if (cur?.id === id) return // повторная доставка
      if (cur && cur.contactId === contact.id && cur.mine && !cur.answered) {
        // Позвонили друг другу одновременно. Остаётся звонок с меньшим id: так решат обе стороны
        if (cur.id < id) return
        const mine = cur
        cur = null
        mine.timers.forEach(clearTimeout)
        clearTimeout(mine.flushTimer)
        mine.pc?.close()
        stopMedia(mine)
      } else if (cur || !callsSupported()) {
        // Уже говорю с другим (или звонить отсюда нельзя): звонившему — «занято», себе — пропущенный
        void m.sendCall(contact.id, { type: 'call-end', body: { call: id, reason: 'busy' } }).catch(() => {})
        return m.addCallRecord(contact.id, id, false, c.ts, { outcome: 'missed' })
      }
      const s = newSession(id, contact, false, c.body.video === true)
      s.offer = sdp
      startTone('ring')
      callAlert('ring')
      later(s, INCOMING_MS, () => finish(s, { outcome: 'missed', note: 'Пропущенный звонок' }))
      return
    }
    case 'call-answer': {
      const s = cur
      const sdp = c.body.sdp
      if (!s || s.id !== id || !s.mine || s.answered || !s.pc) return
      if (typeof sdp !== 'string' || !sdp || sdp.length > MAX_SDP) return
      s.answered = true
      s.timers.forEach(clearTimeout)
      stopTone()
      if (c.body.video === true) s.video = true
      patch({ phase: 'connecting', remoteCamera: c.body.video === true })
      try {
        await s.pc.setRemoteDescription({ type: 'answer', sdp })
        s.remoteSet = true
        await addRemoteCandidates(s, s.remoteCandidates.splice(0))
      } catch (e) {
        console.warn('Ответ на звонок не подошёл', e)
        return finish(s, { outcome: 'failed', send: 'failed', note: 'Не удалось соединиться' })
      }
      later(s, CONNECT_MS, () => !s.connectedAt && lost(s))
      return
    }
    case 'call-ice': {
      const s = cur
      if (!s || s.id !== id || !Array.isArray(c.body.candidates)) return
      const list = c.body.candidates
        .slice(0, MAX_CANDIDATES)
        .filter((x) => x && typeof x === 'object' && typeof x.candidate === 'string')
      if (s.remoteSet) await addRemoteCandidates(s, list)
      else s.remoteCandidates.push(...list)
      return
    }
    case 'call-media': {
      const s = cur
      if (!s || s.id !== id) return
      const on = c.body.video === true
      if (on) s.video = true
      patch({ remoteCamera: on })
      return
    }
    case 'call-end': {
      const s = cur
      const reason = c.body.reason
      if (!s || s.id !== id) {
        // Звонок, которого я не видел: предложение истекло, пока меня не было в сети.
        // Запись о своём звонке с этим id уже есть — тогда addCallRecord ничего не изменит.
        if (reason === 'timeout' || reason === 'hangup') {
          callAlert('missed')
          return m.addCallRecord(contact.id, id, false, c.ts, { outcome: 'missed' })
        }
        return
      }
      if (s.answered) {
        finish(s, { outcome: s.connectedAt ? 'answered' : 'failed', note: s.connectedAt ? 'Звонок завершён' : 'Не удалось соединиться' })
      } else if (!s.mine) {
        finish(s, { outcome: 'missed', note: 'Пропущенный звонок' })
      } else if (reason === 'decline') {
        finish(s, { outcome: 'declined', note: 'Звонок отклонён' })
      } else if (reason === 'busy') {
        finish(s, { outcome: 'busy', note: 'Собеседник занят' })
      } else {
        finish(s, { outcome: 'failed', note: 'Не удалось соединиться' })
      }
      return
    }
  }
}
