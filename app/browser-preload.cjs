// Bridge for a popped-out agent browser window: its bar asks the main process to go back, reload, dock and so on.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('agentBrowser', {
  user: (action, args) => ipcRenderer.invoke('browser-window:user', { action, args }),
  onState: (fn) => ipcRenderer.on('agent-browser:state', (_e, s) => fn(s)),
});
