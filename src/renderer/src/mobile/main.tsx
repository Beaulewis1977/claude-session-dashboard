import './install'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MobileApp } from './MobileApp'
import '../styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>
)

// Installable to the home screen. Needs a trusted certificate (Tailscale has
// one); with home Wi-Fi's self-signed one it may be refused, which is fine.
if ('serviceWorker' in navigator && window.isSecureContext)
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
