/**
 * 转写片段拼接自测。
 *
 * 相邻切片刻意保留重叠，拼接时要去掉重复部分。识别结果对同一段音频可能给出
 * 同音不同字的结果，逐字精确匹配会失效，所以这里把真实出现过的失败样本
 * 固化成用例，防止判定被改回逐字匹配。
 *
 * 用法：npm run test:merge
 */
const { mergeWithOverlapDedupe } = require('../transcript-merge');

const CASES = [
  {
    name: '同音字造成的重叠（线上真实样本）',
    a: '请介绍一下你项目里最难解决的一个问题，你当时是怎么定位到根因的？',
    b: '定位到根音的。',
    want: '请介绍一下你项目里最难解决的一个问题，你当时是怎么定位到根因的？',
  },
  {
    name: '重叠处标点不同',
    a: '请介绍一下你的项目经验',
    b: '项目经验，你遇到的最大挑战是什么',
    want: '请介绍一下你的项目经验，你遇到的最大挑战是什么',
  },
  {
    name: '切片开头多吞了一两个字',
    a: '你当时是怎么定位到根因的',
    b: '嗯定位到根因的，然后呢',
    want: '你当时是怎么定位到根因的，然后呢',
  },
  {
    name: '完全重叠（尾片只重复了上一句）',
    a: '你在实习期间主要负责哪部分工作？',
    b: '主要负责哪部分工作？',
    want: '你在实习期间主要负责哪部分工作？',
  },
  {
    name: '没有重叠时原样拼接',
    a: '什么是进程和线程的区别',
    b: '你了解协程吗',
    want: '什么是进程和线程的区别你了解协程吗',
  },
  {
    name: '重叠不足四个字时不做切除',
    a: '这个方案不错',
    b: '不错',
    want: '这个方案不错不错',
  },
  {
    name: '中英混排的重叠',
    a: '我最熟悉 Python 和 Go 两种语言',
    b: 'Python 和 Go 两种语言，也写过一些 C',
    want: '我最熟悉 Python 和 Go 两种语言，也写过一些 C',
  },
  {
    name: '差异过多时判定为不重叠',
    a: '你觉得分布式事务应该怎么做',
    b: '分布式缓存应该怎么选型',
    want: '你觉得分布式事务应该怎么做分布式缓存应该怎么选型',
  },
  {
    // 重叠只覆盖 a 的中段而不是尾部时，属于切分异常而非重叠，保持原样拼接
    name: '重叠不在 a 的尾部时保持拼接',
    a: '我喜欢用 Python 写脚本',
    b: 'Python 是我最常用的语言',
    want: '我喜欢用 Python 写脚本Python 是我最常用的语言',
  },
];

const failures = [];
for (const item of CASES) {
  const got = mergeWithOverlapDedupe(item.a, item.b);
  const ok = got === item.want;
  console.log(`${ok ? '✓' : '✗'} ${item.name}`);
  if (!ok) {
    console.log(`    输入 a：${item.a}`);
    console.log(`    输入 b：${item.b}`);
    console.log(`    期望：${item.want}`);
    console.log(`    实际：${got}`);
    failures.push(item.name);
  }
}

if (failures.length) {
  console.error(`\n转写拼接自测未通过，${failures.length}/${CASES.length} 条不符`);
  process.exit(1);
}
console.log(`\n转写拼接自测通过：${CASES.length} 条用例全部符合预期`);
