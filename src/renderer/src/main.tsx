import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// Follow the OS: the stylesheet paints from `data-theme` on <html>.
const mq = window.matchMedia('(prefers-color-scheme: dark)')
const paint = (): void => document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light')
paint()
mq.addEventListener('change', paint)

window.addEventListener('unhandledrejection', (e) => console.error('[unhandledrejection]', e.reason))

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
