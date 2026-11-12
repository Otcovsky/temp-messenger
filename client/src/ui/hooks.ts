import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import type { Messenger } from '../core/messenger'

export const MessengerContext = createContext<Messenger | null>(null)

export function useMessenger(): Messenger {
  const m = useContext(MessengerContext)
  if (!m) throw new Error('MessengerContext не задан')
  return m
}

/** Версия данных: меняется при любом изменении в мессенджере. */
export function useVersion(): number {
  const m = useMessenger()
  return useSyncExternalStore(
    (cb) => m.subscribe(cb),
    () => m.version,
  )
}

/** Асинхронный запрос к хранилищу, который перевыполняется при изменениях. */
export function useLive<T>(fn: (m: Messenger) => Promise<T>, deps: unknown[]): T | undefined {
  const m = useMessenger()
  const version = useVersion()
  const [value, setValue] = useState<T>()
  useEffect(() => {
    let alive = true
    fn(m).then((v) => alive && setValue(v))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, version, ...deps])
  return value
}
