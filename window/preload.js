const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pet', {
  onState(callback) {
    ipcRenderer.on('pet:state', (_event, state) => callback(state))
  },
  onEvent(callback) {
    ipcRenderer.on('pet:event', (_event, message) => callback(message))
  },
  onAssets(callback) {
    ipcRenderer.on('pet:assets', (_event, assets) => callback(assets))
  },
  onDragEnded(callback) {
    ipcRenderer.on('pet:drag-ended', () => callback())
  },
  send(message) {
    ipcRenderer.send('pet:out', message)
  },
  setShape(rects) {
    ipcRenderer.send('pet:shape', rects)
  },
  setOverlay(open) {
    ipcRenderer.send('pet:overlay', Boolean(open))
  },
  dragStart() {
    ipcRenderer.send('pet:drag-start')
  },
  dragMove() {
    ipcRenderer.send('pet:drag-move')
  },
  dragEnd() {
    ipcRenderer.send('pet:drag-end')
  },
  quit() {
    ipcRenderer.send('pet:quit')
  },
})
