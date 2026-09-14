/**
 * 按问题类型决定注入哪部分简历背景，避免"八股题硬套简历"：
 *   - 技术理论题（八股）→ 不注入简历，让模型用通用知识回答；
 *   - 项目 / 实习 / 科研 / 学业 / 荣誉 / 技能 类问题 → 只注入对应片段；
 *   - 自我介绍、优势、为什么胜任等 → 注入完整档案。
 * 判定全部在本地用关键词完成，不额外调用模型，不增加等待时间。
 * 觉得某类判得不对，改下面的关键词表即可（可用 npm run test:context 验证）。
 */

// profile.md 里的小标题 → 内部分区键
const SECTION_RULES = [
  { key: 'basic', match: /基本|个人信息|概况|联系方式/ },
  { key: 'education', match: /教育|学业|学习|学校|成绩/ },
  { key: 'internship', match: /实习|工作经历|职场|公司/ },
  { key: 'project', match: /项目|作品|实践/ },
  { key: 'research', match: /科研|论文|专利|成果/ },
  { key: 'honors', match: /荣誉|奖项|获奖|奖学金|竞赛/ },
  { key: 'skills', match: /技能|能力|证书|工具/ },
  { key: 'highlights', match: /亮点|优势|总结|卖点/ },
];

// 各类问题的关键词（命中即认为在问该主题）
const CATEGORY_KEYWORDS = {
  internship: ['实习', '公司', '职场', '入职', '离职', '同事', '带教', '哪段'],
  project: [
    '项目', '系统', '作品', '设计', '实现', '开发', '硬件', 'pcb', '原理图', '驱动', '调试',
    '架构', '技术方案', '难点', '独立完成', '板子', '固件', '上位机',
  ],
  research: ['论文', '科研', '专利', '期刊', 'jcr', '投稿', '创新点', '实验验证', '算法研究'],
  education: ['成绩', '绩点', '课程', '专业', '学校', '大学', '保研', '本科', '硕士', '学历', '基础课'],
  honors: ['竞赛', '获奖', '奖项', '荣誉', '奖学金', '名次'],
  skills: ['技能', '会什么', '熟悉哪些', '熟悉什么', '掌握哪些', '工具链', '英语水平', '证书', '编程语言'],
};

// 自我介绍 / 自我评价 / 动机类（需要完整档案）；用完整短语，避免"介绍一下你做的项目"被误判
const SELF_INTRO_KEYWORDS = [
  '自我介绍', '介绍你自己', '介绍一下你自己', '介绍一下自己', '你自我介绍一下',
  '你的优势', '你的优点', '你的缺点', '你最大的', '你觉得自己', '评价一下你',
  '职业规划', '职业目标', '为什么要选', '为什么想加入', '为什么应聘', '为什么适合', '为什么胜任',
];

// 强"经历类"信号：出现说明要结合候选人的具体经历
const EXPERIENCE_CUES = [
  /你(的)?(项目|实习|经历|课题|论文|竞赛|毕业设计)/,
  /(做过|负责|参与|独立完成|实现过|开发过|写过|搭过|踩过)/,
  /(你在|哪段|哪次|哪一个)/,
  // "那个项目是怎么实现的""这个系统怎么设计"——用了指代词，几乎都是在问自己的经历
  // 指代词与名词之间常夹修饰词（"那个采集板项目"），允许少量非标点字符
  /(这个|那个)[^，。！？；、\s]{0,6}(项目|系统|论文|实习|课题|设计|作品|装置|电路|板子|方案)/,
  /(讲讲|说说|聊聊|介绍)(一下)?(你的|你做的|你参与的|这个|那个)/,
];

// 技术理论题（八股）特征词
const THEORY_CUES = [
  '什么是', '是什么', '解释一下', '解释下', '原理', '区别', '有什么不同', '如何实现', '怎么实现',
  '怎么理解', '谈谈你对', '简述', '概念', '定义', '作用', '优缺点', '为什么会出现', '底层',
  '说一下', '讲一下', '介绍一下',
];

/** 把 profile.md 按小标题切成若干区块 */
function splitSections(profile) {
  const sections = {};
  let current = null;
  let buffer = [];
  const flush = () => {
    if (current && buffer.length) {
      const text = buffer.join('\n').trim();
      if (text) sections[current] = (sections[current] ? `${sections[current]}\n` : '') + text;
    }
    buffer = [];
  };
  for (const line of String(profile || '').split('\n')) {
    const heading = /^#{1,4}\s*(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const rule = SECTION_RULES.find((r) => r.match.test(heading[1]));
      current = rule ? rule.key : null;
      buffer = rule ? [`## ${heading[1]}`] : [];
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return sections;
}

/**
 * 从档案里抽取"课程名 / 技能关键词"，并记下它出自哪个区块。
 * 只从含"课程/熟悉/掌握/技能/工具/语言"的行里取，避免把通用动词当关键词造成误判。
 */
function extractTerms(profile) {
  const terms = [];
  let section = null;
  const STRIP_LEADING = /^(核心课程|高分课程|课程|熟悉|掌握|具备|能熟练|通过|获取|获得)[：:]*/;
  for (const line of String(profile || '').split('\n')) {
    const heading = /^#{1,4}\s*(.+?)\s*$/.exec(line);
    if (heading) {
      const rule = SECTION_RULES.find((r) => r.match.test(heading[1]));
      section = rule ? rule.key : null;
      continue;
    }
    if (!/(课程|熟悉|掌握|技能|工具|语言)/.test(line)) continue;
    for (const raw of line.split(/[、，,；;。：:／/]/)) {
      const term = raw
        .replace(/^[-*\s]+/, '')
        .replace(STRIP_LEADING, '')
        // 只去掉尾部的分数/学分（如"高等数学 99"），保留词内的数字（如 STM32、T113）
        .replace(/[\s]*[\d.]+\s*(分|学分|绩点)?\s*$/, '')
        .replace(/[（(][^）)]*[）)]/g, '')
        .trim();
      if (term.length < 3 || term.length > 14) continue;
      if (/^(等|以及|相关|内容|经验|能力|工作|部分|情况|方面|原文未体现|未体现|平台开发)$/.test(term)) continue;
      terms.push({ term, section: section || 'skills' });
    }
  }
  return terms;
}

/**
 * 分类问题。
 * @returns {{mode:'none'|'sections'|'all', keys:string[], reason:string}}
 */
function classify(question, options = {}) {
  const q = String(question || '').trim();
  if (!q) return { mode: 'none', keys: [], reason: '空问题' };

  const scores = {};
  for (const [key, words] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const w of words) {
      if (q.includes(w)) score += w.length >= 3 ? 2 : 1;
    }
    if (score) scores[key] = score;
  }

  const selfIntro = SELF_INTRO_KEYWORDS.some((w) => q.includes(w));
  const hasExperienceCue = EXPERIENCE_CUES.some((re) => re.test(q));
  const theoryHits = THEORY_CUES.filter((w) => q.includes(w)).length;
  const keys = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);

  // 1) 自我介绍 / 优势 / 动机类 → 完整档案
  if (selfIntro) {
    return { mode: 'all', keys: [], reason: '自我介绍 / 自我评价类问题' };
  }

  // 2) 命中具体主题（项目 / 实习 / 科研 / 课程…）→ 只注入相关片段
  if (keys.length) {
    // 有经历信号，或理论词很少 → 认为是在问经历
    if (hasExperienceCue || theoryHits === 0) {
      return {
        mode: 'sections',
        keys: keys.slice(0, 3),
        reason: `命中主题：${keys.slice(0, 3).join('+')}${theoryHits ? '（含理论词但有经历信号）' : ''}`,
      };
    }
    // "解释一下你在项目里怎么做" — 理论词多但明显在问经历
    if (/你|自己/.test(q)) {
      return { mode: 'sections', keys: keys.slice(0, 3), reason: `问的是你的${keys[0]}（第二人称）` };
    }
    return { mode: 'none', keys: [], reason: `技术理论题（命中 ${keys.join('+')} 但无经历信号）` };
  }

  const termHit = (options.terms || []).find((t) => q.includes(t.term));

  // 3) 纯技术理论题（八股）→ 不注入简历
  //    例外：问的是档案里出现过的"课程"，此时注入学业表现更贴合（例如"自动控制原理里什么是根轨迹"）
  if (theoryHits > 0) {
    if (termHit && termHit.section === 'education') {
      return { mode: 'sections', keys: ['education'], reason: `问的是课程「${termHit.term}」` };
    }
    return { mode: 'none', keys: [], reason: `技术理论题（${theoryHits} 个理论特征词）` };
  }

  // 4) 其他情况提到档案里的具体技术名词 → 注入技能
  if (termHit) {
    return { mode: 'sections', keys: [termHit.section === 'education' ? 'education' : 'skills'], reason: `提到档案里的「${termHit.term}」` };
  }

  // 5) 判不出来 → 用配置的默认策略
  const fallback = options.defaultInject === 'all' ? 'all' : 'none';
  return { mode: fallback, keys: [], reason: '无明显信号，使用默认策略' };
}

/** 拼装要注入的背景片段 */
function assemble(sections, keys) {
  const picked = [];
  const wanted = ['basic', ...keys.filter((k) => k !== 'basic')];
  for (const key of wanted) if (sections[key]) picked.push(sections[key]);
  // 项目类问题顺带带上科研成果（面试常连着追问），实习类带上技能
  if (keys.includes('project') && sections.research && !picked.includes(sections.research)) picked.push(sections.research);
  if (keys.includes('internship') && sections.skills && !picked.includes(sections.skills)) picked.push(sections.skills);
  if (keys.includes('honors') && sections.skills && !picked.includes(sections.skills)) picked.push(sections.skills);
  return picked.join('\n\n').trim();
}

/**
 * 生成要注入的简历背景文本。
 * @returns {{text:string, mode:string, keys:string[], reason:string}}
 */
function buildResumeContext(profile, question, options = {}) {
  const full = String(profile || '').trim();
  if (!full) return { text: '', mode: 'none', keys: [], reason: '没有档案' };

  const contextMode = options.contextMode || 'smart';
  if (contextMode === 'none') return { text: '', mode: 'none', keys: [], reason: '配置为不注入' };
  if (contextMode === 'all') return { text: full, mode: 'all', keys: [], reason: '配置为全部注入' };

  const decision = classify(question, { terms: extractTerms(full), ...options });
  if (decision.mode === 'none') return { text: '', ...decision };

  const sections = splitSections(full);
  if (decision.mode === 'all' || !Object.keys(sections).length) {
    return { text: full, mode: 'all', keys: decision.keys, reason: decision.reason };
  }

  const text = assemble(sections, decision.keys) || full;
  return { text, mode: 'sections', keys: decision.keys, reason: decision.reason };
}

module.exports = { buildResumeContext, classify, splitSections, extractTerms };
