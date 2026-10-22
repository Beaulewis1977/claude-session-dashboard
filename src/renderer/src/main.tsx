import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { MiniMeter } from './components/usage/MiniMeter'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{window.location.hash === '#mini' ? <MiniMeter /> : <App />}</StrictMode>
)
