/**
 * 简历链路自检：不联网、不依赖任何个人材料，用桩模型把简历处理链路完整跑一遍。
 *
 * 覆盖容易回归的四段逻辑：
 *   1. 源文件识别（README 之类的说明文件不能当简历解析）；
 *   2. 首次解析落盘，二次启动命中缓存不再调模型；
 *   3. 源文件变化后缓存失效，重新解析；
 *   4. 没有 Key 时仍能复用已有缓存。
 *
 * PDF 夹具在运行时手写生成，避免仓库里出现二进制样本。
 *
 * 用法：npm run test:resume
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

const { loadResume, findSources, resumeCacheUsable, extractText } = require(path.join(ROOT, 'resume.js'));
const { buildResumeContext } = require(path.join(ROOT, 'resume-context.js'));
const { buildPdf } = require(path.join(__dirname, 'mini-pdf.js'));

const line = (t) => console.log(`\n===== ${t} =====`);
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failures++;
}

const FAKE_PROFILE = `## 基本信息
- 姓名/性别/出生年月：候选人 / 男 / 2003-05
- 当前学历/学校/专业/预计毕业：硕士 / 某大学 / 电子信息 / 2027-06

## 教育背景
- 某大学 电子信息工程 2021-09 ~ 2025-06，绩点 3.8/4.0，专业排名 5/120

## 实习经历
- 某科技公司 硬件测试实习生 2025-07 ~ 2025-09：负责服务器板卡信号完整性测试，编写自动化测试脚本，累计覆盖 30 个测试项

## 项目经历
- 高速链路眼图分析工具 2025-03 ~ 2025-06：独立完成，使用 Python 与仪器驱动，将单次分析耗时从 15 分钟压到 2 分钟
- 嵌入式数据采集板 2024-09 ~ 2025-01：负责原理图与 PCB 设计，STM32 固件开发

## 科研成果
- 一篇 EI 会议论文（第二作者）

## 荣誉奖项
- 全国大学生电子设计竞赛 省级一等奖
- 校级奖学金 2 次

## 专业技能
- 熟悉 Python、C、MATLAB；掌握 Altium Designer 与示波器、网分等仪器

## 可提炼亮点
- 测试自动化落地经验；高速链路调试经验`;

(async () => {
  line('0. 准备沙箱');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'iq-resume-check-'));
  const dir = path.join(sandbox, 'resume');
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'README.md'), '# 说明文件，不应被当作简历\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, '成绩单.txt'),
    '高等数学 99 分\n大学物理 95 分\n线性代数 92 分\n概率论与数理统计 90 分\n信号与系统 94 分\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, '项目清单.pdf'),
    buildPdf([
      'Education',
      'M.S. in Electronic Information, expected 2027-06',
      'B.S. in Electronic Engineering, 2021-09 to 2025-06, GPA 3.8/4.0',
      'Projects',
      'High speed link eye diagram tool: cut analysis time from 15min to 2min',
    ])
  );
  console.log(`沙箱：${sandbox}`);

  line('1. PDF 提取');
  const pdfText = await extractText(path.join(dir, '项目清单.pdf'));
  check('手写 PDF 能提取出文字', pdfText.length > 50, `${pdfText.length} 字`);
  check('提取内容正确', pdfText.includes('High speed link eye diagram'));

  line('2. 源文件识别（README 必须被排除）');
  const profilePath = path.join(dir, 'profile.md');
  const sources = findSources(dir, [profilePath]);
  const names = sources.map((f) => path.basename(f));
  console.log(`识别到 ${sources.length} 份：${names.join('、')}`);
  check('README.md 未被当作简历', !names.includes('README.md'));
  check('识别到 2 份材料', sources.length === 2, names.join('、'));

  line('3. 首次解析（桩模型）');
  let askCalls = 0;
  let lastUserPrompt = '';
  const cfg = { resume: { dir, profileFile: profilePath, enabled: true } };
  const first = await loadResume({
    appRoot: sandbox,
    config: cfg,
    ask: async (system, user) => {
      askCalls++;
      lastUserPrompt = user;
      return FAKE_PROFILE;
    },
    log: () => {},
  });
  check('返回了档案', !!first && first.profile.length > 100, `${first.profile.length} 字`);
  check('cached=false（首次解析）', first.cached === false);
  check('调用了 1 次模型', askCalls === 1);
  check('profile.md 已落盘', fs.existsSync(profilePath));
  check('.resume-meta.json 已落盘', fs.existsSync(path.join(dir, '.resume-meta.json')));
  check(
    '提示词带上了两份材料的文件名',
    lastUserPrompt.includes('项目清单.pdf') && lastUserPrompt.includes('成绩单.txt')
  );
  check('PDF 文本确实进了提示词', lastUserPrompt.includes('eye diagram'));

  line('4. 二次解析（命中缓存，不再调模型）');
  const second = await loadResume({
    appRoot: sandbox,
    config: cfg,
    ask: async () => {
      askCalls++;
      return FAKE_PROFILE;
    },
    log: () => {},
  });
  check('cached=true', second.cached === true);
  check('模型调用次数仍为 1', askCalls === 1, `实际 ${askCalls}`);

  line('5. 源文件变化后缓存失效');
  fs.writeFileSync(
    path.join(dir, '成绩单.txt'),
    '高等数学 99 分\n大学物理 95 分\n线性代数 92 分\n信号与系统 94 分\n',
    'utf8'
  );
  const third = await loadResume({
    appRoot: sandbox,
    config: cfg,
    ask: async () => {
      askCalls++;
      return FAKE_PROFILE;
    },
    log: () => {},
  });
  check('重新解析（cached=false）', third.cached === false);
  check('模型调用次数变为 2', askCalls === 2, `实际 ${askCalls}`);

  line('6. 没有 Key 时仍能复用缓存');
  check('缓存判定可用（无需模型）', resumeCacheUsable(dir, profilePath) === true);

  line('7. 简历注入策略');
  for (const [question, expected] of [
    ['什么是进程和线程的区别？', 'none'],
    ['解释一下 TCP 三次握手', 'none'],
    ['你项目里最难的地方是什么？', 'sections'],
    ['你在公司实习具体做了什么？', 'sections'],
    ['介绍一下你自己', 'all'],
    ['你拿过哪些奖项？', 'sections'],
    ['本科成绩怎么样？', 'sections'],
  ]) {
    const ctx = buildResumeContext(FAKE_PROFILE, question, { contextMode: 'smart', defaultInject: 'none' });
    const ok = ctx.mode === expected;
    console.log(
      `${ok ? '✓' : '✗'} 「${question}」=> ${ctx.mode}${ctx.keys.length ? `[${ctx.keys.join('+')}]` : ''} ` +
        `${ctx.text.length} 字 | ${ctx.reason}`
    );
    if (!ok) failures++;
  }

  line('8. 三种注入模式');
  for (const mode of ['smart', 'all', 'none']) {
    const ctx = buildResumeContext(FAKE_PROFILE, '你项目里最难的地方是什么？', {
      contextMode: mode,
      defaultInject: 'none',
    });
    console.log(`  ${mode} => ${ctx.mode}，${ctx.text.length} 字`);
  }

  fs.rmSync(sandbox, { recursive: true, force: true });

  console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项未通过`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error(`\n自检失败：${err.stack}`);
  process.exit(1);
});
