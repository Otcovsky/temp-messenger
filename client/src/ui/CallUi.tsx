import { Mic, MicOff, Phone, PhoneOff, SwitchCamera, Video, VideoOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  type CallState,
  acceptCall,
  callMedia,
  directAllowed,
  hangup,
  setDirectAllowed,
  switchCamera,
  toggleCamera,
  toggleMute,
  useCall,
} from '../core/calls'
import { t } from '../i18n'
import { Avatar } from './Avatar'

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Длительность разговора, обновляется раз в секунду. */
function Timer({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  return <span className="tabular-nums">{clock((now - since) / 1000)}</span>
}

function statusLine(call: CallState) {
  if (call.phase === 'ended') return call.note ? t(call.note) : t('call.ended')
  if (call.phase === 'incoming') return call.video ? t('call.incomingVideo') : t('call.incoming')
  if (call.phase === 'outgoing') return call.video ? t('call.callingVideo') : t('call.calling')
  if (call.phase === 'connecting') return t('call.connecting')
  if (call.unstable) return t('call.unstable')
  return <Timer since={call.startedAt ?? Date.now()} />
}

/** Видео из потока. Звук всегда выключен: голос собеседника играет отдельный аудиоэлемент. */
function Stream({ stream, className, label }: { stream: MediaStream; className: string; label: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream
    void el.play().catch(() => {})
  }, [stream])
  return <video ref={ref} className={className} aria-label={label} autoPlay playsInline muted />
}

/** Экран звонка поверх всего приложения. Виден, пока идёт звонок и пару секунд после. */
export function CallOverlay() {
  const call = useCall()
  if (!call) return null
  const ended = call.phase === 'ended'
  const talking = call.phase === 'connecting' || call.phase === 'active'
  const { local, remote } = callMedia()
  /** Собеседник на весь экран; поверх него текст и кнопки — светлые на затемнении */
  const remoteVideo = talking && call.remoteCamera && remote
  const round = 'grid size-16 place-items-center rounded-full text-white shadow-xl transition active:scale-95 disabled:opacity-50'
  const plain = remoteVideo ? 'bg-white/20 backdrop-blur-md' : 'bg-slate-900/25 dark:bg-white/15'
  const caption = remoteVideo ? 'text-white/85' : 'muted'
  const touch = navigator.maxTouchPoints > 0

  return (
    <div
      role="dialog"
      aria-label={t('call.dialog', { name: call.name })}
      className={`fixed inset-0 z-[70] flex flex-col items-center justify-between px-6 pt-[max(4rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] text-center ${remoteVideo ? 'bg-black' : 'bg-aurora'}`}
    >
      {remoteVideo && (
        <>
          <Stream stream={remote} label={t('call.video', { name: call.name })} className="absolute inset-0 size-full object-contain" />
          <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/60 to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-black/70 to-transparent" />
        </>
      )}
      {call.camera && local && !ended && (
        <Stream
          stream={local}
          label={t('call.myCamera')}
          className={`absolute top-[max(1rem,env(safe-area-inset-top))] right-4 z-10 aspect-[3/4] w-24 rounded-2xl bg-black object-cover shadow-2xl ring-1 ring-white/20 sm:w-32 ${call.front ? '-scale-x-100' : ''}`}
        />
      )}

      <div className={`relative flex flex-col items-center gap-4 ${remoteVideo ? 'text-white [text-shadow:0_1px_8px_rgb(0_0_0/0.6)]' : ''}`}>
        {!remoteVideo && (
          <div className={call.phase === 'incoming' || call.phase === 'outgoing' ? 'animate-pulse' : ''}>
            <Avatar name={call.name} size="xl" />
          </div>
        )}
        <h2 className={`max-w-[80vw] truncate font-bold ${remoteVideo ? 'text-lg' : 'text-2xl'}`}>{call.name}</h2>
        <p className={`${remoteVideo ? 'text-white/90' : 'muted text-lg'}`} role="status">
          {statusLine(call)}
        </p>
      </div>

      <div className="relative flex items-start justify-center gap-x-3 sm:gap-x-6">
        {call.phase === 'incoming' ? (
          <>
            <CallButton label={t('call.decline')} caption={caption}>
              <button className={`${round} bg-rose-500 shadow-rose-500/30`} onClick={hangup} aria-label={t('call.decline')}>
                <PhoneOff className="size-7" />
              </button>
            </CallButton>
            <CallButton label={call.video ? t('call.noVideo') : t('call.answer')} caption={caption}>
              <button
                className={`${round} bg-emerald-500 shadow-emerald-500/30`}
                onClick={() => void acceptCall()}
                aria-label={call.video ? t('call.answerNoVideo') : t('call.answer')}
              >
                <Phone className="size-7" />
              </button>
            </CallButton>
            {call.video && (
              <CallButton label={t('call.withVideo')} caption={caption}>
                <button
                  className={`${round} bg-emerald-500 shadow-emerald-500/30`}
                  onClick={() => void acceptCall(true)}
                  aria-label={t('call.answerVideo')}
                >
                  <Video className="size-7" />
                </button>
              </CallButton>
            )}
          </>
        ) : (
          <>
            {talking && (
              <CallButton label={call.muted ? t('call.micOff') : t('call.mic')} caption={caption}>
                <button
                  className={`${round} ${call.muted ? 'bg-white text-slate-900!' : plain}`}
                  onClick={toggleMute}
                  aria-label={call.muted ? t('call.micOn') : t('call.micMute')}
                  aria-pressed={call.muted}
                >
                  {call.muted ? <MicOff className="size-7" /> : <Mic className="size-7" />}
                </button>
              </CallButton>
            )}
            {talking && call.canVideo && (
              <CallButton label={call.camera ? t('call.cam') : t('call.camOff')} caption={caption}>
                <button
                  className={`${round} ${call.camera ? plain : 'bg-white text-slate-900!'}`}
                  onClick={() => void toggleCamera()}
                  aria-label={call.camera ? t('call.camMute') : t('call.camOn')}
                  aria-pressed={call.camera}
                >
                  {call.camera ? <Video className="size-7" /> : <VideoOff className="size-7" />}
                </button>
              </CallButton>
            )}
            {talking && call.camera && touch && (
              <CallButton label={t('call.switch')} caption={caption}>
                <button className={`${round} ${plain}`} onClick={() => void switchCamera()} aria-label={t('call.switchCamera')}>
                  <SwitchCamera className="size-7" />
                </button>
              </CallButton>
            )}
            <CallButton label={ended ? t('common.close') : t('call.hangup')} caption={caption}>
              <button
                className={`${round} ${ended ? 'bg-slate-500' : 'bg-rose-500 shadow-rose-500/30'}`}
                onClick={hangup}
                aria-label={ended ? t('common.close') : t('call.hangupLong')}
              >
                <PhoneOff className="size-7" />
              </button>
            </CallButton>
          </>
        )}
      </div>
    </div>
  )
}

function CallButton({ label, caption, children }: { label: string; caption: string; children: React.ReactNode }) {
  return (
    <div className="flex w-[4.5rem] flex-col items-center gap-2">
      {children}
      <span className={`text-xs leading-tight ${caption}`}>{label}</span>
    </div>
  )
}

/** Раздел настроек: как идёт звук и видео звонка. */
export function CallsSection() {
  const [direct, setDirect] = useState(directAllowed)
  const toggle = () => {
    setDirectAllowed(!direct)
    setDirect(!direct)
  }
  return (
    <>
      <h3 className="section-title mt-6">{t('calls.title')}</h3>
      <div className="grid gap-3 rounded-2xl bg-slate-900/[0.03] p-4 text-sm leading-relaxed dark:bg-white/[0.04]">
        <p className="muted">
          {t('calls.explain')}
        </p>
        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span className="font-medium">{t('calls.direct')}</span>
          <input type="checkbox" className="size-5 accent-violet-600" checked={direct} onChange={toggle} />
        </label>
      </div>
    </>
  )
}
