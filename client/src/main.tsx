import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initAppUpdate } from './appUpdate'
import { useLang } from './i18n/react'
import { initLangSync } from './i18n/sync'
import { initPwa } from './pwa'
import { App } from './ui/App'
import { UpdateToast } from './ui/PwaUi'
import './ui/styles.css'

initPwa()
initAppUpdate()
initLangSync()

/** Язык сменили в настройках — перерисовывается всё дерево, состояние (чаты, звонок) остаётся. */
function Root() {
  useLang()
  return (
    <>
      <App />
      <UpdateToast />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
