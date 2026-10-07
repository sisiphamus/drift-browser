import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import { App } from './App'
import './styles.css'

// Dropped links and files must never navigate the browser UI itself.
for (const ev of ['dragover', 'drop']) document.addEventListener(ev, (e) => e.preventDefault())

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="user">
    <App />
  </MotionConfig>,
)
