import { contextBridge, ipcRenderer } from 'electron'
import { injectBrowserAction } from 'electron-chrome-extensions/browser-action'

injectBrowserAction()

const listen = (channel: string) => (cb: (data: unknown) => void) => {
  const fn = (_e: unknown, data: unknown) => cb(data)
  ipcRenderer.on(channel, fn)
  return () => ipcRenderer.removeListener(channel, fn)
}

contextBridge.exposeInMainWorld('drift', {
  rpc: (name: string, params: Record<string, unknown> = {}) => ipcRenderer.invoke('rpc', name, params),
  state: () => ipcRenderer.invoke('ui:state'),
  onState: listen('state'),
  onAction: listen('action'),
  onTransition: listen('transition'),
  onTransitionEnd: listen('transitionEnd'),
  overlay: (on: boolean) => ipcRenderer.send('ui:overlay', on),
  freeze: () => ipcRenderer.invoke('ui:freeze'),
  thaw: () => ipcRenderer.send('ui:thaw'),
  transitionDone: (id: number) => ipcRenderer.send('ui:transitionDone', id),
  focusPage: () => ipcRenderer.send('ui:focusPage'),
  focusUi: () => ipcRenderer.send('ui:focusUi'),
})
