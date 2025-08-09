const { contextBridge, ipcRenderer } = require('electron');

// Secure bridge between main and renderer processes
contextBridge.exposeInMainWorld('electronAPI', {
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    getPhotos: (folderPath) => ipcRenderer.invoke('get-photos', folderPath),
    onPhotosUpdated: (callback) => ipcRenderer.on('photos-updated', callback),
    removePhotosUpdatedListener: () => ipcRenderer.removeAllListeners('photos-updated'),
    convertHeic: (uint8Array) => ipcRenderer.invoke('convert-heic', uint8Array),
    isHeicSupported: () => ipcRenderer.invoke('is-heic-supported'),
    getStartupFolder: () => ipcRenderer.invoke('get-startup-folder')
});
