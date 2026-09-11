const { app, BrowserWindow, ipcMain, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { URL } = require('url');
const { spawn } = require('child_process');
const { loadResume } = require('./resume');
const { buildResumeContext } = require('./resume-context');

const APP_ROOT = __dirname;
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const TMP_DIR = path.join(os.tmpdir(), 'interviewqa');

/**
 * 开发与打包两种模式下的「可写目录」：
 * - 开发：直接用项目目录（config.json、resume/ 都在项目里）
 * - 打包：app.asar 是只读的，配置与简历放到系统用户目录（Windows: %APPDATA%\InterviewQA；macOS: ~/Library/Application Support/InterviewQA）
 */
const USER_DIR = app.isPackaged ? app.getPath('userData') : APP_ROOT;
const CONFIG_PATH = path.join(USER_DIR, 'config.json');
const RESUME_DIR = path.join(USER_DIR, 'resume');

/** 读取配置：优先用户目录的 config.json，缺失则从随包的 config.example.json 生成 */
function loadConfig() {
  let raw = null;
  if (fs.existsSync(CONFIG_PATH)) {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } else if (fs.existsSync(path.join(APP_ROOT, 'config.example.json'))) {
    raw = fs.readFileSync(path.join(APP_ROOT, 'config.example.json'), 'utf8');
    try {
      fs.mkdirSync(USER_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, raw, 'utf8');
      console.log(`[配置] 已生成 ${CONFIG_PATH}，请填入 API Key`);
    } catch (err) {
      console.log(`[配置] 无法写入配置文件：${err.message}`);
    }
  } else {
    raw = '{}';
  }

  const config = JSON.parse(raw);
  // 环境变量优先（CI / 自动化部署时无需改文件）
  if (process.env.DEEPSEEK_API_KEY) config.deepseekApiKey = process.env.DEEPSEEK_API_KEY;
  if (process.env.MIMO_API_KEY) {
    config.stt = config.stt || {};
    config.stt.mimo = config.stt.mimo || {};
    config.stt.mimo.apiKey = process.env.MIMO_API_KEY;
  }
  // 简历目录与档案缓存固定放在可写目录（打包后是用户目录）
  config.resume = config.resume || {};
  config.resume.dir = RESUME_DIR;
  config.resume.profileFile = path.join(RESUME_DIR, 'profile.md');
  return config;
}

const CONFIG = loadConfig();

// 本应用只有普通界面，关掉硬件加速：部分机器上 GPU 进程反复崩溃会导致应用直接退出
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');

const BASE_SYSTEM_PROMPT = `你是资深面试官兼求职教练。用户会给你一段面试问题（文本来自语音识别，可能有错别字，请先自行理解并纠正）。
请针对问题给出一段能直接说出口的面试作答参考，要求：
1) 中文，200 字左右（180~230 字，含标点）；
2) 如果问题适合分点（例如"介绍一下你的项目""你的优势是什么""为什么胜任这个岗位"），就用「1. 2. 3.」分点作答，每点 1~2 句；不适合分点的就用一段连贯口语；
3) 先给结论，再展开要点，最后一句收束；口语化，不要复述问题，不要"参考答案"之类的开场白；
4) 如果下面提供了候选人背景资料，请优先结合资料中的真实经历、课程与项目来作答，不要编造资料里没有的内容。`;

/**
 * 拼装系统提示词：按问题类型只注入相关的简历片段。
 * 八股/理论题不注入；项目题注入项目经历；实习题注入实习经历；自我介绍类注入完整档案。
 */
function buildSystemPrompt(question) {
  if (!state.resumeText) return BASE_SYSTEM_PROMPT;

  const context = buildResumeContext(state.resumeText, question, {
    contextMode: (CONFIG.resume && CONFIG.resume.contextMode) || 'smart',
    defaultInject: (CONFIG.resume && CONFIG.resume.defaultInject) || 'none',
  });

  if (!context.text) {
    console.log(`[简历注入] 不注入（${context.reason}）`);
    return `${BASE_SYSTEM_PROMPT}\n\n（本题是通用技术题，请用你的专业知识直接作答，不要生硬联系候选人的经历。）`;
  }

  const label = context.mode === 'all' ? '完整档案' : context.keys.join('+');
  console.log(`[简历注入] ${label}，${context.text.length} 字（${context.reason}）`);
  return `${BASE_SYSTEM_PROMPT}\n\n【候选人背景资料（真实信息，请结合使用，不要编造）】\n${context.text}`;
}

// 连接复用：避免每次请求都重新做 TCP + TLS 握手
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 30000 });

let win = null;

function send(channel, payload) {
  try {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  } catch (err) {
    console.error(`[发送失败 ${channel}] ${err.message}`);
  }
}

process.on('unhandledRejection', (err) => {
  console.error(`[未处理的 Promise 异常] ${err && err.stack ? err.stack : err}`);
});
process.on('uncaughtException', (err) => {
  console.error(`[未捕获异常] ${err && err.stack ? err.stack : err}`);
});

let currentStatus = { state: 'loading', message: '正在加载语音模型…' };

function setStatus(state, message) {
  currentStatus = { state, message };
  send('status', { state, message });
}

let currentResumeStatus = { state: 'loading' };

function setResumeStatus(payload) {
  currentResumeStatus = payload;
  send('resume:status', payload);
}

// ---------------------------------------------------------------- 音频工具

function wavHeader(dataLength) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function rmsOfInt16(buf) {
  const count = Math.floor(buf.length / BYTES_PER_SAMPLE);
  if (count <= 0) return 0;
  const view = new Int16Array(buf.buffer, buf.byteOffset, count);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const v = view[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / count);
}

const PUNCT_RE = /[，。、？！；：""''（）《》\s,.?!;:'"()\-—…·]/;

/** 去掉标点/空白，并记录每个字符在原串中的位置，便于回填 */
function normalizeWithMap(text) {
  let norm = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    if (!PUNCT_RE.test(text[i])) {
      norm += text[i];
      map.push(i);
    }
  }
  return { norm, map };
}

/**
 * 拼接两段相邻片段的转写结果：找 a 的尾部与 b 的头部重叠部分并去重。
 * 忽略标点差异，且允许重叠出现在 b 的前若干个字里（识别可能吞掉开头一两个字）。
 */
function mergeWithOverlapDedupe(a, b) {
  if (!a) return b;
  if (!b) return a;

  const { norm: na } = normalizeWithMap(a);
  const { norm: nb, map: mapB } = normalizeWithMap(b);
  const headLen = Math.min(nb.length, 60);
  const maxK = Math.min(na.length, 45);

  for (let k = maxK; k >= 4; k--) {
    const tail = na.slice(-k);
    const pos = nb.slice(0, headLen).indexOf(tail);
    if (pos >= 0) {
      const cutIndex = mapB[pos + k] !== undefined ? mapB[pos + k] : b.length;
      return b.slice(cutIndex) ? a + b.slice(cutIndex) : a;
    }
  }
  return a + b;
}

// ---------------------------------------------------------------- 转写 worker 池

class SttWorker {
  constructor(index, pool, cfg) {
    this.index = index;
    this.pool = pool;
    this.ready = false;
    this.task = null;
    this.buffer = '';
    const python = path.join(APP_ROOT, '.venv', 'Scripts', 'python.exe');
    this.proc = spawn(python, [path.join(APP_ROOT, 'stt', 'worker.py')], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        HF_ENDPOINT: 'https://hf-mirror.com',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (data) => this.onData(data));
    this.proc.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.log(`[stt-${index}] ${text.slice(0, 300)}`);
    });
    this.proc.on('exit', (code) => {
      console.log(`[stt-${index}] 进程退出 code=${code}`);
      this.ready = false;
      const task = this.task;
      this.task = null;
      if (task) task.cb('', '转写进程异常退出');
    });

    this.proc.stdin.write(JSON.stringify({ whisper: cfg.whisper }) + '\n');
  }

  onData(data) {
    this.buffer += data.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        continue;
      }
      if (msg.event === 'ready') {
        this.ready = true;
        this.pool.onWorkerReady(this);
      } else if (msg.event === 'error') {
        console.error(`[stt-${this.index}] ${msg.error}`);
        send('error', { message: `语音模型加载失败：${msg.error}` });
      } else if (msg.event === 'log') {
        console.log(`[stt-${this.index}] ${msg.message}`);
      } else if (msg.id !== undefined) {
        const task = this.task;
        this.task = null;
        try {
          if (task && task.wav) fs.unlinkSync(task.wav);
        } catch (err) {
          /* 忽略删除失败 */
        }
        if (task && task.id === msg.id) task.cb(msg.text || '', msg.error);
        this.pool.pump();
      }
    }
  }

  submit(task) {
    this.task = task;
    this.proc.stdin.write(JSON.stringify({ cmd: 'transcribe', id: task.id, wav: task.wav }) + '\n');
  }

  kill() {
    try {
      this.proc.stdin.write(JSON.stringify({ cmd: 'exit' }) + '\n');
    } catch (err) {
      /* ignore */
    }
  }
}

class WorkerPool {
  constructor(cfg) {
    this.queue = [];
    this.workers = [];
    this.readyCount = 0;
    const size = Math.max(1, cfg.whisper.workers || 1);
    for (let i = 0; i < size; i++) this.workers.push(new SttWorker(i, this, cfg));
  }

  get ready() {
    return this.readyCount >= this.workers.length;
  }

  onWorkerReady() {
    this.readyCount++;
    // 惰性启动（云端引擎失败后回退）时不要干扰当前状态提示
    if (((CONFIG.stt && CONFIG.stt.engine) || 'local') !== 'local') {
      if (this.ready) console.log('[stt] 本地 worker 已就绪（备用）');
      return;
    }
    if (this.ready) {
      console.log('[stt] 全部 worker 就绪');
      setStatus('idle', '语音模型就绪，点击录音开始');
    } else {
      setStatus('loading', `正在加载语音模型（${this.readyCount}/${this.workers.length}）…`);
    }
  }

  submit(task) {
    this.queue.push(task);
    this.pump();
  }

  pump() {
    while (this.queue.length) {
      const worker = this.workers.find((w) => w.ready && !w.task);
      if (!worker) return;
      worker.submit(this.queue.shift());
    }
  }

  killAll() {
    this.workers.forEach((w) => w.kill());
  }
}

let pool = null;

function ensureLocalPool() {
  if (!pool) pool = new WorkerPool(CONFIG);
  return pool;
}

/** 本地 Whisper 转写（按需惰性启动 worker） */
function localTranscribe(wavPath) {
  return new Promise((resolve, reject) => {
    ensureLocalPool().submit({
      id: `${Date.now()}-${Math.random()}`,
      wav: wavPath,
      cb: (text, error) => (error ? reject(new Error(error)) : resolve(text)),
    });
  });
}

/** MiMo-V2.5-ASR 云端转写：音频转 base64 后走 chat/completions */
function mimoTranscribe(wavPath) {
  const cfg = (CONFIG.stt && CONFIG.stt.mimo) || {};
  return new Promise((resolve, reject) => {
    let audio;
    try {
      audio = fs.readFileSync(wavPath).toString('base64');
    } catch (err) {
      return reject(err);
    }
    const body = JSON.stringify({
      model: cfg.model,
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${audio}` } }],
        },
      ],
      asr_options: { language: cfg.language || 'zh' },
    });
    const url = new URL(`${cfg.baseUrl}/chat/completions`);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        agent: keepAliveAgent,
        headers: {
          'api-key': cfg.apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`MiMo ${res.statusCode} ${data.slice(0, 160)}`));
          try {
            const json = JSON.parse(data);
            const choice = json.choices && json.choices[0];
            const text = (choice && ((choice.message && choice.message.content) || (choice.delta && choice.delta.content))) || '';
            resolve(String(text).trim());
          } catch (err) {
            reject(new Error('MiMo 返回解析失败'));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(cfg.timeoutMs || 30000, () => req.destroy(new Error('MiMo 请求超时')));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------- 转写调度（云端优先 + 并发 + 本地兜底）

const asrQueue = { active: 0, tasks: [] };

function submitAsr(wavPath, cb) {
  asrQueue.tasks.push({ wavPath, cb });
  pumpAsr();
}

function pumpAsr() {
  const maxConcurrent = (CONFIG.stt && CONFIG.stt.maxConcurrent) || 4;
  while (asrQueue.tasks.length && asrQueue.active < maxConcurrent) {
    const task = asrQueue.tasks.shift();
    asrQueue.active++;
    runAsrTask(task).finally(() => {
      asrQueue.active--;
      pumpAsr();
    });
  }
}

async function runAsrTask(task) {
  const engine = (CONFIG.stt && CONFIG.stt.engine) || 'local';
  const fallback = CONFIG.stt ? CONFIG.stt.fallbackToLocal !== false : true;
  try {
    if (engine === 'mimo') {
      try {
        task.cb(await mimoTranscribe(task.wavPath), null);
        return;
      } catch (err) {
        console.error(`[MiMo 失败] ${err.message}`);
        if (!fallback) {
          task.cb('', err.message);
          return;
        }
        console.log('[转写] 回退到本地 Whisper');
      }
    }
    task.cb(await localTranscribe(task.wavPath), null);
  } catch (err) {
    task.cb('', err.message || String(err));
  } finally {
    try {
      fs.unlinkSync(task.wavPath);
    } catch (err) {
      /* 忽略删除失败 */
    }
  }
}

// ---------------------------------------------------------------- 会话状态

const state = {
  recording: false,
  sessionId: 0,
  pending: Buffer.alloc(0), // 尚未切片的 PCM（Int16 单声道 16k）
  chunkSeq: 0, // 已派发的片段数量
  nextEmitId: 0, // 下一个待按顺序输出的片段 id
  results: new Map(),
  textParts: [],
  silenceTail: 0,
  stopRequested: false,
  finalized: false,
  history: [],
  answering: false, // 是否正在生成回答
  answerAborted: false, // 用户是否点了「停止」
  resumeText: '', // 候选人背景档案（首次启动解析后缓存复用）
};

function resetSession() {
  state.sessionId++;
  state.pending = Buffer.alloc(0);
  state.chunkSeq = 0;
  state.nextEmitId = 0;
  state.results.clear();
  state.textParts = [];
  state.silenceTail = 0;
  state.stopRequested = false;
  state.finalized = false;
}

function maybeCut() {
  const cfg = CONFIG.chunk;
  const totalSeconds = state.pending.length / BYTES_PER_SAMPLE / SAMPLE_RATE;
  if (totalSeconds < 1) return;

  let cutSeconds = -1;
  if (totalSeconds >= cfg.maxSeconds) {
    cutSeconds = totalSeconds; // 硬上限，避免长段堆积
  } else if (totalSeconds >= cfg.targetSeconds && state.silenceTail >= cfg.silenceSeconds) {
    cutSeconds = totalSeconds - state.silenceTail; // 在停顿处切，切掉尾部静音
  }
  if (cutSeconds <= 0.5) return;

  const cutSamples = Math.floor(cutSeconds * SAMPLE_RATE);
  const slice = Buffer.from(state.pending.subarray(0, cutSamples * BYTES_PER_SAMPLE));
  const keepFrom = Math.max(0, cutSamples - Math.floor(cfg.overlapSeconds * SAMPLE_RATE));
  state.pending = Buffer.from(state.pending.subarray(keepFrom * BYTES_PER_SAMPLE));
  state.silenceTail = 0;
  dispatchChunk(slice);
}

function dispatchChunk(slice) {
  const id = state.chunkSeq++;
  const threshold = CONFIG.chunk.silenceThresholdRms;
  if (rmsOfInt16(slice) < threshold * 0.5) {
    // 纯静音段：直接跳过转写，省时间也避免幻觉
    onChunkDone(id, '', null);
    return;
  }
  const file = path.join(TMP_DIR, `chunk_${state.sessionId}_${id}.wav`);
  fs.writeFileSync(file, Buffer.concat([wavHeader(slice.length), slice]));
  console.log(`[切片 #${id}] ${(slice.length / BYTES_PER_SAMPLE / SAMPLE_RATE).toFixed(1)}s`);
  submitAsr(file, (text, error) => onChunkDone(id, text, error));
}

/**
 * 停止录音时把剩余音频切成多段并行转写（利用空闲并发额度），
 * 让"最后一段"的等待时间缩短到原来的 1/2 ~ 1/3。
 */
function flushTailParallel() {
  const cfg = CONFIG.chunk;
  const totalSamples = Math.floor(state.pending.length / BYTES_PER_SAMPLE);
  const totalSeconds = totalSamples / SAMPLE_RATE;

  const pcm = state.pending;
  state.pending = Buffer.alloc(0);
  if (totalSeconds < 0.3) return;

  const minPart = cfg.tailMinPartSeconds || 2.5;
  const maxParts = cfg.tailMaxParts || 3;
  const parts = Math.min(maxParts, Math.max(1, Math.floor(totalSeconds / minPart)));
  if (parts <= 1) {
    dispatchChunk(Buffer.from(pcm));
    return;
  }

  const base = Math.floor(totalSamples / parts);
  const overlapSamples = Math.floor((cfg.overlapSeconds || 1.2) * SAMPLE_RATE);
  for (let i = 0; i < parts; i++) {
    const start = i === 0 ? 0 : Math.max(0, i * base - overlapSamples);
    const end = i === parts - 1 ? totalSamples : (i + 1) * base;
    dispatchChunk(Buffer.from(pcm.subarray(start * BYTES_PER_SAMPLE, end * BYTES_PER_SAMPLE)));
  }
}

function onChunkDone(id, text, error) {
  if (error) console.error(`[转写失败 #${id}] ${error}`);
  state.results.set(id, text);
  // 按序号依次输出，保证文字顺序正确
  while (state.results.has(state.nextEmitId)) {
    const part = state.results.get(state.nextEmitId);
    state.results.delete(state.nextEmitId);
    state.nextEmitId++;
    if (part) state.textParts.push(part);
  }
  const merged = state.textParts.reduce((acc, part) => mergeWithOverlapDedupe(acc, part), '');
  console.log(`[片段完成 #${id}] 累计文本：${merged}`);
  send('transcript:partial', { text: merged, done: state.nextEmitId >= state.chunkSeq });
  maybeFinalize();
}

function maybeFinalize() {
  if (!state.stopRequested || state.finalized) return;
  if (state.nextEmitId < state.chunkSeq) return; // 还有片段没回来
  state.finalized = true;

  const question = state.textParts.reduce((acc, part) => mergeWithOverlapDedupe(acc, part), '').trim();
  send('transcript:final', { text: question });

  if (!question) {
    setStatus('idle', '没有识别到内容，确认电脑在播放声音后重试');
    return;
  }
  console.log(`[最终问题] ${question}`);
  generateAnswer(question);
}

// ---------------------------------------------------------------- DeepSeek 回答

let currentAnswerReq = null; // 当前正在进行的回答请求，用于「停止」按钮中断
let currentAnswerAbort = null; // 中断时用于立即结束流式等待，避免界面卡在“生成中”

/**
 * 用 Node 原生 https 发起流式请求（不走 Chromium 网络栈，避免 Electron 网络服务异常时卡住）。
 * 每收到一段增量文本就回调 onDelta。
 */
function streamChatCompletions(baseUrl, key, model, messages, temperature, onDelta) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/chat/completions`);
    const body = JSON.stringify({ model, messages, stream: true, temperature });
    console.log(`[请求] ${url.hostname}${url.pathname} model=${model}`);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        agent: keepAliveAgent,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        console.log(`[响应] HTTP ${res.statusCode}`);
        if (res.statusCode >= 400) {
          let detail = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (detail += c));
          res.on('end', () => reject(new Error(`DeepSeek ${res.statusCode} ${detail.slice(0, 200)}`)));
          return;
        }
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk;
          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            for (const line of frame.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const data = trimmed.slice(5).trim();
              if (!data || data === '[DONE]') continue;
              let json;
              try {
                json = JSON.parse(data);
              } catch (err) {
                continue;
              }
              const delta = json.choices && json.choices[0] && json.choices[0].delta;
              if (delta && delta.content) onDelta(delta.content);
            }
          }
        });
        res.on('end', () => resolve());
      }
    );
    currentAnswerReq = req;
    currentAnswerAbort = resolve; // 用户点“停止”时直接结束等待
    req.on('error', reject);
    req.on('close', () => {
      if (currentAnswerReq === req) currentAnswerReq = null;
      currentAnswerAbort = null;
    });
    req.on('timeout', () => {
      req.destroy(new Error('请求超时（60 秒未响应）'));
    });
    req.setTimeout(60000);
    req.write(body);
    req.end();
  });
}

/**
 * 非流式调用 DeepSeek（启动时解析简历等一次性任务用）。
 * 注意：deepseek-flash 会先输出思考内容，max_tokens 给小了会出现「正文为空、finish_reason=length」，
 * 所以这里给足预算并降低思考强度。
 */
function askDeepSeekOnce(system, user, maxTokens = 8000) {
  return new Promise((resolve, reject) => {
    const key = CONFIG.deepseekApiKey;
    if (!key || !key.startsWith('sk-')) return reject(new Error('未配置 DeepSeek API Key'));
    const url = new URL(`${CONFIG.deepseekBaseUrl}/chat/completions`);
    const body = JSON.stringify({
      model: CONFIG.deepseekModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
      reasoning_effort: (CONFIG.resume && CONFIG.resume.reasoningEffort) || 'low',
      stream: false,
    });
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        agent: keepAliveAgent,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`DeepSeek ${res.statusCode} ${data.slice(0, 200)}`));
          try {
            const json = JSON.parse(data);
            const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
            resolve(String(content || '').trim());
          } catch (err) {
            reject(new Error('DeepSeek 返回解析失败'));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(90000, () => req.destroy(new Error('简历解析超时')));
    req.write(body);
    req.end();
  });
}

/** 首次启动解析简历（或复用缓存档案） */
async function initResume() {
  try {
    if (!fs.existsSync(RESUME_DIR)) {
      fs.mkdirSync(RESUME_DIR, { recursive: true });
      console.log(`[简历] 已创建简历目录：${RESUME_DIR}`);
    }
    const result = await loadResume({
      appRoot: APP_ROOT,
      config: CONFIG,
      ask: askDeepSeekOnce,
      log: console.log,
    });
    if (!result) {
      setResumeStatus({ state: 'none', dir: RESUME_DIR });
      return;
    }
    state.resumeText = result.profile;
    const match = result.profile.match(/姓名[：:]\s*([^\s，,、\n]+)/);
    setResumeStatus({
      state: 'ready',
      cached: result.cached,
      name: match ? match[1] : null,
      source: result.source ? path.basename(result.source) : 'profile.md',
    });
  } catch (err) {
    console.error(`[简历] 处理失败：${err.message}`);
    setResumeStatus({ state: 'error', message: err.message });
  }
}

async function generateAnswer(question) {
  state.answerAborted = false;
  state.answering = true;
  state.deltaCount = 0;
  setStatus('thinking', 'DeepSeek 正在生成回答…（点击「停止」可中断）');
  send('answer:start', { question });

  const { deepseekApiKey: key, deepseekBaseUrl: baseUrl, deepseekModel: model, answer } = CONFIG;
  if (!key || !key.startsWith('sk-')) {
    send('error', { message: '未配置 DeepSeek API Key，请在 config.json 中填写' });
    setStatus('idle', '缺少 API Key');
    return;
  }

  const messages = [{ role: 'system', content: buildSystemPrompt(question) }];
  const historyTurns = (answer && answer.historyTurns) || 0;
  messages.push(...state.history.slice(-historyTurns * 2));
  messages.push({ role: 'user', content: question });

  let full = '';
  let deltaCount = 0;
  const startedAt = Date.now();
  try {
    await streamChatCompletions(baseUrl, key, model, messages, (answer && answer.temperature) || 0.7, (delta) => {
      full += delta;
      deltaCount++;
      state.deltaCount = deltaCount;
      if (deltaCount === 1) console.log(`[首个增量] ${Date.now() - startedAt}ms`);
      send('answer:delta', { text: delta });
    });
  } catch (err) {
    state.answering = false;
    if (state.answerAborted) {
      console.log(`[回答已中断] 保留 ${full.length} 字`);
      state.history.push({ role: 'user', content: question });
      state.history.push({ role: 'assistant', content: full });
      send('answer:done', { text: full, aborted: true });
      setStatus('idle', '已停止，可继续录音或手动提问');
      return;
    }
    console.error(`[回答失败] ${err.message}`);
    send('error', { message: `调用 DeepSeek 失败：${err.message}` });
    setStatus('idle', '回答失败，可重试');
    send('answer:done', { text: full, failed: true });
    return;
  }

  state.answering = false;
  state.history.push({ role: 'user', content: question });
  state.history.push({ role: 'assistant', content: full });

  if (state.answerAborted) {
    console.log(`[回答已中断] 保留 ${full.length} 字，共收到 ${deltaCount} 个增量`);
    send('answer:done', { text: full, aborted: true });
    setStatus('idle', '已停止，可继续录音或手动提问');
    return;
  }

  console.log(`[回答完成] 共 ${full.length} 字`);
  console.log(`[回答内容] ${full.replace(/\n+/g, ' ')}`);
  send('answer:done', { text: full });
  setStatus('idle', '就绪，点击录音开始下一段');
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('status:get', () => currentStatus);

ipcMain.handle('resume:get', () => currentResumeStatus);

ipcMain.handle('resume:reload', async () => {
  // 手动重新解析（换简历文件后可用）：先让缓存失效，再重新解析
  try {
    const profilePath = path.join(
      APP_ROOT,
      (CONFIG.resume && CONFIG.resume.profileFile) || path.join('resume', 'profile.md')
    );
    const metaPath = path.join(path.dirname(profilePath), '.resume-meta.json');
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  } catch (err) {
    /* ignore */
  }
  state.resumeText = '';
  setResumeStatus({ state: 'parsing' });
  await initResume();
  return currentResumeStatus;
});

/** 当前转写引擎是否可用（云端引擎随开随用，本地引擎要等 worker 加载完模型） */
function sttReady() {
  const engine = (CONFIG.stt && CONFIG.stt.engine) || 'local';
  if (engine === 'mimo') {
    return !!(CONFIG.stt && CONFIG.stt.mimo && CONFIG.stt.mimo.apiKey);
  }
  return !!(pool && pool.ready);
}

ipcMain.handle('question:submit', async (_event, text) => {
  const question = String(text || '').trim();
  if (!question) return { ok: false, message: '请输入内容' };
  if (state.recording) return { ok: false, message: '正在录音中，请先结束这一段' };
  if (state.answering) return { ok: false, message: '正在回答中，请先停止' };
  generateAnswer(question);
  return { ok: true };
});

function abortAnswer() {
  if (!state.answering) return false;
  state.answerAborted = true;
  const finish = currentAnswerAbort;
  if (currentAnswerReq) {
    try {
      currentAnswerReq.destroy();
    } catch (err) {
      /* ignore */
    }
  }
  if (finish) finish(); // 立即结束等待，后续 generateAnswer 会走“已中断”分支
  return true;
}

ipcMain.handle('answer:abort', () => ({ ok: abortAnswer() }));

ipcMain.handle('recording:start', () => {
  if (!sttReady()) {
    return { ok: false, message: '语音识别还在准备中，请稍候几秒' };
  }
  resetSession();
  state.recording = true;
  setStatus('recording', '正在录制电脑播放的声音…');
  return { ok: true };
});

function handlePcm(chunk) {
  state.pending = Buffer.concat([state.pending, chunk]);

  const duration = chunk.length / BYTES_PER_SAMPLE / SAMPLE_RATE;
  if (rmsOfInt16(chunk) < CONFIG.chunk.silenceThresholdRms) state.silenceTail += duration;
  else state.silenceTail = 0;

  maybeCut();
}

ipcMain.on('audio:pcm', (_event, arrayBuffer) => {
  if (!state.recording) return;
  handlePcm(Buffer.from(arrayBuffer));
});

function stopRecording() {
  if (!state.recording) return;
  state.recording = false;
  state.stopRequested = true;

  flushTailParallel();

  if (state.chunkSeq === 0) {
    setStatus('idle', '没有录到声音，检查电脑是否正在播放');
    send('transcript:final', { text: '' });
    return;
  }

  const waiting = state.chunkSeq - state.nextEmitId;
  setStatus('transcribing', waiting > 0 ? `正在转写最后 ${waiting} 段…` : '正在整理问题…');
  maybeFinalize();
}

ipcMain.handle('recording:stop', () => {
  stopRecording();
  return { ok: true };
});

ipcMain.handle('recording:cancel', () => {
  state.recording = false;
  state.stopRequested = false;
  state.pending = Buffer.alloc(0);
  setStatus('idle', '已取消');
  return { ok: true };
});

// ---------------------------------------------------------------- 自检模式
// npm run selftest：用 stt/test_sample.wav 模拟一次录音，跑通「切片 → 并行转写 → 拼接 → 回答 → 界面」

function runSelfTest() {
  const wav = path.join(APP_ROOT, 'stt', 'test_sample.wav');
  if (!fs.existsSync(wav)) {
    console.log(`[自检] 缺少测试音频：${wav}`);
    return;
  }
  const waitReady = setInterval(() => {
    if (!sttReady()) return;
    if (currentResumeStatus.state === 'loading') return; // 等简历解析/加载有结果
    clearInterval(waitReady);
    console.log('[自检] 开始模拟录音');

    const pcm = fs.readFileSync(wav).subarray(44); // 去掉 WAV 头
    const blockBytes = Math.floor(SAMPLE_RATE * 0.5) * BYTES_PER_SAMPLE; // 0.5 秒一块
    let offset = 0;

    resetSession();
    state.recording = true;
    setStatus('recording', '自检：正在模拟录音…');

    const timer = setInterval(() => {
      if (offset >= pcm.length) {
        clearInterval(timer);
        stopRecording();
        return;
      }
      handlePcm(Buffer.from(pcm.subarray(offset, offset + blockBytes)));
      offset += blockBytes;
    }, 500);

    // 追加自检：等第一轮问答结束后，手动输入提问并在生成中途停止
    const waitFirstDone = setInterval(() => {
      if (state.history.length < 2) return; // 第一轮问答还没完成
      clearInterval(waitFirstDone);
      console.log('[自检] 手动输入提问');
      generateAnswer('什么是进程和线程的区别？');
      const watch = setInterval(() => {
        if (state.deltaCount > 2) {
          clearInterval(watch);
          console.log(
            `[自检] 收到 ${state.deltaCount} 个增量后触发停止 => ${abortAnswer() ? '已中断' : '无进行中的回答'}`
          );
        }
      }, 100);
    }, 500);
  }, 500);
}

// ---------------------------------------------------------------- 应用生命周期

function createWindow() {
  win = new BrowserWindow({
    width: 940,
    height: 760,
    minWidth: 640,
    minHeight: 520,
    title: '面试问答助手',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(APP_ROOT, 'renderer', 'index.html'));
}

/** 启动时预热到 DeepSeek 的连接（不消耗 token），后续首次提问可省去握手时间 */
function warmUpConnection() {
  const key = CONFIG.deepseekApiKey;
  if (!key || !key.startsWith('sk-')) return;
  const req = https.request(
    {
      hostname: 'api.deepseek.com',
      path: '/models',
      method: 'GET',
      agent: keepAliveAgent,
      headers: { Authorization: `Bearer ${key}` },
    },
    (res) => {
      console.log(`[预热] DeepSeek 连接就绪 HTTP ${res.statusCode}`);
      if (res.statusCode === 401) send('error', { message: 'DeepSeek API Key 无效，请检查 config.json' });
      res.resume();
    }
  );
  req.on('error', (err) => console.log(`[预热失败] ${err.message}`));
  req.end();
}

app.whenReady().then(() => {
  // 允许直接采集系统声音（Windows WASAPI 回环），不弹屏幕选择框
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        callback({ video: sources[0], audio: 'loopback' });
      } catch (err) {
        callback({ video: 'screen', audio: 'loopback' });
      }
    },
    { useSystemPicker: false }
  );

  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  createWindow();

  const engine = (CONFIG.stt && CONFIG.stt.engine) || 'local';
  if (engine === 'local') {
    setStatus('loading', '正在加载本地语音模型…');
    pool = new WorkerPool(CONFIG);
  } else {
    // 云端引擎随开随用，不必等本地模型加载
    setStatus('idle', '就绪，点击录音开始或直接在下方输入问题');
    console.log(`[stt] 使用云端引擎：${(CONFIG.stt.mimo && CONFIG.stt.mimo.model) || 'mimo'}`);
  }
  warmUpConnection();
  initResume(); // 异步：首次解析简历，之后复用缓存，不阻塞界面
  if (process.argv.includes('--selftest')) runSelfTest();
});

app.on('before-quit', () => {
  if (pool) pool.killAll();
});
