const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    getPhotos: (folderPath) => ipcRenderer.invoke('get-photos', folderPath),
    onPhotosUpdated: (callback) => ipcRenderer.on('photos-updated', callback),
    removePhotosUpdatedListener: () => ipcRenderer.removeAllListeners('photos-updated'),
    convertHeic: (uint8Array) => ipcRenderer.invoke('convert-heic', uint8Array),
    isHeicSupported: () => ipcRenderer.invoke('is-heic-supported'),
    getStartupFolder: () => ipcRenderer.invoke('get-startup-folder'),
    startPowerSaveBlocking: () => ipcRenderer.invoke('start-power-save-blocking'),
    stopPowerSaveBlocking: () => ipcRenderer.invoke('stop-power-save-blocking'),
    getQRCodePath: () => ipcRenderer.invoke('get-qr-code-path'),
});
