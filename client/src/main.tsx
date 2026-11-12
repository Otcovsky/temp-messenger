import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initPwa } from './pwa'
import { App } from './ui/App'
import { UpdateToast } from './ui/PwaUi'
import './ui/styles.css'

initPwa()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <UpdateToast />
  </StrictMode>,
)
