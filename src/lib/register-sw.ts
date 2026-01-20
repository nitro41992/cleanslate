export interface ServiceWorkerStatus {
  supported: boolean
  registered: boolean
  active: boolean
  updateAvailable: boolean
}

let registration: ServiceWorkerRegistration | null = null

export async function registerServiceWorker(): Promise<ServiceWorkerStatus> {
  const status: ServiceWorkerStatus = {
    supported: false,
    registered: false,
    active: false,
    updateAvailable: false,
  }

  if (!('serviceWorker' in navigator)) {
    console.log('[SW] Service workers not supported')
    return status
  }

  status.supported = true

  try {
    registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
    })

    status.registered = true
    console.log('[SW] Service worker registered with scope:', registration.scope)

    // Check for updates periodically
    setInterval(() => {
      registration?.update()
    }, 60 * 60 * 1000) // Check every hour

    // Handle update found
    registration.addEventListener('updatefound', () => {
      const newWorker = registration?.installing
      if (!newWorker) return

      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          status.updateAvailable = true
          console.log('[SW] New version available')

          // Notify the app that an update is available
          window.dispatchEvent(new CustomEvent('sw-update-available'))
        }
      })
    })

    // Check if there's already an active service worker
    if (registration.active) {
      status.active = true
    }

    // Wait for the service worker to be ready
    await navigator.serviceWorker.ready
    status.active = true
    console.log('[SW] Service worker is ready')

    return status
  } catch (error) {
    console.error('[SW] Service worker registration failed:', error)
    return status
  }
}

export function getRegistration(): ServiceWorkerRegistration | null {
  return registration
}

export async function unregisterServiceWorker(): Promise<boolean> {
  if (!registration) return false

  try {
    const success = await registration.unregister()
    if (success) {
      registration = null
      console.log('[SW] Service worker unregistered')
    }
    return success
  } catch (error) {
    console.error('[SW] Failed to unregister service worker:', error)
    return false
  }
}

export function skipWaiting(): void {
  if (registration?.waiting) {
    registration.waiting.postMessage({ type: 'SKIP_WAITING' })
  }
}

export async function clearCache(): Promise<boolean> {
  const controller = navigator.serviceWorker.controller
  if (!controller) return false

  return new Promise((resolve) => {
    const messageChannel = new MessageChannel()

    messageChannel.port1.onmessage = (event) => {
      resolve(event.data?.success || false)
    }

    controller.postMessage(
      { type: 'CLEAR_CACHE' },
      [messageChannel.port2]
    )
  })
}

export function isOffline(): boolean {
  return !navigator.onLine
}

export function addOnlineListener(callback: () => void): () => void {
  window.addEventListener('online', callback)
  return () => window.removeEventListener('online', callback)
}

export function addOfflineListener(callback: () => void): () => void {
  window.addEventListener('offline', callback)
  return () => window.removeEventListener('offline', callback)
}
