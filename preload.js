const { contextBridge, ipcRenderer } = require('electron');

/** 渲染进程可用的桥接口。只暴露具名方法，不放开任意通道。 */
contextBridge.exposeInMainWorld('api', {
  // 运行状态
  getStatus: () => ipcRenderer.invoke('status:get'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  // 录音与提问
  startRecording: () => ipcRenderer.invoke('recording:start'),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  cancelRecording: () => ipcRenderer.invoke('recording:cancel'),
  submitQuestion: (text) => ipcRenderer.invoke('question:submit', text),
  abortAnswer: () => ipcRenderer.invoke('answer:abort'),
  sendPcm: (arrayBuffer) => ipcRenderer.send('audio:pcm', arrayBuffer),

  // 音频采集权限（系统声音 / 麦克风）
  getCaptureStatus: () => ipcRenderer.invoke('capture:status'),
  requestMicrophone: () => ipcRenderer.invoke('capture:requestMicrophone'),
  openPrivacySettings: (kind) => ipcRenderer.invoke('capture:openPrivacy', kind),

  // 简历
  getResumeStatus: () => ipcRenderer.invoke('resume:get'),
  reloadResume: () => ipcRenderer.invoke('resume:reload'),

  // 首次启动引导
  getSetupState: () => ipcRenderer.invoke('setup:get'),
  saveSetup: (patch) => ipcRenderer.invoke('setup:save', patch),
  finishSetup: () => ipcRenderer.invoke('setup:finish'),
  pickResumeFiles: () => ipcRenderer.invoke('setup:pickResume'),

  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  removeResume: (name) => ipcRenderer.invoke('settings:resumeRemove', name),
  revealResumeDir: () => ipcRenderer.invoke('settings:revealResumeDir'),
  revealConfig: () => ipcRenderer.invoke('settings:revealConfig'),
  testDeepSeek: () => ipcRenderer.invoke('settings:testDeepSeek'),
  testMimo: () => ipcRenderer.invoke('settings:testMimo'),

  // 自动更新
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openUpdatePage: () => ipcRenderer.invoke('update:openPage'),

  // 主进程事件订阅，返回取消订阅函数
  on: (channel, callback) => {
    const allowed = [
      'status',
      'transcript:partial',
      'transcript:final',
      'answer:start',
      'answer:delta',
      'answer:done',
      'resume:status',
      'update',
      'error',
    ];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
