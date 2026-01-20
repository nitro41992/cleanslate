import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { registerServiceWorker } from './lib/register-sw'

// Register service worker for offline support
if (import.meta.env.PROD) {
  registerServiceWorker().then((status) => {
    if (status.active) {
      console.log('[App] Offline support enabled')
    }
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
