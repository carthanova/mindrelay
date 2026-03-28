// Bridge to the mindrelay-host native binary.
// Fire-and-forget — the extension never blocks on the host.
// Gracefully degrades if the host is not installed.

const HOST_NAME = "com.mindrelay.host"

let port: chrome.runtime.Port | null = null

function getPort(): chrome.runtime.Port | null {
  if (port) return port
  try {
    port = chrome.runtime.connectNative(HOST_NAME)
    port.onDisconnect.addListener(() => {
      port = null
    })
    return port
  } catch {
    return null
  }
}

export function sendToHost(message: Record<string, unknown>): void {
  const p = getPort()
  if (!p) return
  try {
    p.postMessage(message)
  } catch {
    port = null
  }
}
