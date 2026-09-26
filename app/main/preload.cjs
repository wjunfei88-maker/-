const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pc', {
  info: () => ipcRenderer.invoke('app:info'),
  pickImages: () => ipcRenderer.invoke('dialog:pickImages'),
  pickFolder: (title) => ipcRenderer.invoke('dialog:pickFolder', title),
  pickFile: (title) => ipcRenderer.invoke('dialog:pickFile', title),
  importImages: (paths) => ipcRenderer.invoke('images:import', paths),
  packLayout: (images, opts) => ipcRenderer.invoke('layout:pack', images, opts),
  planLayout: (images, opts) => ipcRenderer.invoke('layout:plan', images, opts),
  compose: (payload) => ipcRenderer.invoke('export:compose', payload),
  split: (payload) => ipcRenderer.invoke('recover:split', payload),
  library: () => ipcRenderer.invoke('library:list'),
  forget: (id) => ipcRenderer.invoke('library:forget', id),
  findManifestFor: (file) => ipcRenderer.invoke('manifest:findFor', file),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),

  // 从拖入的 File 对象拿到真实磁盘路径（Electron 32+ 必须走 webUtils）
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },

  onProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('progress', h);
    return () => ipcRenderer.removeListener('progress', h);
  },
});
