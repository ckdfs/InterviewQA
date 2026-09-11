/**
 * 简历注入策略自测：跑一批典型问题，看看各自的判定与注入内容大小。
 * 用法：npm run test:context
 * 觉得某类问题判得不对，改 resume-context.js 里的关键词表即可。
 */
const fs = require('fs');
const path = require('path');
const { buildResumeContext } = require('./resume-context');

const profilePath = path.join(__dirname, 'resume', 'profile.md');
if (!fs.existsSync(profilePath)) {
  console.error(`找不到 ${profilePath}，先运行一次应用解析简历，或把档案放进去`);
  process.exit(1);
}
const profile = fs.readFileSync(profilePath, 'utf8');

const QUESTIONS = [
  // 八股 / 技术理论：预期不注入
  '什么是进程和线程的区别？',
  '解释一下 TCP 三次握手',
  '谈谈你对数据库索引的理解',
  '说一下 STM32 的中断机制',
  '乐观锁和悲观锁有什么区别？',
  // 项目类：预期注入项目经历（+科研成果）
  '你项目里最难的地方是什么？怎么解决的？',
  '电光调制器那个项目的偏压控制是怎么实现的？',
  '介绍一下你做的嵌入式调试系统',
  '举一个你独立完成的例子',
  // 实习类：预期注入实习经历（+专业技能）
  '你在特斯拉实习具体做了什么？',
  '你在算能实习的时候负责哪部分？',
  '讲讲你的实习经历',
  // 科研 / 荣誉 / 学业 / 技能
  '介绍一下你的论文',
  '你拿过哪些竞赛奖项？',
  '你本科成绩怎么样？',
  '你熟悉哪些工具和编程语言？',
  // 自我介绍类：预期注入完整档案
  '介绍一下你自己',
  '你的优势是什么？',
  '你最大的缺点是什么？',
  '为什么要选这个岗位？',
  '你的职业规划是什么？',
];

const modeLabel = { none: '不注入 ', sections: '片段注入', all: '完整档案' };
let maxChars = 0;
const stats = { none: 0, sections: 0, all: 0 };

console.log(`档案总长：${profile.length} 字\n`);
for (const q of QUESTIONS) {
  const r = buildResumeContext(profile, q, { contextMode: 'smart' });
  stats[r.mode] = (stats[r.mode] || 0) + 1;
  maxChars = Math.max(maxChars, r.text.length);
  const detail = r.mode === 'sections' ? r.keys.join('+') : '—';
  console.log(`${modeLabel[r.mode]} | ${String(r.text.length).padStart(5)} 字 | ${detail.padEnd(22)} | ${q}`);
  console.log(`             └ ${r.reason}`);
}
console.log(`\n统计：不注入 ${stats.none} 条 / 片段注入 ${stats.sections} 条 / 完整档案 ${stats.all} 条`);
console.log(`单次最大注入 ${maxChars} 字（越短越省 token、越不容易带偏）`);
