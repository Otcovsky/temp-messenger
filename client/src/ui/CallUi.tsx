import { Mic, MicOff, Phone, PhoneOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type CallState, acceptCall, directAllowed, hangup, setDirectAllowed, toggleMute, useCall } from '../core/calls'
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
  if (call.phase === 'ended') return call.note ?? 'Звонок завершён'
  if (call.phase === 'incoming') return 'Входящий звонок'
  if (call.phase === 'outgoing') return 'Вызов…'
  if (call.phase === 'connecting') return 'Соединение…'
  if (call.unstable) return 'Связь прерывается…'
  return <Timer since={call.startedAt ?? Date.now()} />
}

/** Экран звонка поверх всего приложения. Виден, пока идёт звонок и пару секунд после. */
export function CallOverlay() {
  const call = useCall()
  if (!call) return null
  const ended = call.phase === 'ended'
  const round = 'grid size-16 place-items-center rounded-full text-white shadow-xl transition active:scale-95 disabled:opacity-50'
  return (
    <div
      role="dialog"
      aria-label={`Звонок: ${call.name}`}
      className="fixed inset-0 z-[70] flex flex-col items-center justify-between bg-aurora px-6 pt-[max(4rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] text-center"
    >
      <div className="flex flex-col items-center gap-4">
        <div className={call.phase === 'incoming' || call.phase === 'outgoing' ? 'animate-pulse' : ''}>
          <Avatar name={call.name} size="xl" />
        </div>
        <h2 className="max-w-[80vw] truncate text-2xl font-bold">{call.name}</h2>
        <p className="muted text-lg" role="status">
          {statusLine(call)}
        </p>
      </div>

      <div className="flex items-end justify-center gap-10">
        {call.phase === 'incoming' ? (
          <>
            <CallButton label="Отклонить">
              <button className={`${round} bg-rose-500 shadow-rose-500/30`} onClick={hangup} aria-label="Отклонить">
                <PhoneOff className="size-7" />
              </button>
            </CallButton>
            <CallButton label="Ответить">
              <button
                className={`${round} bg-emerald-500 shadow-emerald-500/30`}
                onClick={() => void acceptCall()}
                aria-label="Ответить"
              >
                <Phone className="size-7" />
              </button>
            </CallButton>
          </>
        ) : (
          <>
            {!ended && call.phase !== 'outgoing' && (
              <CallButton label={call.muted ? 'Микрофон выключен' : 'Микрофон'}>
                <button
                  className={`${round} ${call.muted ? 'bg-white text-slate-900!' : 'bg-slate-900/25 dark:bg-white/15'}`}
                  onClick={toggleMute}
                  aria-label={call.muted ? 'Включить микрофон' : 'Выключить микрофон'}
                  aria-pressed={call.muted}
                >
                  {call.muted ? <MicOff className="size-7" /> : <Mic className="size-7" />}
                </button>
              </CallButton>
            )}
            <CallButton label={ended ? 'Закрыть' : 'Завершить'}>
              <button
                className={`${round} ${ended ? 'bg-slate-500' : 'bg-rose-500 shadow-rose-500/30'}`}
                onClick={hangup}
                aria-label={ended ? 'Закрыть' : 'Завершить звонок'}
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

function CallButton({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex w-24 flex-col items-center gap-2">
      {children}
      <span className="muted text-xs">{label}</span>
    </div>
  )
}

/** Раздел настроек: как идёт звук звонка. */
export function CallsSection() {
  const [direct, setDirect] = useState(directAllowed)
  const toggle = () => {
    setDirectAllowed(!direct)
    setDirect(!direct)
  }
  return (
    <>
      <h3 className="section-title mt-6">Звонки</h3>
      <div className="grid gap-3 rounded-2xl bg-slate-900/[0.03] p-4 text-sm leading-relaxed dark:bg-white/[0.04]">
        <p className="muted">
          Звонки шифруются между устройствами. По умолчанию звук идёт через сервер, чтобы собеседник не видел ваш
          IP-адрес. Напрямую качество может быть лучше, но адрес станет виден тому, с кем вы говорите.
        </p>
        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span className="font-medium">Разрешить прямое соединение</span>
          <input type="checkbox" className="size-5 accent-violet-600" checked={direct} onChange={toggle} />
        </label>
      </div>
    </>
  )
}
