const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getStatus: () => ipcRenderer.invoke('status:get'),
  getResumeStatus: () => ipcRenderer.invoke('resume:get'),
  reloadResume: () => ipcRenderer.invoke('resume:reload'),
  startRecording: () => ipcRenderer.invoke('recording:start'),
  submitQuestion: (text) => ipcRenderer.invoke('question:submit', text),
  abortAnswer: () => ipcRenderer.invoke('answer:abort'),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  cancelRecording: () => ipcRenderer.invoke('recording:cancel'),
  sendPcm: (arrayBuffer) => ipcRenderer.send('audio:pcm', arrayBuffer),
  on: (channel, callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
