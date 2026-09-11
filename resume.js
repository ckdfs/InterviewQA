/**
 * 简历/背景资料加载：
 *   resume/ 目录下放简历文件（pdf / txt / md）→ 首次启动时提取文本并让 DeepSeek 整理成结构化档案 →
 *   缓存为 resume/profile.md，之后启动直接复用；源文件有变动（大小或修改时间）才重新解析。
 */
const fs = require('fs');
const path = require('path');

const SOURCE_EXTS = ['.pdf', '.txt', '.md', '.markdown'];

const PARSE_SYSTEM_PROMPT = `把用户提供的候选人原始材料（可能同时包含简历、成绩单等多份文件）合并整理成一份背景档案。
直接输出 Markdown，不要分析、不要解释、不要寒暄、不要输出思考过程。
按下面模板填空，原文没有的信息写"原文未体现"，**绝对不要编造**任何经历、数字、公司、奖项或证书：

## 基本信息
- 姓名/性别/出生年月：
- 当前学历/学校/专业/预计毕业：
- 本科学校/专业：
- 联系方式：

## 教育背景
（学校、专业、起止时间、保研/绩点/排名等）

## 实习经历
（公司 / 岗位 / 时间 / 具体做了什么 / 可量化成果，逐条列出）

## 项目经历
（项目名 / 时间 / 本人角色 / 用到的技术与方法 / 亮点与成果，逐条列出）

## 科研成果
（论文、专利、竞赛作品等，注明本人的作者位次或获奖等级）

## 荣誉奖项

## 专业技能
（编程语言、工具链、平台经验、语言能力）

## 可提炼亮点
（面试时能直接用的卖点，必须来自原文事实）

总长度 900 字以内，信息密度高、条目尽量短。`;

/**
 * 找出目录里所有简历源文件（按修改时间从新到旧）。
 * exclude 用于排除解析产物本身（profile.md），否则会被当成源文件反复自我解析。
 * 支持同时放多份材料（例如「简历 + 成绩单」），会一起交给模型整理。
 */
function findSources(dir, exclude = []) {
  if (!fs.existsSync(dir)) return [];
  const excluded = exclude.map((p) => path.resolve(p));
  const files = fs
    .readdirSync(dir)
    .filter((name) => !name.startsWith('.') && SOURCE_EXTS.includes(path.extname(name).toLowerCase()))
    .map((name) => path.join(dir, name))
    .filter((file) => !excluded.includes(path.resolve(file)));
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files;
}

/** 保留旧名，兼容单文件用法 */
function findSource(dir, exclude = []) {
  const list = findSources(dir, exclude);
  return list.length ? list[0] : null;
}

/** 提取文本：pdf 用 pdf-parse，txt/md 直接读 */
async function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') {
    let PDFParse;
    try {
      ({ PDFParse } = require('pdf-parse'));
    } catch (err) {
      throw new Error('缺少 pdf-parse 依赖，请执行 npm install');
    }
    const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(file)) });
    try {
      const result = await parser.getText();
      return result && result.text ? result.text : '';
    } finally {
      if (parser.destroy) await parser.destroy().catch(() => {});
    }
  }
  return fs.readFileSync(file, 'utf8');
}

function cleanText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function metaPathOf(profilePath) {
  return path.join(path.dirname(profilePath), '.resume-meta.json');
}

/** 计算一组源文件的指纹（名称 + 大小 + 修改时间） */
function fingerprint(sources) {
  return sources.map((file) => {
    const stat = fs.statSync(file);
    return { name: path.basename(file), size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
  });
}

/** 缓存是否仍然对应当前这批源文件 */
function cacheMatchesSource(profilePath, sources) {
  try {
    const metaPath = metaPathOf(profilePath);
    if (!fs.existsSync(profilePath) || !fs.existsSync(metaPath)) return false;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!Array.isArray(meta.sources)) return false;
    return JSON.stringify(meta.sources) === JSON.stringify(fingerprint(sources));
  } catch (err) {
    return false;
  }
}

/**
 * 载入简历档案。
 * @returns {Promise<{profile:string, source:string|null, cached:boolean}|null>}
 */
async function loadResume({ appRoot, config, ask, log = console.log }) {
  const cfg = config.resume || {};
  // 允许 dir / profileFile 直接传绝对路径（打包后指向用户目录）
  const resolve = (p, fallback) => (p ? (path.isAbsolute(p) ? p : path.join(appRoot, p)) : fallback);
  const dir = resolve(cfg.dir, path.join(appRoot, 'resume'));
  const profilePath = resolve(cfg.profileFile, path.join(dir, 'profile.md'));

  if (cfg.enabled === false) return null;

  const sources = findSources(dir, [profilePath]);

  // 有源文件且缓存仍然匹配 → 直接复用
  if (sources.length && cacheMatchesSource(profilePath, sources)) {
    const profile = cleanText(fs.readFileSync(profilePath, 'utf8'));
    log(`[简历] 复用已解析档案（源文件：${sources.map((f) => path.basename(f)).join('、')}）`);
    return { profile, source: sources[0], sources, cached: true };
  }

  // 没有源文件但已有档案 → 仍然可用（例如只把解析结果拷给别人）
  if (!sources.length) {
    if (fs.existsSync(profilePath)) {
      const profile = cleanText(fs.readFileSync(profilePath, 'utf8'));
      log('[简历] 未找到源文件，使用已有档案 profile.md');
      return { profile, source: null, sources: [], cached: true };
    }
    log(`[简历] ${dir} 目录下没有简历文件（支持 pdf / txt / md），跳过`);
    return null;
  }

  log(`[简历] 首次解析：${sources.map((f) => path.basename(f)).join('、')}`);

  const parts = [];
  let budget = 20000; // 多份材料的总字符预算
  for (const file of sources) {
    const text = cleanText(await extractText(file));
    if (text.length < 20) {
      log(`[简历] ${path.basename(file)} 未提取到有效文字，已跳过（可能是扫描件）`);
      continue;
    }
    const sliced = text.slice(0, Math.max(1000, budget));
    budget -= sliced.length;
    parts.push(`===== ${path.basename(file)} =====\n${sliced}`);
    if (budget <= 0) break;
  }
  if (!parts.length) {
    throw new Error('简历文件里提取不到文字，可能是扫描件（图片型 PDF），请改用文本版文件');
  }

  const profile = cleanText(
    await ask(PARSE_SYSTEM_PROMPT, `以下是候选人的原始材料，请合并整理成一份背景档案：\n\n${parts.join('\n\n')}`)
  );
  if (!profile) throw new Error('DeepSeek 未返回有效内容');

  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, `${profile}\n`, 'utf8');
  fs.writeFileSync(
    metaPathOf(profilePath),
    JSON.stringify({ sources: fingerprint(sources), parsedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
  log(`[简历] 解析完成，已缓存到 ${profilePath}`);
  return { profile, source: sources[0], sources, cached: false };
}

module.exports = { loadResume, findSource, extractText };
