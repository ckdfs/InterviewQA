/**
 * 简历注入策略自测。
 *
 * 默认用 scripts/fixtures/sample-profile.md 这份合成档案，本地与 CI 输入一致，
 * 因此可以对每个问题断言期望的注入模式；判定被改坏时会直接失败，而不只是打印。
 *
 * 想看看自己的档案在各问题下的判定效果，用：
 *   node test-resume-context.js --profile resume/profile.md
 * 该模式下只打印结果、不做断言（真实档案内容因人而异，不适合写死期望值）。
 */
const fs = require('fs');
const path = require('path');
const { buildResumeContext } = require('./resume-context');

const argv = process.argv.slice(2);
const customIndex = argv.indexOf('--profile');
const customPath = customIndex >= 0 ? argv[customIndex + 1] : null;
const fixturePath = path.join(__dirname, 'scripts', 'fixtures', 'sample-profile.md');
const profilePath = customPath ? path.resolve(customPath) : fixturePath;
const assertMode = !customPath;

if (!fs.existsSync(profilePath)) {
  console.error(`找不到档案文件：${profilePath}`);
  process.exit(1);
}
const profile = fs.readFileSync(profilePath, 'utf8');

/**
 * 问题 → 期望判定。mode 为 none 表示不注入（八股题），
 * sections 表示只注入相关片段（keys 至少包含列出的主题之一），all 表示完整档案。
 */
const CASES = [
  // 技术理论题：不注入简历，避免八股硬套经历
  { q: '什么是进程和线程的区别？', mode: 'none' },
  { q: '解释一下 TCP 三次握手', mode: 'none' },
  { q: '谈谈你对数据库索引的理解', mode: 'none' },
  { q: '说一下 STM32 的中断机制', mode: 'none' },
  { q: '乐观锁和悲观锁有什么区别？', mode: 'none' },
  // 项目类：注入项目经历
  { q: '你项目里最难的地方是什么？怎么解决的？', mode: 'sections', keys: ['project'] },
  { q: '介绍一下你做的嵌入式调试系统', mode: 'sections', keys: ['project'] },
  { q: '举一个你独立完成的例子', mode: 'sections', keys: ['project'] },
  { q: '那个采集板项目的偏压控制是怎么实现的？', mode: 'sections', keys: ['project'] },
  // 实习类：注入实习经历
  { q: '你在实习的时候负责哪部分？', mode: 'sections', keys: ['internship'] },
  { q: '讲讲你的实习经历', mode: 'sections', keys: ['internship'] },
  // 科研 / 荣誉 / 学业 / 技能
  { q: '介绍一下你的论文', mode: 'sections', keys: ['research'] },
  { q: '你拿过哪些竞赛奖项？', mode: 'sections', keys: ['honors'] },
  { q: '你本科成绩怎么样？', mode: 'sections', keys: ['education'] },
  { q: '你熟悉哪些工具和编程语言？', mode: 'sections', keys: ['skills'] },
  // 自我介绍 / 自我评价 / 动机：完整档案
  { q: '介绍一下你自己', mode: 'all' },
  { q: '你的优势是什么？', mode: 'all' },
  { q: '你最大的缺点是什么？', mode: 'all' },
  { q: '为什么要选这个岗位？', mode: 'all' },
  { q: '你的职业规划是什么？', mode: 'all' },
];

const modeLabel = { none: '不注入 ', sections: '片段注入', all: '完整档案' };
let maxChars = 0;
const stats = { none: 0, sections: 0, all: 0 };
const failures = [];

console.log(`档案来源：${customPath ? profilePath : 'scripts/fixtures/sample-profile.md（合成夹具）'}`);
console.log(`档案总长：${profile.length} 字\n`);

for (const item of CASES) {
  const r = buildResumeContext(profile, item.q, { contextMode: 'smart' });
  stats[r.mode] = (stats[r.mode] || 0) + 1;
  maxChars = Math.max(maxChars, r.text.length);

  let verdict = '  ';
  if (assertMode) {
    const modeOk = r.mode === item.mode;
    const keysOk =
      !item.keys || (r.keys || []).some((k) => item.keys.includes(k));
    if (modeOk && keysOk) {
      verdict = '✓ ';
    } else {
      verdict = '✗ ';
      const want = `${item.mode}${item.keys ? ` keys⊇${item.keys.join('|')}` : ''}`;
      const got = `${r.mode}${r.keys && r.keys.length ? ` keys=${r.keys.join('+')}` : ''}`;
      failures.push(`${item.q}\n      期望 ${want}，实际 ${got}（${r.reason}）`);
    }
  }

  const detail = r.mode === 'sections' ? r.keys.join('+') : '—';
  console.log(`${verdict}${modeLabel[r.mode]} | ${String(r.text.length).padStart(5)} 字 | ${detail.padEnd(20)} | ${item.q}`);
  console.log(`             └ ${r.reason}`);
}

console.log(`\n统计：不注入 ${stats.none} 条 / 片段注入 ${stats.sections} 条 / 完整档案 ${stats.all} 条`);
console.log(`单次最大注入 ${maxChars} 字（越短越省 token、越不容易带偏）`);

if (assertMode && failures.length) {
  console.error(`\n注入策略自测未通过，${failures.length} 条判定与期望不符：`);
  failures.forEach((item) => console.error(`  ✗ ${item}`));
  process.exit(1);
}
if (assertMode) console.log(`\n注入策略自测通过：${CASES.length} 条问题的判定与期望一致`);
