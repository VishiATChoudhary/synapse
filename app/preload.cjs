// Bridge between the renderer and the main process. Nothing from Node leaks into the page.
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch, args) => ipcRenderer.invoke(ch, args).then((r) => { if (!r.ok) throw new Error(r.error); return r.value; });
const on = (ch, fn) => { const h = (_e, a) => fn(a); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

contextBridge.exposeInMainWorld('synapse', {
  state: () => call('state'),
  flags: () => call('flags'),
  onState: (fn) => on('state', fn),
  pty: {
    spawn: (a) => call('pty:spawn', a),
    write: (id, data) => call('pty:write', { id, data }),
    resize: (id, cols, rows) => call('pty:resize', { id, cols, rows }),
    kill: (id) => call('pty:kill', { id }),
    onData: (fn) => on('pty:data', fn),
    onExit: (fn) => on('pty:exit', fn),
  },
  fork: { spawn: (a) => call('fork:spawn', a), onRequest: (fn) => on('fork:request', fn) },
  project: {
    add: (p) => call('project:add', { path: p }),
    create: (name) => call('project:create', { name }),
    clone: (url, name) => call('project:clone', { url, name }),
    pick: () => call('project:pick'),
    library: () => call('project:library'),
    onCloneProgress: (fn) => on('clone:progress', fn),
  },
  worktree: { add: (a) => call('worktree:add', a), remove: (a) => call('worktree:remove', a) },
  settings: { get: () => call('settings:get'), set: (patch) => call('settings:set', patch) },
  cli: (args, as) => call('synapse', { args, as }),
  canvas: () => call('canvas'),
  onCanvasToggle: (fn) => on('canvas:toggle', fn),
});
