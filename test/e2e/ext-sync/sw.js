// Writes through storage.sync from the service worker, the way most extensions save settings.
const ready = (async () => {
  try {
    await chrome.storage.sync.set({ v: 'from-sw' })
    await chrome.storage.local.set({ sw: 'ok' })
  } catch (e) {
    await chrome.storage.local.set({ sw: String(e) })
  }
})()
chrome.runtime.onInstalled.addListener(() => ready)
