const chatEl = document.getElementById('chat');
const emptyTip = document.getElementById('emptyTip');
const recordBtn = document.getElementById('recordBtn');
const recordBtnText = document.getElementById('recordBtnText');
const statusText = document.getElementById('statusText');
const hintText = document.getElementById('hintText');
const levelWrap = document.getElementById('levelWrap');
const levelBar = document.getElementById('levelBar');
const questionInput = document.getElementById('questionInput');
const sendBtn = document.getElementById('sendBtn');
const resumeBadge = document.getElementById('resumeBadge');

let mode = 'loading'; // loading | idle | recording | transcribing | thinking
let stream = null;
let audioCtx = null;
let workletReady = false;
let sourceNode = null;
let workletNode = null;
let muteGain = null;
let userBubble = null;
let aiBubble = null;

// ---------------------------------------------------------------- 界面工具

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function hideEmptyTip() {
  if (emptyTip && emptyTip.parentNode) emptyTip.remove();
}

function addRow(who, text, className) {
  hideEmptyTip();
  const row = document.createElement('div');
  row.className = `row ${who}`;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = who === 'user' ? '问题' : 'AI';

  const bubble = document.createElement('div');
  bubble.className = `bubble ${className || ''}`.trim();
  bubble.textContent = text || '';

  row.appendChild(avatar);
  row.appendChild(bubble);
  chatEl.appendChild(row);
  scrollToBottom();
  return bubble;
}

function renderControls() {
  recordBtn.classList.remove('recording', 'stopping');
  recordBtn.disabled = false;

  if (mode === 'recording') {
    recordBtnText.textContent = '结束这一段';
    recordBtn.classList.add('recording');
    hintText.textContent = '录音中会实时转写，点击后立即生成回答';
    levelWrap.classList.add('active');
  } else if (mode === 'thinking') {
    recordBtnText.textContent = '停止回答';
    recordBtn.classList.add('stopping');
    hintText.textContent = '点击可中断本次回答，已生成的内容会保留';
    levelWrap.classList.remove('active');
  } else if (mode === 'transcribing') {
    recordBtnText.textContent = '转写中…';
    recordBtn.disabled = true;
    hintText.textContent = '正在转写最后一段音频';
    levelWrap.classList.remove('active');
  } else if (mode === 'loading') {
    recordBtnText.textContent = '模型加载中…';
    recordBtn.disabled = true;
    hintText.textContent = '首次启动需要下载并加载本地语音模型';
    levelWrap.classList.remove('active');
  } else {
    recordBtnText.textContent = '开始录音';
    hintText.textContent = '再次点击结束这一段并生成回答';
    levelWrap.classList.remove('active');
    levelBar.style.width = '0%';
  }

  const inputDisabled = mode !== 'idle';
  questionInput.disabled = inputDisabled;
  sendBtn.disabled = inputDisabled || !questionInput.value.trim();
}

function applyStatus(state, message) {
  mode = state === 'loading' ? 'loading' : state;
  statusText.textContent = message;
  statusText.className = `status ${state === 'recording' ? 'recording' : ''}`;
  renderControls();
}

// ---------------------------------------------------------------- 音频采集（预初始化，点击即录）

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

// 提前创建 AudioContext 并加载 AudioWorklet，点录音时省掉这段等待
prewarmAudio();

async function startRecording() {
  const result = await window.api.startRecording();
  if (!result.ok) {
    applyStatus('idle', result.message);
    return;
  }

  let media;
  try {
    // 取系统音频 与 音频图初始化并行，尽量减少点击后的等待
    [media] = await Promise.all([
      navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
      prewarmAudio(),
    ]);
  } catch (err) {
    await window.api.cancelRecording();
    addRow('ai', `无法采集系统声音：${err.message}`, 'error');
    applyStatus('idle', '录音启动失败');
    return;
  }

  if (!media.getAudioTracks().length) {
    media.getTracks().forEach((t) => t.stop());
    await window.api.cancelRecording();
    addRow('ai', '没有拿到系统音频轨，无法录制电脑播放的声音。', 'error');
    applyStatus('idle', '未获取到系统音频');
    return;
  }

  stream = media;
  stream.getVideoTracks().forEach((t) => t.stop()); // 只要音频

  sourceNode = audioCtx.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-recorder');
  workletNode.port.onmessage = (event) => {
    if (event.data.pcm) window.api.sendPcm(event.data.pcm);
    else if (typeof event.data.level === 'number') {
      levelBar.style.width = `${Math.min(100, event.data.level * 400)}%`;
    }
  };
  sourceNode.connect(workletNode);

  // 接 0 增益节点，保证音频图被持续拉取但不产生回声
  muteGain = audioCtx.createGain();
  muteGain.gain.value = 0;
  workletNode.connect(muteGain);
  muteGain.connect(audioCtx.destination);

  userBubble = addRow('user', '', '');
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
  if (stream) stream.getTracks().forEach((t) => t.stop());
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

async function stopAnswer() {
  applyStatus('idle', '正在停止…');
  await window.api.abortAnswer();
}

function submitQuestion() {
  const text = questionInput.value.trim();
  if (!text || mode !== 'idle') return;
  questionInput.value = '';
  sendBtn.disabled = true;
  window.api.submitQuestion(text);
}

recordBtn.addEventListener('click', () => {
  if (mode === 'recording') stopRecording();
  else if (mode === 'thinking') stopAnswer();
  else if (mode === 'idle') startRecording();
});

questionInput.addEventListener('input', () => {
  sendBtn.disabled = mode !== 'idle' || !questionInput.value.trim();
});

questionInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitQuestion();
  }
});

sendBtn.addEventListener('click', submitQuestion);

// ---------------------------------------------------------------- 主进程事件

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
  aiBubble = addRow('ai', '', 'dot-typing');
});

window.api.on('answer:delta', ({ text }) => {
  if (!aiBubble) aiBubble = addRow('ai', '');
  aiBubble.classList.remove('dot-typing');
  aiBubble.textContent += text;
  scrollToBottom();
});

window.api.on('answer:done', ({ aborted }) => {
  if (aiBubble) {
    aiBubble.classList.remove('dot-typing');
    if (aborted && !aiBubble.textContent) aiBubble.textContent = '（已停止）';
  }
  aiBubble = null;
  userBubble = null;
});

window.api.on('error', ({ message }) => {
  addRow('ai', message, 'error');
});

function applyResumeStatus(info) {
  if (!info) return;
  resumeBadge.className = 'resume-badge';
  if (info.state === 'ready') {
    resumeBadge.classList.add('show', 'ready');
    resumeBadge.textContent = `背景资料：${info.name || info.source || '已加载'}${info.cached ? '' : '（新解析）'}`;
    resumeBadge.title = `回答将结合该背景资料（${info.source || ''}）`;
  } else if (info.state === 'parsing') {
    resumeBadge.classList.add('show', 'parsing');
    resumeBadge.textContent = '正在解析简历…';
  } else if (info.state === 'error') {
    resumeBadge.classList.add('show', 'error');
    resumeBadge.textContent = '简历解析失败';
    resumeBadge.title = info.message || '';
  } else if (info.state === 'none') {
    resumeBadge.classList.add('show');
    resumeBadge.textContent = '未提供简历';
    resumeBadge.title = info.dir
      ? `把简历（pdf / txt / md）放进这个目录即可自动解析：${info.dir}`
      : '把简历（pdf / txt / md）放进项目 resume 目录即可自动解析';
  }
}

window.api.on('resume:status', applyResumeStatus);

// 启动时同步一次状态（本地模型/简历可能在页面加载完成前就绪）
window.api.getStatus().then(({ state: st, message }) => applyStatus(st, message));
window.api.getResumeStatus().then(applyResumeStatus);
renderControls();
