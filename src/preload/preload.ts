import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  listClients:     (rootPath: string) => ipcRenderer.invoke('fs:listClients', rootPath),
  listDocs:        (clientPath: string) => ipcRenderer.invoke('fs:listDocs', clientPath),
  readPdf:         (filePath: string) => ipcRenderer.invoke('fs:readPdf', filePath),
  saveAnnotations: (pdfPath: string, annotations: unknown) => ipcRenderer.invoke('fs:saveAnnotations', pdfPath, annotations),
  moveFile:        (srcPath: string, destFolder: string) => ipcRenderer.invoke('fs:moveFile', srcPath, destFolder),
  renameFile:      (filePath: string, newName: string) => ipcRenderer.invoke('fs:renameFile', filePath, newName),
  getAnnotations:  (pdfPath: string) => ipcRenderer.invoke('fs:getAnnotations', pdfPath),
  combineFiles:    (topPath: string, bottomPath: string) => ipcRenderer.invoke('fs:combineFiles', topPath, bottomPath),
  scan:            () => ipcRenderer.invoke('fs:scan'),
  pickFolder:      () => ipcRenderer.invoke('fs:pickFolder'),
  deleteFile:      (p:string) => ipcRenderer.invoke('fs:deleteFile', p),
  copyFile:        (p:string) => ipcRenderer.invoke('fs:copyFile', p),
  savePdf:         (p:string, b:ArrayBuffer) => ipcRenderer.invoke('fs:savePdf', p, b),
  renameFolder:    (p:string, n:string) => ipcRenderer.invoke('fs:renameFolder', p, n),
})
