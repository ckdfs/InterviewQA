/**
 * 配置层：默认值、读写、首次启动判定。
 *
 * 可写目录的选取：
 *   - 开发模式（未打包）：项目目录，config.json 与 resume/ 就在项目里，便于调试；
 *   - 打包模式：app.asar 只读，改用系统用户目录
 *     Windows: %APPDATA%\InterviewQA
 *     macOS:   ~/Library/Application Support/InterviewQA
 *
 * 首次启动时用户目录里没有 config.json，此时用内置默认值启动，由引导界面把 Key
 * 与简历路径补齐后再写入。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CONFIG = {
  deepseekApiKey: '',
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekModel: 'deepseek-flash',
  stt: {
    engine: 'mimo',
    fallbackToLocal: false,
    maxConcurrent: 4,
    mimo: {
      apiKey: '',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5-asr',
      language: 'zh',
      timeoutMs: 30000,
    },
  },
  whisper: {
    model: 'small',
    computeType: 'int8',
    device: 'cpu',
    workers: 3,
    threads: 6,
    language: 'zh',
    beamSize: 1,
    initialPrompt: '以下是一段普通话的面试问题或对话，请准确转写为简体中文。',
  },
  chunk: {
    targetSeconds: 8,
    maxSeconds: 14,
    overlapSeconds: 1.5,
    silenceThresholdRms: 0.006,
    silenceSeconds: 0.35,
    tailMinPartSeconds: 4,
    tailMaxParts: 1,
  },
  resume: {
    enabled: true,
    contextMode: 'smart',
    defaultInject: 'none',
    reasoningEffort: 'low',
  },
  answer: {
    maxChars: 200,
    historyTurns: 3,
    temperature: 0.7,
    // 作答是实时场景：思考链会把首字延迟从 0.6 秒推到 4 秒以上，默认关闭
    reasoningEffort: 'none',
  },
  ui: {
    // 引导流程是否走完（用户点过「开始使用」即置位，含选择跳过）
    setupDone: false,
  },
};

/** 设置界面允许修改的字段路径 → 校验规则 */
const EDITABLE = {
  'deepseekApiKey': { type: 'string' },
  'deepseekBaseUrl': { type: 'url' },
  'deepseekModel': { type: 'string' },
  'stt.mimo.apiKey': { type: 'string' },
  'stt.mimo.baseUrl': { type: 'url' },
  'stt.mimo.model': { type: 'string' },
  'stt.mimo.language': { type: 'string' },
  'stt.engine': { type: 'enum', values: ['mimo', 'local'] },
  'stt.fallbackToLocal': { type: 'boolean' },
  'resume.enabled': { type: 'boolean' },
  'resume.contextMode': { type: 'enum', values: ['smart', 'all', 'none'] },
  'answer.maxChars': { type: 'int', min: 80, max: 800 },
  'answer.historyTurns': { type: 'int', min: 0, max: 10 },
  'answer.reasoningEffort': { type: 'enum', values: ['none', 'minimal', 'low', 'medium', 'high'] },
  'chunk.targetSeconds': { type: 'number', min: 3, max: 20 },
  'chunk.maxSeconds': { type: 'number', min: 5, max: 40 },
  'chunk.silenceThresholdRms': { type: 'number', min: 0.0005, max: 0.2 },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 深合并：以 defaults 为骨架，把 persisted 里存在的字段按类型覆盖上去 */
function mergeDefaults(defaults, persisted) {
  const out = clone(defaults);
  if (!persisted || typeof persisted !== 'object') return out;
  for (const key of Object.keys(out)) {
    const def = out[key];
    const val = persisted[key];
    if (val === undefined || val === null) continue;
    if (def && typeof def === 'object' && !Array.isArray(def)) {
      out[key] = mergeDefaults(def, val);
    } else if (typeof def === typeof val) {
      out[key] = val;
    } else if (def === '' && typeof val !== 'object') {
      out[key] = String(val);
    }
  }
  return out;
}

function readByPath(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function writeByPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cursor[parts[i]] !== 'object' || cursor[parts[i]] === null) cursor[parts[i]] = {};
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = value;
}

/** 按规则校验并归一化单个字段；不合法时抛错，错误信息可直接展示给用户 */
function coerce(dotted, rule, raw) {
  switch (rule.type) {
    case 'boolean':
      return raw === true || raw === 'true' || raw === 1 || raw === '1';
    case 'int':
    case 'number': {
      const num = Number(raw);
      if (!Number.isFinite(num)) throw new Error(`${dotted} 需要是数字`);
      if (rule.min !== undefined && num < rule.min) throw new Error(`${dotted} 不能小于 ${rule.min}`);
      if (rule.max !== undefined && num > rule.max) throw new Error(`${dotted} 不能大于 ${rule.max}`);
      return rule.type === 'int' ? Math.round(num) : num;
    }
    case 'enum':
      if (!rule.values.includes(raw)) throw new Error(`${dotted} 只能是 ${rule.values.join(' / ')}`);
      return raw;
    case 'url': {
      const text = String(raw || '').trim().replace(/\/+$/, '');
      if (!text) return '';
      try {
        const url = new URL(text);
        if (!/^https?:$/.test(url.protocol)) throw new Error('protocol');
      } catch (err) {
        throw new Error(`${dotted} 需要是 http(s) 开头的地址`);
      }
      return text;
    }
    default:
      return String(raw == null ? '' : raw).trim();
  }
}

class ConfigStore {
  constructor({ appRoot, userDir, isPackaged }) {
    this.appRoot = appRoot;
    this.userDir = userDir;
    this.isPackaged = isPackaged;
    this.dir = path.join(userDir, 'resume');
    this.file = path.join(userDir, 'config.json');
    this.profileFile = path.join(this.dir, 'profile.md');
    this.data = null;
    this.load();
  }

  /** 从磁盘读取配置；缺失时用默认值（不落盘，等引导/设置里保存时再写） */
  load() {
    let persisted = null;
    if (fs.existsSync(this.file)) {
      try {
        persisted = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (err) {
        console.error(`[配置] ${this.file} 解析失败，改用默认值：${err.message}`);
      }
    }
    const data = mergeDefaults(DEFAULT_CONFIG, persisted);

    // 环境变量覆盖（CI / 免改文件启动）
    if (process.env.DEEPSEEK_API_KEY) data.deepseekApiKey = process.env.DEEPSEEK_API_KEY;
    if (process.env.MIMO_API_KEY) data.stt.mimo.apiKey = process.env.MIMO_API_KEY;

    // 简历目录固定指向可写目录，避免打包后指向只读的 app.asar
    data.resume.dir = this.dir;
    data.resume.profileFile = this.profileFile;

    // 打包版不带 Python 运行时，本地引擎不可用：回落到云端引擎
    if (this.isPackaged && data.stt.engine === 'local') {
      console.log('[配置] 打包版不支持本地 Whisper 引擎，已改用云端 ASR');
      data.stt.engine = 'mimo';
    }

    this.data = data;
    return data;
  }

  get() {
    return this.data;
  }

  /** 原子写回磁盘：先写临时文件再改名，避免写到一半断电留下半截 JSON */
  persist() {
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /**
   * 按白名单写入若干字段。
   * @param {object} patch 形如 { 'stt.mimo.apiKey': 'xxx', 'answer.maxChars': 260 }
   * @returns {{ok:boolean, message?:string, config:object}}
   */
  update(patch) {
    if (!patch || typeof patch !== 'object') return { ok: false, message: '没有需要保存的内容', config: this.data };
    const next = clone(this.data);
    try {
      for (const [dotted, raw] of Object.entries(patch)) {
        const rule = EDITABLE[dotted];
        if (!rule) throw new Error(`未知配置项 ${dotted}`);
        writeByPath(next, dotted, coerce(dotted, rule, raw));
      }
    } catch (err) {
      return { ok: false, message: err.message, config: this.data };
    }
    this.data = next;
    this.persist();
    return { ok: true, config: this.data };
  }

  /** 标记引导流程已走完（用户点了「开始使用」或选择先跳过） */
  markSetupDone() {
    this.data.ui = this.data.ui || {};
    this.data.ui.setupDone = true;
    this.persist();
    return this.data;
  }

  /** 引导流程是否走完：用户点了「开始使用」，且两把 Key 都填了 */
  needsSetup() {
    if (this.data.ui && this.data.ui.setupDone) return false;
    return !this.hasDeepSeekKey() || !this.hasMimoKey();
  }

  hasDeepSeekKey() {
    const key = (this.data.deepseekApiKey || '').trim();
    return key.length > 8;
  }

  hasMimoKey() {
    const key = ((this.data.stt.mimo && this.data.stt.mimo.apiKey) || '').trim();
    return key.length > 8;
  }

  /** 设置界面回填用：只暴露 Key 的存在性与尾部片段，不回传完整密钥 */
  safeView() {
    return {
      deepseekBaseUrl: this.data.deepseekBaseUrl,
      deepseekModel: this.data.deepseekModel,
      deepseekKeySet: this.hasDeepSeekKey(),
      deepseekKeyTail: tail(this.data.deepseekApiKey),
      mimoKeySet: this.hasMimoKey(),
      mimoKeyTail: tail(this.data.stt.mimo.apiKey),
      mimoBaseUrl: this.data.stt.mimo.baseUrl,
      mimoModel: this.data.stt.mimo.model,
      mimoLanguage: this.data.stt.mimo.language,
      sttEngine: this.data.stt.engine,
      fallbackToLocal: this.data.stt.fallbackToLocal,
      resumeEnabled: this.data.resume.enabled,
      contextMode: this.data.resume.contextMode,
      maxChars: this.data.answer.maxChars,
      historyTurns: this.data.answer.historyTurns,
      reasoningEffort: this.data.answer.reasoningEffort,
      targetSeconds: this.data.chunk.targetSeconds,
      maxSeconds: this.data.chunk.maxSeconds,
      silenceThresholdRms: this.data.chunk.silenceThresholdRms,
      configPath: this.file,
      resumeDir: this.dir,
      isPackaged: this.isPackaged,
      platform: process.platform,
    };
  }
}

function tail(key) {
  const text = String(key || '');
  if (text.length < 8) return '';
  return `••••${text.slice(-4)}`;
}

module.exports = { ConfigStore, DEFAULT_CONFIG, EDITABLE, mergeDefaults };
