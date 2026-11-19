import { Fragment, type ReactNode, useSyncExternalStore } from 'react'
import { type Key, getLang, onLangChange, t } from '.'

/** Текущий язык; компонент перерисуется, когда его сменят в настройках. */
export function useLang() {
  return useSyncExternalStore(onLangChange, getLang)
}

/**
 * Перевод с элементами внутри: rich('accept.invites', { name: <b>Аня</b> }).
 * {ключ} заменяется элементом, \n — переносом строки.
 */
export function rich(key: Key, parts: Record<string, ReactNode>): ReactNode {
  return t(key)
    .split('\n')
    .map((line, i) => (
      <Fragment key={i}>
        {i > 0 && <br />}
        {line.split(/(\{\w+\})/).map((chunk, j) => {
          const m = chunk.match(/^\{(\w+)\}$/)
          return <Fragment key={j}>{m && m[1] in parts ? parts[m[1]] : chunk}</Fragment>
        })}
      </Fragment>
    ))
}
