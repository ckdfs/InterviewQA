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
  setupTestResult: $('setupTestResult'),
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
  setTestBtn: $('setTestBtn'),
  setTestResult: $('setTestResult'),
  setMaxChars: $('setMaxChars'),
  setHistory: $('setHistory'),
  setReasoning: $('setReasoning'),
  setContextMode: $('setContextMode'),
  setResumeEnabled: $('setResumeEnabled'),
  setEngine: $('setEngine'),
  setEngineHint: $('setEngineHint'),
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
};

const ui = {
  mode: 'loading', // loading | idle | recording | transcribing | thinking
  isMac: false,
  setup: null,
  settings: null,
  appInfo: null,
};

let stream = null;
let audioCtx = null;
let workletReady = false;
let sourceNode = null;
let workletNode = null;
let muteGain = null;
let userBubble = null;
let aiBubble = null;

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
  node.className = `inline-note${kind === 'ok' ? ' is-ok' : kind === 'error' ? ' is-error' : ''}`;
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

// ---------------------------------------------------------------- 控制区状态

const MAC_HINT = 'macOS 需要先授予「屏幕录制」权限，点击录音时会自动引导';

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
    el.hintText.textContent = '正在加载语音引擎';
    el.levelWrap.classList.remove('is-active');
  } else {
    el.recordBtnText.textContent = '开始录音';
    el.hintText.textContent = ui.isMac ? MAC_HINT : '再次点击结束这一段并生成回答';
    el.levelWrap.classList.remove('is-active');
    el.levelBar.style.width = '0%';
  }

  const busy = ui.mode !== 'idle';
  el.questionInput.disabled = busy;
  el.sendBtn.disabled = busy || !el.questionInput.value.trim();
}

function applyStatus(state, message) {
  ui.mode = state === 'loading' ? 'loading' : state;
  el.statusText.textContent = message;
  el.statusText.className = 'status';
  if (state === 'recording') el.statusText.classList.add('is-recording');
  if (state === 'transcribing' || state === 'thinking') el.statusText.classList.add('is-busy');
  renderControls();
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

/** macOS 上先查屏幕录制权限，未授权时给出可操作的入口，避免用户对着没反应的按钮点 */
async function ensureCapturePermission() {
  if (!ui.isMac) return true;
  try {
    const status = await window.api.getCaptureStatus();
    if (status.granted) return true;
    toast(status.message, 'error', {
      label: '打开系统设置',
      onClick: () => window.api.openPrivacySettings(),
    });
    return false;
  } catch (err) {
    return true;
  }
}

async function startRecording() {
  if (!(await ensureCapturePermission())) return;

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
    [media] = await Promise.all([
      navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
      prewarmAudio(),
    ]);
  } catch (err) {
    await window.api.cancelRecording();
    const message =
      ui.isMac && /denied|not allowed/i.test(err.message)
        ? '系统拒绝了声音采集请求。请到「系统设置 → 隐私与安全性 → 屏幕录制」中勾选本应用并重新打开。'
        : `无法采集系统声音：${err.message}`;
    addRow('ai', message, 'is-error');
    applyStatus('idle', '录音启动失败');
    return;
  }

  if (!media.getAudioTracks().length) {
    media.getTracks().forEach((track) => track.stop());
    await window.api.cancelRecording();
    addRow(
      'ai',
      ui.isMac
        ? '没有拿到系统音频轨。请确认已在「系统设置 → 隐私与安全性 → 屏幕录制」中勾选本应用，并重新打开应用。'
        : '没有拿到系统音频轨，无法录制电脑播放的声音。',
      'is-error'
    );
    applyStatus('idle', '未获取到系统音频');
    return;
  }

  stream = media;
  stream.getVideoTracks().forEach((track) => track.stop()); // 只要音频

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
  applyStatus('recording', '正在录制电脑播放的声音…');
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

    if (state.deepseekKeySet) {
      el.setupDeepseekKey.placeholder = '已配置，留空表示保持不变';
      note(el.setupTestResult, '');
    }
    if (state.mimoKeySet) el.setupMimoKey.placeholder = '已配置，留空表示保持不变';

    this.renderResumeList(state.resume);
    this.renderPrivacy(state);

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

  renderPrivacy(state) {
    const checks = [];
    checks.push({
      ok: state.deepseekKeySet,
      text: 'DeepSeek API Key 已填写（生成作答参考必需）',
    });
    checks.push({
      ok: state.mimoKeySet,
      text: 'MiMo ASR API Key 已填写（录制系统声音必需）',
    });
    checks.push({
      ok: !!(state.resume && state.resume.sources.length),
      text: '已添加简历材料（可选，添加后回答更贴合你的经历）',
    });

    if (ui.isMac) {
      const granted = !state.privacy;
      checks.push({ ok: granted, text: '已授予「屏幕录制」权限（采集系统声音必需）' });
      el.setupPrivacyLead.textContent = granted
        ? '系统声音采集权限已就绪。'
        : 'macOS 采集系统声音需要「屏幕录制」权限，请按下面的提示授予。';
      el.setupPrivacyCallout.hidden = granted;
      if (!granted) {
        el.setupPrivacyTitle.textContent = '需要授予「屏幕录制」权限';
        el.setupPrivacyText.textContent = state.privacy.message;
      }
    } else {
      el.setupPrivacyLead.textContent = 'Windows 通过 WASAPI 回环直接采集系统声音，无需额外授权。';
      el.setupPrivacyCallout.hidden = true;
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
        note(el.setupTestResult, '请先填写 DeepSeek API Key', 'error');
        return;
      }
      const saved = await window.api.saveSetup(patch);
      if (!saved.ok) {
        note(el.setupTestResult, saved.message, 'error');
        return;
      }
      note(el.setupTestResult, '');
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
      : '填写后即可录制电脑声音';
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

    el.setEngine.value = view.sttEngine;
    el.setTargetSeconds.value = view.targetSeconds;
    el.setMaxSeconds.value = view.maxSeconds;
    el.setSilence.value = view.silenceThresholdRms;
    el.setEngineHint.textContent = view.isPackaged
      ? '打包版不带 Python 运行时，本地 Whisper 不可用；需要本地识别请从源码运行。'
      : '本地 Whisper 需先在项目目录创建 .venv 并安装 faster-whisper。';

    this.renderResumeList(view.resume, true);
    this.renderAbout(view);
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
      ['识别引擎', info.engine === 'local' ? '本地 Whisper' : '云端 MiMo ASR'],
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
      'stt.engine': el.setEngine.value,
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

el.settingsTabs.addEventListener('click', (event) => {
  const btn = event.target.closest('.tab');
  if (btn) settings.switchTab(btn.dataset.tab);
});

el.settingsSaveBtn.addEventListener('click', () => settings.save());

el.setTestBtn.addEventListener('click', async () => {
  note(el.setTestResult, '正在测试…');
  const typed = el.setDeepseekKey.value.trim();
  if (typed) {
    const saved = await window.api.saveSettings({ deepseekApiKey: typed });
    if (!saved.ok) {
      note(el.setTestResult, saved.message, 'error');
      return;
    }
    el.setDeepseekKey.value = '';
    settings.fill(saved.view);
  }
  const result = await window.api.testDeepSeek();
  note(el.setTestResult, result.message, result.ok ? 'ok' : 'error');
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
  setup.renderPrivacy(await window.api.getSetupState());
  toast(`已添加：${result.added.join('、')}`, 'ok');
});
el.setupSkipResumeBtn.addEventListener('click', () => {
  setup.step = 3;
  setup.render();
});
el.setupAdvancedBtn.addEventListener('click', () => {
  el.setupAdvanced.hidden = !el.setupAdvanced.hidden;
});
el.setupPrivacyBtn.addEventListener('click', () => window.api.openPrivacySettings());
el.setupTestBtn.addEventListener('click', async () => {
  const patch = setup.collect();
  if (!patch['deepseekApiKey']) {
    const state = await window.api.getSetupState();
    if (!state.deepseekKeySet) {
      note(el.setupTestResult, '请先填写 DeepSeek API Key', 'error');
      return;
    }
    note(el.setupTestResult, '正在测试已保存的 Key…');
  } else {
    note(el.setupTestResult, '正在测试…');
    const saved = await window.api.saveSetup(patch);
    if (!saved.ok) {
      note(el.setupTestResult, saved.message, 'error');
      return;
    }
    el.setupDeepseekKey.value = '';
  }
  const result = await window.api.testDeepSeek();
  note(el.setupTestResult, result.message, result.ok ? 'ok' : 'error');
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
  if (!userBubble && question) userBubble = addRow('user', question);
  aiBubble = addRow('ai', '', 'is-typing');
});

window.api.on('answer:delta', ({ text }) => {
  if (!aiBubble) aiBubble = addRow('ai', '');
  aiBubble.classList.remove('is-typing');
  aiBubble.textContent += text;
  scrollToBottom();
});

window.api.on('answer:done', ({ aborted }) => {
  if (aiBubble) {
    aiBubble.classList.remove('is-typing');
    if (aborted && !aiBubble.textContent) aiBubble.textContent = '（已停止）';
  }
  aiBubble = null;
  userBubble = null;
});

window.api.on('error', ({ message }) => {
  addRow('ai', message, 'is-error');
});

window.api.on('resume:status', renderResumeBadge);

// ---------------------------------------------------------------- 启动

async function refreshAll() {
  const [info, state] = await Promise.all([window.api.getAppInfo(), window.api.getSetupState()]);
  ui.appInfo = info;
  ui.setup = state;
  ui.isMac = state.platform === 'darwin';
  renderControls();
}

async function boot() {
  const [info, state, resumeStatus, status] = await Promise.all([
    window.api.getAppInfo(),
    window.api.getSetupState(),
    window.api.getResumeStatus(),
    window.api.getStatus(),
  ]);

  ui.appInfo = info;
  ui.setup = state;
  ui.isMac = state.platform === 'darwin';

  applyStatus(status.state, status.message);
  renderResumeBadge(resumeStatus);

  if (state.needsSetup) {
    setup.show();
  } else if (ui.isMac && state.privacy) {
    toast('系统声音采集需要「屏幕录制」权限', 'error', {
      label: '打开系统设置',
      onClick: () => window.api.openPrivacySettings(),
    });
  }

  prewarmAudio();
}

boot();
