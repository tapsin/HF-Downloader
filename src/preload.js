const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hf', {
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  getToken: () => ipcRenderer.invoke('get-token'),
  saveToken: (token) => ipcRenderer.invoke('save-token', token),
  inspect: (payload) => ipcRenderer.invoke('inspect-repo', payload),
  download: (payload) => ipcRenderer.invoke('download-repo', payload),
  onProgress: (callback) => ipcRenderer.on('download-progress', (_, data) => callback(data))
});
