// Reports what storage.sync gives a content script.
;(async () => {
  const el = document.documentElement
  try {
    const r = await chrome.storage.sync.get('v')
    const l = await chrome.storage.local.get('sw')
    el.dataset.sync = `${r.v ?? 'none'}|${l.sw ?? 'none'}`
  } catch (e) {
    el.dataset.sync = 'error:' + e
  }
})()
