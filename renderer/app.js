/* ============================================================================
   面试问答助手 · 渲染层
   职责边界：只负责界面与音频采集，所有网络请求与配置读写都在主进程。
   ========================================================================== */

const $ = (id) => document.getElementById(id);

const el = {
  chat: $('chat'),
  emptyTip: $('emptyTip'),
  statusText: $('statusText'),
  resumeBadge: $('resumeBadge'),
  settingsBtn: $('settingsBtn'),
  questionInput: $('questionInput'),
  sendBtn: $('sendBtn'),
  recordBtn: $('recordBtn'),
  recordBtnText: $('recordBtnText'),
  hintText: $('hintText'),
  levelWrap: $('levelWrap'),
  levelBar: $('levelBar'),
  sourceSwitch: $('sourceSwitch'),
  micSelect: $('micSelect'),
  toasts: $('toasts'),

  setupOverlay: $('setupOverlay'),
  setupSteps: $('setupSteps'),
  setupPrevBtn: $('setupPrevBtn'),
  setupNextBtn: $('setupNextBtn'),
  setupSkipBtn: $('setupSkipBtn'),
  setupDeepseekKey: $('setupDeepseekKey'),
  setupMimoKey: $('setupMimoKey'),
  setupDeepseekBase: $('setupDeepseekBase'),
  setupMimoBase: $('setupMimoBase'),
  setupTestBtn: $('setupTestBtn'),
  setupProbeDeepseek: $('setupProbeDeepseek'),
  setupProbeMimo: $('setupProbeMimo'),
  setupAdvancedBtn: $('setupAdvancedBtn'),
  setupAdvanced: $('setupAdvanced'),
  setupPickBtn: $('setupPickBtn'),
  setupSkipResumeBtn: $('setupSkipResumeBtn'),
  setupResumeList: $('setupResumeList'),
  setupResumeHint: $('setupResumeHint'),
  setupPrivacyLead: $('setupPrivacyLead'),
  setupPrivacyCallout: $('setupPrivacyCallout'),
  setupPrivacyTitle: $('setupPrivacyTitle'),
  setupPrivacyText: $('setupPrivacyText'),
  setupPrivacyBtn: $('setupPrivacyBtn'),
  setupCheckList: $('setupCheckList'),
  setupSourceSwitch: $('setupSourceSwitch'),
  setupSourceHint: $('setupSourceHint'),
  setupMicField: $('setupMicField'),
  setupMicSelect: $('setupMicSelect'),
  setupMicHint: $('setupMicHint'),
  setupProbeBtn: $('setupProbeBtn'),
  setupProbeResult: $('setupProbeResult'),

  drawerMask: $('drawerMask'),
  settingsDrawer: $('settingsDrawer'),
  settingsCloseBtn: $('settingsCloseBtn'),
  settingsTabs: $('settingsTabs'),
  settingsSaveBtn: $('settingsSaveBtn'),
  settingsNote: $('settingsNote'),
  setDeepseekKey: $('setDeepseekKey'),
  setDeepseekKeyState: $('setDeepseekKeyState'),
  setDeepseekBase: $('setDeepseekBase'),
  setDeepseekModel: $('setDeepseekModel'),
  setMimoKey: $('setMimoKey'),
  setMimoKeyState: $('setMimoKeyState'),
  setMimoBase: $('setMimoBase'),
  setMimoModel: $('setMimoModel'),
  setTestDeepseekBtn: $('setTestDeepseekBtn'),
  setTestMimoBtn: $('setTestMimoBtn'),
  setProbeDeepseek: $('setProbeDeepseek'),
  setProbeMimo: $('setProbeMimo'),
  setMaxChars: $('setMaxChars'),
  setHistory: $('setHistory'),
  setReasoning: $('setReasoning'),
  setContextMode: $('setContextMode'),
  setResumeEnabled: $('setResumeEnabled'),
  setSourceSwitch: $('setSourceSwitch'),
  setSourceHint: $('setSourceHint'),
  setMicField: $('setMicField'),
  setMicSelect: $('setMicSelect'),
  setMicHint: $('setMicHint'),
  setProbeRecordBtn: $('setProbeRecordBtn'),
  setProbeRecordResult: $('setProbeRecordResult'),
  setTargetSeconds: $('setTargetSeconds'),
  setMaxSeconds: $('setMaxSeconds'),
  setSilence: $('setSilence'),
  setPickResumeBtn: $('setPickResumeBtn'),
  setReloadResumeBtn: $('setReloadResumeBtn'),
  setOpenDirBtn: $('setOpenDirBtn'),
  setResumeList: $('setResumeList'),
  aboutList: $('aboutList'),
  aboutConfigBtn: $('aboutConfigBtn'),
  aboutResumeBtn: $('aboutResumeBtn'),
  updateHint: $('updateHint'),
  updateCheckBtn: $('updateCheckBtn'),
  updateActionBtn: $('updateActionBtn'),
};

const ui = {
  mode: 'loading', // loading | idle | recording | transcribing | thinking
  isMac: false,
  setup: null,
  settings: null,
  appInfo: null,
  update: null,
  capture: null,
};

/**
 * 音源状态。
 * 底栏是权威来源：在底栏切换音源或换麦克风会立即生效并落盘，
 * 引导页与设置页只是同一份状态的另外两个视图。
 */
const audioUI = {
  source: 'system',
  deviceId: '',
  deviceLabel: '',
  devices: [],
  devicesReady: false,
};

let stream = null;
let audioCtx = null;
let workletReady = false;
let sourceNode = null;
let workletNode = null;
let muteGain = null;
let userBubble = null;
let aiBubble = null;
let pendingRetry = false; // 下一次作答是重试同一次提问，沿用已有问题气泡，不再插一条相同的

// ---------------------------------------------------------------- 轻提示

function toast(message, kind = 'info', action) {
  const node = document.createElement('div');
  node.className = `toast${kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : ''}`;

  const text = document.createElement('span');
  text.textContent = message;
  node.appendChild(text);

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.onClick();
      node.remove();
    });
    node.appendChild(btn);
  }

  el.toasts.appendChild(node);
  setTimeout(() => node.remove(), action ? 12000 : 5200);
}

function note(node, message, kind = '') {
  if (!node) return;
  node.textContent = message || '';
  node.className = `inline-note${kind ? ` is-${kind}` : ''}`;
}

// ---------------------------------------------------------------- 对话区

function scrollToBottom() {
  el.chat.scrollTop = el.chat.scrollHeight;
}

function hideEmptyTip() {
  if (el.emptyTip && el.emptyTip.parentNode) el.emptyTip.remove();
}

function addRow(who, text, extraClass) {
  hideEmptyTip();
  const row = document.createElement('div');
  row.className = `row is-${who}`;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = who === 'user' ? '我' : 'AI';

  const bubble = document.createElement('div');
  bubble.className = `bubble${extraClass ? ` ${extraClass}` : ''}`;
  bubble.textContent = text || '';

  row.append(avatar, bubble);
  el.chat.appendChild(row);
  scrollToBottom();
  return bubble;
}

/** 重试图标：环形箭头，与界面上其他图标一样用 SVG 画，不依赖字体或图片 */
const RETRY_ICON_PATH =
  'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-8 8s3.57 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z';

function createRetryIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', RETRY_ICON_PATH);
  svg.appendChild(path);
  return svg;
}

/** 报错行。可恢复的失败把下一步操作一并给出，不让用户自己猜该做什么。 */
function addErrorRow(message, retry) {
  const bubble = addRow('ai', message, 'is-error');
  const row = bubble.parentNode;

  if (retry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    // 图标按钮没有文字，用途靠 title 与 aria-label 说明，鼠标悬停也能看到
    btn.className = 'retry-btn';
    btn.title = '重试';
    btn.setAttribute('aria-label', '重试');
    btn.appendChild(createRetryIcon());
    btn.addEventListener('click', () => runRetry(retry, row));
    row.appendChild(btn);
    scrollToBottom();
  }

  return row;
}

/**
 * 重试被报错打断的那一步。
 *
 * 作答重试是同一次提问的再次尝试，不是新一轮提问：沿用对话里已有的问题气泡，
 * 重跑成功后不会留下两条一模一样的问题。录音重试则重新走一遍打开设备与切片。
 * 旧报错行在这里收掉——重试取代了它，再次失败会再产生一条新的。
 */
function runRetry(retry, row) {
  if (ui.mode !== 'idle') {
    toast('正在使用中，请先结束当前操作', 'error');
    return;
  }
  row.remove();

  if (retry.kind === 'answer') {
    pendingRetry = true;
    window.api.submitQuestion(retry.question).then((result) => {
      if (result && result.ok === false) {
        // 主进程没接住这次重试，标记不能留到下一次提问，否则那条提问不会出现在对话里
        pendingRetry = false;
        toast(result.message || '暂时无法重试', 'error');
      }
    });
    return;
  }

  startRecording();
}

// ---------------------------------------------------------------- 控制区状态

/** 空闲时的提示语：按当前音源给出对应的操作说明 */
function idleHint() {
  if (audioUI.source === 'microphone') return '正在使用麦克风，点击开始录音';
  if (ui.isMac) return '电脑声音需要先授予「屏幕录制」权限，点击录音时会自动引导';
  return '正在使用电脑声音，点击开始录音';
}

/** 录音中状态栏与提示语里的音源名称 */
function sourceLabel(source = audioUI.source) {
  return source === 'microphone' ? '麦克风' : '电脑播放的声音';
}

function renderControls() {
  el.recordBtn.classList.remove('is-recording', 'is-stopping');
  el.recordBtn.disabled = false;

  if (ui.mode === 'recording') {
    el.recordBtnText.textContent = '结束这一段';
    el.recordBtn.classList.add('is-recording');
    el.hintText.textContent = '正在实时转写，点击后立即生成回答';
    el.levelWrap.classList.add('is-active');
  } else if (ui.mode === 'thinking') {
    el.recordBtnText.textContent = '停止回答';
    el.recordBtn.classList.add('is-stopping');
    el.hintText.textContent = '点击可中断本次回答，已生成的内容会保留';
    el.levelWrap.classList.remove('is-active');
  } else if (ui.mode === 'transcribing') {
    el.recordBtnText.textContent = '转写中…';
    el.recordBtn.disabled = true;
    el.hintText.textContent = '正在转写最后一段音频';
    el.levelWrap.classList.remove('is-active');
  } else if (ui.mode === 'loading') {
    el.recordBtnText.textContent = '准备中…';
    el.recordBtn.disabled = true;
    el.hintText.textContent = '正在准备';
    el.levelWrap.classList.remove('is-active');
  } else {
    el.recordBtnText.textContent = '开始录音';
    el.hintText.textContent = idleHint();
    el.levelWrap.classList.remove('is-active');
    el.levelBar.style.width = '0%';
  }

  const busy = ui.mode !== 'idle';
  el.questionInput.disabled = busy;
  el.sendBtn.disabled = busy || !el.questionInput.value.trim();
  // 录音过程中不允许换音源，否则会录到一半换了设备
  for (const btn of el.sourceSwitch.querySelectorAll('.seg')) btn.disabled = busy;
  el.micSelect.disabled = busy;
}

function applyStatus(state, message) {
  ui.mode = state === 'loading' ? 'loading' : state;
  el.statusText.textContent = message;
  el.statusText.className = 'status';
  if (state === 'recording') el.statusText.classList.add('is-recording');
  if (state === 'transcribing' || state === 'thinking') el.statusText.classList.add('is-busy');
  renderControls();
}

// ---------------------------------------------------------------- 自动更新

/** 更新方式的说明，让使用者知道为什么有的情况要自己去下载 */
const UPDATE_MODE_NOTE = {
  off: '源码模式不检查更新',
  notify: '这一版无法自行替换，发现新版本时会提示你到发布页下载',
  auto: '发现新版本会自动下载，重启后生效',
};

function renderUpdate(snapshot) {
  if (!snapshot) return;
  ui.update = snapshot;

  const note = UPDATE_MODE_NOTE[snapshot.mode] || '';
  const busy = snapshot.status === 'checking' || snapshot.status === 'downloading';
  const parts = [snapshot.message || note];
  if (snapshot.status === 'idle' && note) parts.push(note);
  el.updateHint.textContent = parts.filter(Boolean).join('　·　');
  el.updateHint.className = `field-hint${
    snapshot.status === 'error' ? ' is-error' : snapshot.status === 'downloaded' ? ' is-ok' : ''
  }`;

  el.updateCheckBtn.disabled = busy || snapshot.mode === 'off';

  const action = (snapshot.actions || [])[0];
  if (action) {
    el.updateActionBtn.hidden = false;
    el.updateActionBtn.textContent = action.label;
    el.updateActionBtn.dataset.action = action.id;
  } else {
    el.updateActionBtn.hidden = true;
    el.updateActionBtn.dataset.action = '';
  }
}

async function checkUpdate() {
  el.updateCheckBtn.disabled = true;
  note(el.updateHint, '正在检查更新…');
  const result = await window.api.checkUpdate();
  if (result && result.ok === false && result.message) {
    note(el.updateHint, result.message, 'error');
  }
  const snapshot = await window.api.getUpdateState();
  renderUpdate(snapshot);
}

// ---------------------------------------------------------------- 自检结果

/**
 * 把一次自检画成一行：名称固定，结论与配色随状态变化。
 * 引导页与设置页共用同一种形态，两处看到的结论始终一致。
 */
function paintProbe(node, state, message) {
  if (!node) return;
  const stateEl = node.querySelector('.probe-state');
  node.classList.toggle('is-busy', state === 'busy');
  node.classList.toggle('is-ok', state === 'ok');
  node.classList.toggle('is-warn', state === 'warn');
  node.classList.toggle('is-error', state === 'error');
  if (stateEl) stateEl.textContent = message;
}

function probeNodes(kind) {
  return kind === 'deepseek' ? [el.setupProbeDeepseek, el.setProbeDeepseek] : [el.setupProbeMimo, el.setProbeMimo];
}

function paintProbeAll(kind, state, message) {
  for (const node of probeNodes(kind)) paintProbe(node, state, message);
}

/** 作答链路自检：只打 DeepSeek 的 /models，不消耗 token */
async function probeDeepSeek() {
  paintProbeAll('deepseek', 'busy', '正在测试…');
  const result = await window.api.testDeepSeek();
  paintProbeAll('deepseek', result.ok ? 'ok' : 'error', result.message);
  return result;
}

/** 转写链路自检：用一段静音音频走一次真实转写，Key、地址、模型、网络一并验到 */
async function probeMimo() {
  paintProbeAll('mimo', 'busy', '正在用测试音频走一次转写…');
  const result = await window.api.testMimo();
  paintProbeAll('mimo', result.ok ? 'ok' : 'error', result.message);
  return result;
}

// ---------------------------------------------------------------- 音源与设备

/**
 * 界面上的三处音源视图：底栏、引导第 3 步、设置面板。
 * 底栏是权威入口，切换后立即生效并落盘，另外两处跟着同步。
 */
const SOURCE_VIEWS = [
  { switchEl: el.sourceSwitch, micEl: el.micSelect, micFieldEl: null, hintEl: null, micHintEl: null },
  {
    switchEl: el.setupSourceSwitch,
    micEl: el.setupMicSelect,
    micFieldEl: el.setupMicField,
    hintEl: el.setupSourceHint,
    micHintEl: el.setupMicHint,
  },
  {
    switchEl: el.setSourceSwitch,
    micEl: el.setMicSelect,
    micFieldEl: el.setMicField,
    hintEl: el.setSourceHint,
    micHintEl: el.setMicHint,
  },
];

const SOURCE_NOTE = {
  system: '采集电脑正在播放的声音，适合面试官外放提问。',
  microphone: '采集麦克风，适合自己出声提问。',
};

/** 枚举可用的麦克风；还没授权时系统给不出设备名，这时只留一个默认项 */
async function loadMicrophones() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  let list = [];
  try {
    list = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const device of list) {
    if (device.kind !== 'audioinput' || seen.has(device.deviceId)) continue;
    seen.add(device.deviceId);
    out.push({ deviceId: device.deviceId, label: device.label || '' });
  }
  return out;
}

/** 下拉里可选的麦克风 */
function micChoices() {
  const named = audioUI.devices.filter((device) => device.label);
  return named.length ? named : [{ deviceId: '', label: '默认麦克风' }];
}

/** 恢复已保存的麦克风：deviceId 优先，设备换过时按名称兜底 */
function resolveSavedMic() {
  const choices = micChoices();
  if (audioUI.deviceId) {
    const byId = choices.find((choice) => choice.deviceId === audioUI.deviceId);
    if (byId) return byId;
  }
  if (audioUI.deviceLabel) {
    const byLabel = choices.find((choice) => choice.label === audioUI.deviceLabel);
    if (byLabel) return byLabel;
  }
  return null;
}

function fillMicSelect(select) {
  if (!select) return;
  const choices = micChoices();
  const saved = resolveSavedMic();
  const selectedId = saved ? saved.deviceId : audioUI.deviceId;
  const signature = `${choices.map((c) => `${c.deviceId}|${c.label}`).join(';')}#${selectedId}`;
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature;

  select.innerHTML = '';
  for (const choice of choices) {
    const option = document.createElement('option');
    option.value = choice.deviceId;
    option.textContent = choice.label;
    select.appendChild(option);
  }
  if (choices.some((choice) => choice.deviceId === selectedId)) select.value = selectedId;
}

function paintSources() {
  const useMic = audioUI.source === 'microphone';
  for (const view of SOURCE_VIEWS) {
    for (const btn of view.switchEl.querySelectorAll('.seg')) {
      btn.classList.toggle('is-active', btn.dataset.source === audioUI.source);
    }
    if (view.micFieldEl) view.micFieldEl.hidden = !useMic;
    if (view.hintEl) view.hintEl.textContent = SOURCE_NOTE[audioUI.source];
    if (view.micHintEl) {
      view.micHintEl.textContent = audioUI.devices.some((device) => device.label)
        ? '换设备后立刻生效。'
        : '麦克风名称需要先授予麦克风权限才会显示，点「测试录音」即可授权。';
    }
    fillMicSelect(view.micEl);
  }
}

/** 重新枚举设备；devicechange 时也要走一遍，插拔耳机不用重启应用 */
async function refreshDevices() {
  audioUI.devices = await loadMicrophones();
  audioUI.devicesReady = true;
  paintSources();
}

/** 音源偏好属于使用习惯，切换即落盘，不需要用户再点保存 */
async function persistAudio(patch) {
  const result = await window.api.saveSettings(patch);
  if (result && result.ok) ui.settings = result.view;
  return result;
}

async function setSource(source) {
  if (source === audioUI.source) return;
  audioUI.source = source;
  paintSources();
  renderControls();
  await persistAudio({ 'audio.source': source });
}

async function setMic(deviceId, label) {
  audioUI.deviceId = deviceId || '';
  audioUI.deviceLabel = label || '';
  paintSources();
  await persistAudio({ 'audio.deviceId': audioUI.deviceId, 'audio.deviceLabel': audioUI.deviceLabel });
}

// ---------------------------------------------------------------- 音频采集

/** 提前创建 AudioContext 与 AudioWorklet，点录音时省掉这段等待 */
async function prewarmAudio() {
  try {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContext({ sampleRate: 16000 });
      workletReady = false;
    }
    if (!workletReady) {
      await audioCtx.audioWorklet.addModule('audio-worklet.js');
      workletReady = true;
    }
    if (audioCtx.state === 'suspended') await audioCtx.resume();
  } catch (err) {
    console.error('音频初始化失败', err);
  }
}

/**
 * 音源权限前置检查。
 * 麦克风由主进程代为申请（macOS 会弹系统授权框），屏幕录制只能由用户手动勾选，
 * 因此这里在未授权时直接给出可操作的入口，避免用户对着没反应的按钮点。
 */
async function ensureSourcePermission(source = audioUI.source) {
  if (source === 'microphone') {
    const result = await window.api.requestMicrophone();
    ui.capture = await window.api.getCaptureStatus();
    if (result.ok) return true;
    const access = (ui.capture && ui.capture.microphone) || {};
    toast(access.message || '麦克风不可用，请检查系统权限', 'error', {
      label: '打开系统设置',
      onClick: () => window.api.openPrivacySettings('microphone'),
    });
    return false;
  }
  if (!ui.isMac) return true;
  const status = await window.api.getCaptureStatus();
  ui.capture = status;
  if (status.screen && status.screen.granted) return true;
  toast((status.screen && status.screen.message) || '需要「屏幕录制」权限才能采集电脑声音', 'error', {
    label: '打开系统设置',
    onClick: () => window.api.openPrivacySettings('screen'),
  });
  return false;
}

/**
 * 音频轨是否真的在推流。
 * Electron 采集系统声音失败时会给出一条已结束（ended）的静音轨，且不报任何错误，
 * 所以拿到轨之后必须显式确认它处于 live 状态，否则录制会一直是静音。
 */
async function audioTrackLive(track) {
  if (!track) return false;
  if (track.readyState === 'live') return true;
  await new Promise((resolve) => setTimeout(resolve, 500));
  return track.readyState === 'live';
}

/** 按当前音源打开音频流：电脑声音走回环，麦克风走 getUserMedia */
async function openSourceStream(source = audioUI.source) {
  if (source !== 'microphone') {
    const media = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    media.getVideoTracks().forEach((track) => track.stop()); // 只要音频
    return media;
  }
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (!audioUI.deviceId) return navigator.mediaDevices.getUserMedia({ audio: base });
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: audioUI.deviceId } } });
  } catch (err) {
    const name = String((err && err.name) || '');
    if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw err;
    // 设备被拔掉或重装后 deviceId 会变，退回默认设备并清掉失效记录，避免一直失败
    console.warn(`选定的麦克风不可用（${name}），改用默认设备`);
    await setMic('', '');
    return navigator.mediaDevices.getUserMedia({ audio: base });
  }
}

/** 采集失败的说明：按音源与错误类型给出各自的下一步 */
function captureErrorMessage(err) {
  const text = String((err && err.message) || err);
  const name = String((err && err.name) || '');
  if (/NotAllowedError|NotReadableError|denied|not allowed/i.test(`${name} ${text}`)) {
    if (audioUI.source === 'microphone') {
      return '系统拒绝了麦克风请求。请到「系统设置 → 隐私与安全性 → 麦克风」中勾选本应用并重新打开。';
    }
    return ui.isMac
      ? '系统拒绝了声音采集请求。请到「系统设置 → 隐私与安全性 → 屏幕录制」中勾选本应用并重新打开。'
      : `无法采集系统声音：${text}`;
  }
  return audioUI.source === 'microphone' ? `无法打开麦克风：${text}` : `无法采集系统声音：${text}`;
}

async function startRecording() {
  if (!(await ensureSourcePermission(audioUI.source))) return;

  const result = await window.api.startRecording();
  if (!result.ok) {
    toast(result.message, 'error', {
      label: '打开设置',
      onClick: () => openSettings(),
    });
    return;
  }

  let media;
  try {
    [media] = await Promise.all([openSourceStream(audioUI.source), prewarmAudio()]);
  } catch (err) {
    await window.api.cancelRecording();
    addErrorRow(captureErrorMessage(err), { kind: 'record' });
    applyStatus('idle', '录音启动失败');
    return;
  }

  if (!media.getAudioTracks().length) {
    media.getTracks().forEach((track) => track.stop());
    await window.api.cancelRecording();
    addErrorRow(
      audioUI.source === 'microphone'
        ? '没有拿到麦克风音频轨，请确认设备已连接并在系统里允许本应用使用麦克风。'
        : ui.isMac
          ? '没有拿到系统音频轨。请确认已在「系统设置 → 隐私与安全性 → 屏幕录制」中勾选本应用，并重新打开应用。'
          : '没有拿到系统音频轨，无法录制电脑播放的声音。',
      { kind: 'record' }
    );
    applyStatus('idle', '未获取到音频');
    return;
  }

  stream = media;

  if (!(await audioTrackLive(stream.getAudioTracks()[0]))) {
    stream.getTracks().forEach((track) => track.stop());
    await window.api.cancelRecording();
    addErrorRow(
      ui.isMac
        ? '音频通道没有真正启动，继续录下去会一直是静音。请重启应用后重试；若仍未恢复，到设置里重新检查录音权限。'
        : '音频通道没有真正启动，继续录下去会一直是静音。请重启应用后重试。',
      { kind: 'record' }
    );
    applyStatus('idle', '音频通道未就绪');
    return;
  }

  sourceNode = audioCtx.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-recorder');
  workletNode.port.onmessage = (event) => {
    if (event.data.pcm) window.api.sendPcm(event.data.pcm);
    else if (typeof event.data.level === 'number') {
      el.levelBar.style.width = `${Math.min(100, event.data.level * 400)}%`;
    }
  };
  sourceNode.connect(workletNode);

  // 接 0 增益节点：保证音频图被持续拉取，同时不产生回声
  muteGain = audioCtx.createGain();
  muteGain.gain.value = 0;
  workletNode.connect(muteGain);
  muteGain.connect(audioCtx.destination);

  userBubble = addRow('user', '');
  userBubble.innerHTML = '<span class="placeholder">正在识别…</span>';
  applyStatus('recording', `正在录制${sourceLabel()}…`);
}

async function stopRecording() {
  applyStatus('transcribing', '正在转写最后一段…');

  if (workletNode) {
    try {
      workletNode.port.postMessage({ flush: true });
    } catch (err) {
      /* ignore */
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  if (sourceNode) sourceNode.disconnect();
  if (workletNode) workletNode.disconnect();
  if (muteGain) muteGain.disconnect();
  if (stream) stream.getTracks().forEach((track) => track.stop());
  if (audioCtx && audioCtx.state === 'running') {
    try {
      await audioCtx.suspend();
    } catch (err) {
      /* ignore */
    }
  }
  sourceNode = null;
  workletNode = null;
  muteGain = null;
  stream = null;

  await window.api.stopRecording();
}

/**
 * 试录一小段，确认当前音源真的能出声音。
 * 结论分三档：打不开设备 / 设备正常但没收到声音 / 收到声音。
 * 「没声音」不被笼统地报成「正常」，用户才能立刻知道该去查什么。
 */
async function probeRecording() {
  if (ui.mode !== 'idle') return { state: 'error', message: '正在使用中，请先结束当前操作' };
  if (!(await ensureSourcePermission(audioUI.source))) {
    return { state: 'error', message: '权限未就绪，按提示授权后重试' };
  }

  let probeStream = null;
  let ctx = null;
  try {
    probeStream = await openSourceStream(audioUI.source);
    const track = probeStream.getAudioTracks()[0];
    if (!track) return { state: 'error', message: '没有拿到音频通道' };
    if (!(await audioTrackLive(track))) {
      return { state: 'error', message: '音频通道没有真正启动，继续录下去会一直是静音' };
    }

    ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(probeStream).connect(analyser);

    const buffer = new Float32Array(analyser.fftSize);
    let peak = 0;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      analyser.getFloatTimeDomainData(buffer);
      for (let i = 0; i < buffer.length; i++) peak = Math.max(peak, Math.abs(buffer[i]));
    }

    if (peak < 0.002) {
      return {
        state: 'warn',
        message:
          audioUI.source === 'microphone'
            ? '麦克风已打开，但这 2 秒没有收到声音，说话后再试一次'
            : '电脑声音通道已打开，但这 2 秒没有收到声音，先让电脑播一段音频再试',
      };
    }
    return { state: 'ok', message: `录音正常，峰值电平 ${(peak * 100).toFixed(1)}%` };
  } catch (err) {
    return { state: 'error', message: captureErrorMessage(err) };
  } finally {
    if (probeStream) probeStream.getTracks().forEach((track) => track.stop());
    if (ctx) {
      try {
        await ctx.close();
      } catch (err) {
        /* ignore */
      }
    }
  }
}

function submitQuestion() {
  const text = el.questionInput.value.trim();
  if (!text || ui.mode !== 'idle') return;
  if (!canOperate()) return;
  el.questionInput.value = '';
  el.sendBtn.disabled = true;
  window.api.submitQuestion(text);
}

/** 未完成初始化时不允许开始操作，引导到设置界面 */
function canOperate() {
  if (ui.setup && !ui.setup.deepseekKeySet) {
    toast('还没有配置 DeepSeek API Key，先补上再提问', 'error', {
      label: '打开设置',
      onClick: () => openSettings(),
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- 简历徽标

function renderResumeBadge(info) {
  if (!info) return;
  const badge = el.resumeBadge;
  badge.className = 'badge';
  badge.onclick = null;

  if (info.state === 'ready') {
    badge.classList.add('is-ready');
    badge.textContent = `简历：${info.name || info.source || '已加载'}${info.cached ? '' : '（新解析）'}`;
    badge.title = `回答会结合这份背景档案（来源：${(info.sources || []).join('、') || 'profile.md'}）`;
  } else if (info.state === 'parsing') {
    badge.classList.add('is-parsing');
    badge.textContent = '正在解析简历…';
    badge.title = '首次解析约需 10~15 秒，期间录音与提问照常可用';
  } else if (info.state === 'error') {
    badge.classList.add('is-error');
    badge.textContent = '简历解析失败';
    badge.title = info.message || '';
  } else if (info.state === 'pending') {
    badge.classList.add('is-parsing');
    badge.textContent = '简历待解析';
    badge.title = info.message || '填写 DeepSeek API Key 后会自动解析';
  } else if (info.state === 'disabled') {
    badge.textContent = '未启用简历';
    badge.title = '在设置的「回答与识别」里可以重新启用';
  } else {
    badge.textContent = '未提供简历';
    badge.title = `把简历（PDF / TXT / MD）添加进来即可自动解析：${info.dir || ''}`;
  }

  if (info.state === 'none' || info.state === 'error') {
    badge.classList.add('is-clickable');
    badge.onclick = () => openSettings('resume');
  }
}

// ---------------------------------------------------------------- 首次启动引导

const setup = {
  step: 1,
  total: 3,

  show() {
    this.step = 1;
    el.setupOverlay.hidden = false;
    this.render();
  },

  hide() {
    el.setupOverlay.hidden = true;
  },

  async render() {
    const state = await window.api.getSetupState();
    ui.setup = state;
    ui.isMac = state.platform === 'darwin';
    ui.capture = state.capture;
    if (state.audio) {
      audioUI.source = state.audio.source || 'system';
      audioUI.deviceId = state.audio.deviceId || '';
      audioUI.deviceLabel = state.audio.deviceLabel || '';
    }

    for (const item of el.setupSteps.querySelectorAll('.step')) {
      const index = Number(item.dataset.step);
      item.classList.toggle('is-active', index === this.step);
      item.classList.toggle('is-done', index < this.step);
    }
    for (const pane of el.setupOverlay.querySelectorAll('.pane')) {
      pane.classList.toggle('is-active', Number(pane.dataset.pane) === this.step);
    }

    el.setupDeepseekBase.value = state.deepseekBaseUrl || '';
    el.setupMimoBase.value = state.mimoBaseUrl || '';

    if (state.deepseekKeySet) el.setupDeepseekKey.placeholder = '已配置，留空表示保持不变';
    if (state.mimoKeySet) el.setupMimoKey.placeholder = '已配置，留空表示保持不变';

    this.renderResumeList(state.resume);
    this.renderCapture(state);
    paintSources();

    el.setupPrevBtn.disabled = this.step === 1;
    el.setupNextBtn.textContent = this.step === this.total ? '开始使用' : '下一步';
  },

  renderResumeList(resume) {
    el.setupResumeList.innerHTML = '';
    const sources = (resume && resume.sources) || [];
    el.setupResumeHint.textContent = sources.length
      ? `已添加 ${sources.length} 份材料，文件保存在本机应用数据目录，原始文件保持不动。`
      : '文件会被复制到本机应用数据目录，只有你自己能访问；原始文件保持不动。';

    if (!sources.length) {
      const empty = document.createElement('div');
      empty.className = 'resume-empty';
      empty.textContent = '还没有添加简历材料（可以先跳过，稍后在设置里补充）';
      el.setupResumeList.appendChild(empty);
      return;
    }
    for (const item of sources) {
      el.setupResumeList.appendChild(resumeItemNode(item, null));
    }
  },

  /** 第 3 步：录音环境检查，权限、设备、实际能不能收到声音都在这里体现 */
  renderCapture(state) {
    const capture = state.capture || {};
    const screen = capture.screen || {};
    const microphone = capture.microphone || {};

    const checks = [
      { ok: state.deepseekKeySet, text: 'DeepSeek API Key 已填写（生成作答参考必需）' },
      { ok: state.mimoKeySet, text: 'MiMo ASR API Key 已填写（语音转文字必需）' },
      { ok: !!screen.granted, text: '电脑声音采集已就绪（用电脑声音提问时需要）' },
      { ok: !!microphone.granted, text: '麦克风权限已授予（用麦克风提问时需要）' },
      {
        ok: !!(state.resume && state.resume.sources.length),
        text: '已添加简历材料（可选，添加后回答更贴合你的经历）',
      },
    ];

    const blocked = [screen, microphone].find((item) => item && item.usable === false);
    el.setupPrivacyLead.textContent = blocked
      ? '还有权限没有授予，按下面的提示处理后再录音。'
      : '录音环境已就绪，点「测试录音」确认能收到声音即可开始使用。';
    el.setupPrivacyCallout.hidden = !blocked;
    if (blocked) {
      const name = blocked.kind === 'screen' ? '屏幕录制' : '麦克风';
      el.setupPrivacyTitle.textContent = `需要授予「${name}」权限`;
      el.setupPrivacyText.textContent = blocked.message;
      el.setupPrivacyBtn.dataset.kind = blocked.kind;
    }

    el.setupCheckList.innerHTML = '';
    for (const check of checks) {
      const li = document.createElement('li');
      li.className = check.ok ? 'is-ok' : 'is-todo';
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = check.ok ? '✓' : '!';
      const text = document.createElement('span');
      text.textContent = check.text;
      li.append(mark, text);
      el.setupCheckList.appendChild(li);
    }
  },

  /** 收集当前步骤的输入；返回 null 表示校验未通过 */
  collect() {
    const patch = {};
    const deepseekKey = el.setupDeepseekKey.value.trim();
    const mimoKey = el.setupMimoKey.value.trim();
    if (deepseekKey) patch['deepseekApiKey'] = deepseekKey;
    if (mimoKey) patch['stt.mimo.apiKey'] = mimoKey;
    if (el.setupDeepseekBase.value.trim()) patch['deepseekBaseUrl'] = el.setupDeepseekBase.value.trim();
    if (el.setupMimoBase.value.trim()) patch['stt.mimo.baseUrl'] = el.setupMimoBase.value.trim();
    return patch;
  },

  async next() {
    if (this.step === 1) {
      const patch = this.collect();
      const state = await window.api.getSetupState();
      const hasDeepseek = !!patch['deepseekApiKey'] || state.deepseekKeySet;
      if (!hasDeepseek) {
        paintProbeAll('deepseek', 'error', '请先填写 DeepSeek API Key');
        return;
      }
      // 这一步没有新内容要存时直接放行：空白补丁不是错误，不该把用户挡在这一步
      if (Object.keys(patch).length) {
        const saved = await window.api.saveSetup(patch);
        if (!saved.ok) {
          paintProbeAll('deepseek', 'error', saved.message);
          return;
        }
      }
      el.setupDeepseekKey.value = '';
      el.setupMimoKey.value = '';
      this.step = 2;
    } else if (this.step === 2) {
      this.step = 3;
    } else {
      await window.api.finishSetup();
      this.hide();
      toast('初始化完成，可以开始使用了', 'ok');
      refreshAll();
      return;
    }
    this.render();
  },

  prev() {
    if (this.step > 1) {
      this.step -= 1;
      this.render();
    }
  },
};

// ---------------------------------------------------------------- 设置抽屉

function resumeItemNode(item, onRemove) {
  const node = document.createElement('div');
  node.className = 'resume-item';

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = item.name;
  name.title = item.name;

  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = formatSize(item.size);

  node.append(name, size);

  if (onRemove) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-danger';
    btn.textContent = '移除';
    btn.addEventListener('click', () => onRemove(item.name));
    node.appendChild(btn);
  }
  return node;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const settings = {
  activeTab: 'api',

  async open(tab) {
    const view = await window.api.getSettings();
    ui.settings = view;
    ui.isMac = view.platform === 'darwin';
    this.fill(view);
    if (tab) this.switchTab(tab);
    el.drawerMask.hidden = false;
    el.settingsDrawer.hidden = false;
    note(el.settingsNote, '');
  },

  close() {
    el.drawerMask.hidden = true;
    el.settingsDrawer.hidden = true;
  },

  switchTab(tab) {
    this.activeTab = tab;
    for (const btn of el.settingsTabs.querySelectorAll('.tab')) {
      btn.classList.toggle('is-active', btn.dataset.tab === tab);
    }
    for (const pane of el.settingsDrawer.querySelectorAll('.tabpane')) {
      pane.classList.toggle('is-active', pane.dataset.tabpane === tab);
    }
  },

  fill(view) {
    el.setDeepseekKey.value = '';
    el.setMimoKey.value = '';
    el.setDeepseekKey.placeholder = view.deepseekKeySet
      ? `已配置 ${view.deepseekKeyTail}，留空表示保持不变`
      : 'sk-…';
    el.setMimoKey.placeholder = view.mimoKeySet
      ? `已配置 ${view.mimoKeyTail}，留空表示保持不变`
      : '填写后即可把语音转成文字';
    note(el.setDeepseekKeyState, view.deepseekKeySet ? '当前已配置' : '尚未配置，无法生成回答', view.deepseekKeySet ? 'ok' : 'error');
    note(el.setMimoKeyState, view.mimoKeySet ? '当前已配置' : '尚未配置，录音不可用', view.mimoKeySet ? 'ok' : 'error');

    el.setDeepseekBase.value = view.deepseekBaseUrl || '';
    el.setDeepseekModel.value = view.deepseekModel || '';
    el.setMimoBase.value = view.mimoBaseUrl || '';
    el.setMimoModel.value = view.mimoModel || '';

    el.setMaxChars.value = view.maxChars;
    el.setHistory.value = view.historyTurns;
    el.setReasoning.value = view.reasoningEffort || 'none';
    el.setContextMode.value = view.contextMode;
    el.setResumeEnabled.checked = !!view.resumeEnabled;

    // 音源是全局状态：设置面板只反映它，改动由底栏与这里的开关共同驱动
    if (view.audioSource) audioUI.source = view.audioSource;
    if (view.audioDeviceId !== undefined) audioUI.deviceId = view.audioDeviceId || '';
    if (view.audioDeviceLabel !== undefined) audioUI.deviceLabel = view.audioDeviceLabel || '';
    ui.capture = view.capture || ui.capture;

    el.setTargetSeconds.value = view.targetSeconds;
    el.setMaxSeconds.value = view.maxSeconds;
    el.setSilence.value = view.silenceThresholdRms;

    this.renderResumeList(view.resume, true);
    this.renderAbout(view);
    paintSources();
  },

  renderResumeList(resume, removable) {
    el.setResumeList.innerHTML = '';
    const sources = (resume && resume.sources) || [];
    if (!sources.length) {
      const empty = document.createElement('div');
      empty.className = 'resume-empty';
      empty.textContent = '还没有简历材料。点上面的「添加简历文件」选择 PDF / TXT / MD。';
      el.setResumeList.appendChild(empty);
      return;
    }
    for (const item of sources) {
      const onRemove = removable
        ? async (name) => {
            const result = await window.api.removeResume(name);
            if (!result.ok) {
              toast(result.message || '移除失败', 'error');
              return;
            }
            this.renderResumeList(result.resume, true);
            toast('已移除，正在重新整理背景档案', 'ok');
          }
        : null;
      el.setResumeList.appendChild(resumeItemNode(item, onRemove));
    }
  },

  renderAbout(view) {
    const info = ui.appInfo || {};
    const rows = [
      ['版本', info.version || '-'],
      ['平台', `${info.platform || '-'} / ${info.arch || '-'}`],
      ['运行方式', info.packaged ? '打包版' : '源码模式'],
      ['语音识别', 'MiMo ASR（云端）'],
      ['声音来源', sourceLabel(audioUI.source)],
      ['配置文件', view.configPath],
      ['简历目录', view.resumeDir],
    ];
    el.aboutList.innerHTML = '';
    for (const [key, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      if (key === '配置文件' || key === '简历目录') dd.className = 'mono';
      el.aboutList.append(dt, dd);
    }
  },

  collect() {
    const patch = {
      'answer.maxChars': el.setMaxChars.value,
      'answer.historyTurns': el.setHistory.value,
      'answer.reasoningEffort': el.setReasoning.value,
      'resume.contextMode': el.setContextMode.value,
      'resume.enabled': el.setResumeEnabled.checked,
      'chunk.targetSeconds': el.setTargetSeconds.value,
      'chunk.maxSeconds': el.setMaxSeconds.value,
      'chunk.silenceThresholdRms': el.setSilence.value,
      'deepseekBaseUrl': el.setDeepseekBase.value.trim(),
      'deepseekModel': el.setDeepseekModel.value.trim(),
      'stt.mimo.baseUrl': el.setMimoBase.value.trim(),
      'stt.mimo.model': el.setMimoModel.value.trim(),
    };
    const deepseekKey = el.setDeepseekKey.value.trim();
    const mimoKey = el.setMimoKey.value.trim();
    if (deepseekKey) patch['deepseekApiKey'] = deepseekKey;
    if (mimoKey) patch['stt.mimo.apiKey'] = mimoKey;
    return patch;
  },

  async save() {
    el.settingsSaveBtn.disabled = true;
    const result = await window.api.saveSettings(this.collect());
    el.settingsSaveBtn.disabled = false;
    if (!result.ok) {
      note(el.settingsNote, result.message, 'error');
      return;
    }
    ui.settings = result.view;
    this.fill(result.view);
    note(el.settingsNote, '已保存', 'ok');
    toast('设置已保存', 'ok');
    refreshAll();
  },
};

// ---------------------------------------------------------------- 入口与事件

function openSettings(tab) {
  settings.open(tab);
}

el.settingsBtn.addEventListener('click', () => openSettings());
el.settingsCloseBtn.addEventListener('click', () => settings.close());
el.drawerMask.addEventListener('click', () => settings.close());

// 三处音源视图用同一套交互：切音源、换麦克风都是立即生效并落盘
for (const view of SOURCE_VIEWS) {
  view.switchEl.addEventListener('click', (event) => {
    const btn = event.target.closest('.seg');
    if (btn && !btn.disabled) setSource(btn.dataset.source);
  });
  view.micEl.addEventListener('change', () => {
    const option = view.micEl.selectedOptions[0];
    setMic(view.micEl.value, option ? option.textContent : '');
  });
}

el.settingsTabs.addEventListener('click', (event) => {
  const btn = event.target.closest('.tab');
  if (btn) settings.switchTab(btn.dataset.tab);
});

el.settingsSaveBtn.addEventListener('click', () => settings.save());

/**
 * 先在输入框里改了 Key 的话，测之前先存下来，避免「测的是新 Key、存的是旧 Key」。
 * 两款服务各有一条独立入口，只想验一条时不必连带另一条。
 */
async function saveTypedKeys() {
  const patch = {};
  const deepseekKey = el.setDeepseekKey.value.trim();
  const mimoKey = el.setMimoKey.value.trim();
  if (deepseekKey) patch['deepseekApiKey'] = deepseekKey;
  if (mimoKey) patch['stt.mimo.apiKey'] = mimoKey;
  if (!Object.keys(patch).length) return null;
  const saved = await window.api.saveSettings(patch);
  if (!saved.ok) return saved;
  el.setDeepseekKey.value = '';
  el.setMimoKey.value = '';
  settings.fill(saved.view);
  return saved;
}

el.setTestDeepseekBtn.addEventListener('click', async () => {
  paintProbeAll('deepseek', 'busy', '正在测试…');
  const saved = await saveTypedKeys();
  if (saved && !saved.ok) {
    paintProbeAll('deepseek', 'error', saved.message);
    return;
  }
  await probeDeepSeek();
});

el.setTestMimoBtn.addEventListener('click', async () => {
  paintProbeAll('mimo', 'busy', '正在保存并测试…');
  const saved = await saveTypedKeys();
  if (saved && !saved.ok) {
    paintProbeAll('mimo', 'error', saved.message);
    return;
  }
  await probeMimo();
});

el.setProbeRecordBtn.addEventListener('click', async () => {
  note(el.setProbeRecordResult, '正在试录 2 秒…');
  const result = await probeRecording();
  note(el.setProbeRecordResult, result.message, result.state === 'ok' ? 'ok' : result.state === 'warn' ? 'warn' : 'error');
});

el.updateCheckBtn.addEventListener('click', checkUpdate);

el.updateActionBtn.addEventListener('click', async () => {
  const action = el.updateActionBtn.dataset.action;
  if (action === 'install') {
    // 录制中主进程会拒绝并回一条说明，这里不用先判断
    const result = await window.api.installUpdate();
    if (result && result.ok === false) {
      const snapshot = await window.api.getUpdateState();
      renderUpdate(snapshot);
    }
    return;
  }
  if (action === 'open') {
    window.api.openUpdatePage();
  }
});

el.setPickResumeBtn.addEventListener('click', async () => {
  const result = await window.api.pickResumeFiles();
  if (!result.ok) return;
  settings.renderResumeList(result.resume, true);
  toast(`已添加：${result.added.join('、')}`, 'ok');
});

el.setReloadResumeBtn.addEventListener('click', async () => {
  note(el.settingsNote, '正在重新解析…');
  const status = await window.api.reloadResume();
  note(el.settingsNote, '', '');
  renderResumeBadge(status);
  const view = await window.api.getSettings();
  settings.renderResumeList(view.resume, true);
  toast('已重新解析简历', 'ok');
});

el.setOpenDirBtn.addEventListener('click', () => window.api.revealResumeDir());
el.aboutConfigBtn.addEventListener('click', () => window.api.revealConfig());
el.aboutResumeBtn.addEventListener('click', () => window.api.revealResumeDir());

el.setupNextBtn.addEventListener('click', () => setup.next());
el.setupPrevBtn.addEventListener('click', () => setup.prev());
el.setupSkipBtn.addEventListener('click', async () => {
  await window.api.finishSetup();
  setup.hide();
  toast('已跳过初始化，可在右上角「设置」里随时补齐', 'info');
  refreshAll();
});
el.setupPickBtn.addEventListener('click', async () => {
  const result = await window.api.pickResumeFiles();
  if (!result.ok) return;
  setup.renderResumeList(result.resume);
  setup.renderCapture(await window.api.getSetupState());
  toast(`已添加：${result.added.join('、')}`, 'ok');
});
el.setupSkipResumeBtn.addEventListener('click', () => {
  setup.step = 3;
  setup.render();
});
el.setupAdvancedBtn.addEventListener('click', () => {
  el.setupAdvanced.hidden = !el.setupAdvanced.hidden;
});
el.setupPrivacyBtn.addEventListener('click', () => window.api.openPrivacySettings(el.setupPrivacyBtn.dataset.kind));
el.setupProbeBtn.addEventListener('click', async () => {
  note(el.setupProbeResult, '正在试录 2 秒…');
  const result = await probeRecording();
  note(el.setupProbeResult, result.message, result.state === 'ok' ? 'ok' : result.state === 'warn' ? 'warn' : 'error');
  // 试录会顺带申请权限，回来把清单刷新一遍，用户能立刻看到权限已就绪
  setup.renderCapture(await window.api.getSetupState());
  await refreshDevices();
});
el.setupTestBtn.addEventListener('click', async () => {
  const patch = setup.collect();
  const typed = !!patch['deepseekApiKey'] || !!patch['stt.mimo.apiKey'];
  if (typed) {
    const saved = await window.api.saveSetup(patch);
    if (!saved.ok) {
      paintProbeAll('deepseek', 'error', saved.message);
      return;
    }
    el.setupDeepseekKey.value = '';
    el.setupMimoKey.value = '';
  }
  // 两条链路一起验：只测作答、不测转写时，录音出问题要等到面试现场才发现
  await Promise.all([probeDeepSeek(), probeMimo()]);
});

el.recordBtn.addEventListener('click', () => {
  if (ui.mode === 'recording') stopRecording();
  else if (ui.mode === 'thinking') window.api.abortAnswer();
  else if (ui.mode === 'idle') {
    if (!canOperate()) return;
    startRecording();
  }
});

el.questionInput.addEventListener('input', () => {
  el.sendBtn.disabled = ui.mode !== 'idle' || !el.questionInput.value.trim();
});

el.questionInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitQuestion();
  }
});

el.sendBtn.addEventListener('click', submitQuestion);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!el.settingsDrawer.hidden) settings.close();
  }
});

// 主进程事件
window.api.on('status', ({ state, message }) => applyStatus(state, message));

window.api.on('transcript:partial', ({ text }) => {
  if (!userBubble) userBubble = addRow('user', '');
  userBubble.textContent = text;
  scrollToBottom();
});

window.api.on('transcript:final', ({ text }) => {
  if (userBubble) userBubble.textContent = text || '（未识别到内容）';
});

window.api.on('answer:start', ({ question }) => {
  // 重试沿用对话里已有的问题气泡，同一次提问不在对话里出现两遍
  if (pendingRetry) pendingRetry = false;
  else if (!userBubble && question) userBubble = addRow('user', question);
  aiBubble = addRow('ai', '', 'is-typing');
});

window.api.on('answer:delta', ({ text }) => {
  if (!aiBubble) aiBubble = addRow('ai', '');
  aiBubble.classList.remove('is-typing');
  aiBubble.textContent += text;
  scrollToBottom();
});

window.api.on('answer:done', ({ aborted, failed }) => {
  if (aiBubble) {
    aiBubble.classList.remove('is-typing');
    if (aborted && !aiBubble.textContent) aiBubble.textContent = '（已停止）';
    // 一个字都没出来就失败时，留下空气泡只会让人以为还在生成；重试会重新填这一轮
    else if (failed && !aiBubble.textContent.trim()) aiBubble.parentNode.remove();
  }
  aiBubble = null;
  userBubble = null;
});

window.api.on('error', ({ message, retry }) => addErrorRow(message, retry));

window.api.on('resume:status', renderResumeBadge);

window.api.on('update', (snapshot) => {
  renderUpdate(snapshot);
  // 只有可自动安装的那一版才提示重启；提示模式静静留在「关于」页即可
  if (snapshot.status === 'downloaded') {
    toast(`新版本 ${snapshot.latestVersion} 已下载，重启后生效`, 'ok', {
      label: '重启并安装',
      onClick: () => window.api.installUpdate(),
    });
  }
});

// ---------------------------------------------------------------- 启动

async function refreshAll() {
  const [info, state] = await Promise.all([window.api.getAppInfo(), window.api.getSetupState()]);
  ui.appInfo = info;
  ui.setup = state;
  ui.isMac = state.platform === 'darwin';
  ui.capture = state.capture;
  renderControls();
  paintSources();
}

/** 把主进程给出的音源偏好装进界面状态 */
function adoptAudioState(state) {
  if (!state || !state.audio) return;
  audioUI.source = state.audio.source || 'system';
  audioUI.deviceId = state.audio.deviceId || '';
  audioUI.deviceLabel = state.audio.deviceLabel || '';
}

async function boot() {
  const [info, state, resumeStatus, status, updateState] = await Promise.all([
    window.api.getAppInfo(),
    window.api.getSetupState(),
    window.api.getResumeStatus(),
    window.api.getStatus(),
    window.api.getUpdateState(),
  ]);

  ui.appInfo = info;
  ui.setup = state;
  ui.isMac = state.platform === 'darwin';
  ui.capture = state.capture;
  adoptAudioState(state);

  applyStatus(status.state, status.message);
  renderResumeBadge(resumeStatus);
  renderUpdate(updateState);
  paintSources();

  if (state.needsSetup) {
    setup.show();
  } else {
    const blocked = [state.capture && state.capture.screen, state.capture && state.capture.microphone].find(
      (item) => item && item.usable === false
    );
    if (blocked) {
      toast(blocked.message, 'error', {
        label: '打开系统设置',
        onClick: () => window.api.openPrivacySettings(blocked.kind),
      });
    }
  }

  prewarmAudio();
  // 先枚举一次设备，这样切到麦克风时下拉里已经有内容
  refreshDevices();
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  }
}

boot();
