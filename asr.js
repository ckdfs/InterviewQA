/**
 * 语音识别层：WAV 封装、MiMo 云端转写、连接与转写可用性探测。
 *
 * 只依赖 Node 内置模块，不依赖 Electron，因此可以在普通 Node 进程里直接自测。
 * 配置读取、IPC 装配与界面提示分别由 main.js 与渲染层负责。
 */
const https = require('https');

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;

/** 探测用的音频时长：够走完一次完整请求，又不会让服务端做无谓的推算 */
const PROBE_SECONDS = 0.6;

// ---------------------------------------------------------------- WAV 封装

/** 给单声道 16bit PCM 套上 WAV 头 */
function pcmToWav(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * 生成一段静音音频。
 * 探测连接与转写是否可用时，用它代替真实录音：不依赖任何音频文件，
 * 打包版里也能跑，且不会因为用户没说话而误判成链路故障。
 */
function silentWav(seconds = PROBE_SECONDS, sampleRate = SAMPLE_RATE) {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  return pcmToWav(Buffer.alloc(samples * BYTES_PER_SAMPLE), sampleRate);
}

/** 单声道 16bit PCM 的均方根，取值 0 至 1 */
function rms(pcm) {
  const count = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  if (count <= 0) return 0;
  const view = new Int16Array(pcm.buffer, pcm.byteOffset, count);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const value = view[i] / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / count);
}

// ---------------------------------------------------------------- 响应解析

/** 从 chat/completions 响应里取出转写文本；无法解析时返回 null */
function extractText(body) {
  const json = parseJson(body);
  if (!json) return null;
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  if (!choice) return null;
  const message = choice.message || choice.delta || {};
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part && part.text) || ''))
      .join('')
      .trim();
  }
  return '';
}

/** 有些网关会用 200 返回一条 error 对象，这种也要按失败处理 */
function extractError(body) {
  const json = parseJson(body);
  if (!json || !json.error) return null;
  const error = json.error;
  if (typeof error === 'string') return error;
  return error.message || error.code || JSON.stringify(error).slice(0, 160);
}

function parseJson(body) {
  try {
    const json = JSON.parse(String(body || ''));
    return json && typeof json === 'object' ? json : null;
  } catch (err) {
    return null;
  }
}

function snippet(body) {
  return String(body || '').replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * 把 HTTP 结果翻译成可直接展示给用户的结论。
 * 分类全部集中在这里，新增状态码只需改这一处。
 */
function classifyMimo(statusCode, body, ctx = {}) {
  const target = `${ctx.baseUrl || '当前接口地址'} / ${ctx.model || '当前模型'}`;

  if (statusCode === 200) {
    const upstreamError = extractError(body);
    if (upstreamError) return { ok: false, reason: 'upstream', message: `MiMo 返回错误：${upstreamError}` };
    const text = extractText(body);
    if (text === null) return { ok: false, reason: 'bad-response', message: `MiMo 响应无法解析：${snippet(body)}` };
    return { ok: true, reason: 'ok', message: `MiMo 连接与转写可用（${target}），识别返回 ${text.length} 字` };
  }
  if (statusCode === 401) {
    return { ok: false, reason: 'unauthorized', message: 'MiMo API Key 无效（401），请重新复制一次' };
  }
  if (statusCode === 403) {
    return { ok: false, reason: 'forbidden', message: 'MiMo 拒绝了本次请求（403），请确认账号已开通语音识别' };
  }
  if (statusCode === 404) {
    return { ok: false, reason: 'not-found', message: `MiMo 接口地址或模型名不对（404）：${target}` };
  }
  if (statusCode === 429) {
    return { ok: false, reason: 'rate-limit', message: 'MiMo 提示请求过于频繁或额度不足（429）' };
  }
  if (statusCode >= 500) {
    return { ok: false, reason: 'server', message: `MiMo 服务端出错（HTTP ${statusCode}），稍后重试` };
  }
  return { ok: false, reason: 'http', message: `MiMo 返回 HTTP ${statusCode}：${snippet(body)}` };
}

// ---------------------------------------------------------------- 网络调用

/** 真实发送：POST 一段 JSON，回传状态码与响应体 */
function sendJson(target, agent) {
  return new Promise((resolve, reject) => {
    const url = new URL(target.url);
    const body = target.body;
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        agent,
        headers: { ...target.headers, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.setTimeout(target.timeoutMs || 30000, () => req.destroy(new Error('请求超时')));
    req.write(body);
    req.end();
  });
}

function buildTranscribeBody(cfg, wavBuffer) {
  return JSON.stringify({
    model: cfg.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wavBuffer.toString('base64')}` } },
        ],
      },
    ],
    asr_options: { language: cfg.language || 'zh' },
  });
}

/**
 * 调一次 MiMo 转写。
 * @returns {Promise<string>} 识别文本（静音音频会得到空串）
 */
async function transcribe(cfg, wavBuffer, deps = {}) {
  const baseUrl = String((cfg && cfg.baseUrl) || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('还没有填写 MiMo 接口地址');
  const body = buildTranscribeBody(cfg, wavBuffer);
  const send = deps.send || ((target) => sendJson(target, deps.agent));
  const res = await send({
    url: `${baseUrl}/chat/completions`,
    headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' },
    body,
    timeoutMs: cfg.timeoutMs || 30000,
  });

  if (res.statusCode >= 400) {
    const verdict = classifyMimo(res.statusCode, res.body, cfg);
    const err = new Error(verdict.message);
    err.verdict = verdict;
    throw err;
  }
  const upstreamError = extractError(res.body);
  if (upstreamError) {
    const err = new Error(`MiMo 返回错误：${upstreamError}`);
    err.verdict = { ok: false, reason: 'upstream', message: err.message };
    throw err;
  }
  const text = extractText(res.body);
  if (text === null) throw new Error(`MiMo 响应无法解析：${snippet(res.body)}`);
  return text;
}

/**
 * 探测 MiMo 的连接与转写可用性。
 * 用一段静音音频走完整条链路，因此 Key、接口地址、模型名、网络四项都会被验到。
 * @returns {Promise<{ok:boolean, reason:string, message:string}>}
 */
async function probeMimo(cfg, deps = {}) {
  const apiKey = String((cfg && cfg.apiKey) || '').trim();
  if (!apiKey) return { ok: false, reason: 'no-key', message: '还没有填写 MiMo API Key' };
  if (!String((cfg && cfg.model) || '').trim()) {
    return { ok: false, reason: 'no-model', message: '还没有填写 MiMo 模型名' };
  }
  try {
    const text = await transcribe(cfg, silentWav(PROBE_SECONDS), deps);
    const target = `${String(cfg.baseUrl || '').replace(/\/+$/, '')} / ${cfg.model}`;
    return { ok: true, reason: 'ok', message: `MiMo 连接与转写可用（${target}），识别返回 ${text.length} 字` };
  } catch (err) {
    if (err.verdict) return err.verdict;
    return { ok: false, reason: 'network', message: `无法连接 MiMo：${err.message}` };
  }
}

module.exports = {
  SAMPLE_RATE,
  BYTES_PER_SAMPLE,
  WAV_HEADER_BYTES,
  PROBE_SECONDS,
  pcmToWav,
  silentWav,
  rms,
  extractText,
  extractError,
  classifyMimo,
  transcribe,
  probeMimo,
};
