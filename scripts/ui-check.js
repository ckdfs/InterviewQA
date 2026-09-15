/**
 * 界面冒烟测试：不依赖真实网络与配置，用桩数据把渲染层完整跑一遍。
 *
 * 覆盖三类容易漏的问题：
 *   1. app.js 里引用的元素 ID 是否真的存在于 index.html（$('x') 拿到 null 会直接抛错）；
 *   2. 渲染进程有没有运行时异常（含 CSP 拦截、脚本加载失败）；
 *   3. 引导向导与设置面板的关键交互能不能走通。
 *
 * 用法：npm run test:ui
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const problems = [];

// 用真实的字段白名单校验保存请求，保证渲染层提交的字段后端确实认
const { EDITABLE } = require(path.join(ROOT, 'config.js'));

const SAMPLE_RESUME = [
  { name: '简历.pdf', size: 245760, mtimeMs: Date.now() },
  { name: '成绩单.txt', size: 8192, mtimeMs: Date.now() - 1000 },
];

const SETUP_STATE = {
  needsSetup: true,
  setupDone: false,
  deepseekKeySet: false,
  mimoKeySet: false,
  platform: process.platform,
  appVersion: '1.1.0-smoke',
  resume: {
    sources: SAMPLE_RESUME,
    dir: '/tmp/interviewqa-smoke/resume',
    profilePath: '/tmp/interviewqa-smoke/resume/profile.md',
    hasProfile: true,
    supported: ['pdf', 'txt', 'md', 'markdown'],
  },
  privacy:
    process.platform === 'darwin'
      ? { denied: true, status: 'denied', message: '冒烟测试：模拟未授予屏幕录制权限' }
      : null,
};

const SETTINGS_VIEW = {
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekModel: 'deepseek-flash',
  deepseekKeySet: true,
  deepseekKeyTail: '••••abcd',
  mimoKeySet: false,
  mimoKeyTail: '',
  mimoBaseUrl: 'https://api.xiaomimimo.com/v1',
  mimoModel: 'mimo-v2.5-asr',
  mimoLanguage: 'zh',
  sttEngine: 'mimo',
  fallbackToLocal: false,
  resumeEnabled: true,
  contextMode: 'smart',
  maxChars: 200,
  historyTurns: 3,
  reasoningEffort: 'none',
  targetSeconds: 8,
  maxSeconds: 14,
  silenceThresholdRms: 0.006,
  configPath: '/tmp/interviewqa-smoke/config.json',
  resumeDir: '/tmp/interviewqa-smoke/resume',
  isPackaged: false,
  platform: process.platform,
  resume: SETUP_STATE.resume,
  privacy: SETUP_STATE.privacy,
};

/** 界面提交过的保存请求，用于校验字段是否落在后端白名单内 */
const savedPatches = [];

/** 更新状态桩：先「无更新」，手动检查后变成「有新版本」，覆盖提示模式的完整交互 */
let updateState = {
  mode: 'notify',
  status: 'idle',
  currentVersion: '1.2.0-smoke',
  latestVersion: '',
  percent: 0,
  message: '有新版本时提示，由你自行下载安装',
  actions: [],
};
let openedUpdatePage = 0;

function validatePatch(patch) {
  if (!patch || typeof patch !== 'object') {
    problems.push('settings:save 没有收到字段对象');
    return;
  }
  const keys = Object.keys(patch);
  if (!keys.length) problems.push('settings:save 收到空字段对象');
  for (const key of keys) {
    if (!EDITABLE[key]) problems.push(`保存字段 ${key} 不在后端白名单 EDITABLE 中，实际保存会被拒绝`);
  }
  savedPatches.push(patch);
}

function registerStubs() {
  const handlers = {
    'status:get': () => ({ state: 'idle', message: '就绪，点击录音开始或直接在下方输入问题' }),
    'app:info': () => ({
      version: '1.1.0-smoke',
      platform: process.platform,
      arch: process.arch,
      packaged: false,
      configPath: '/tmp/interviewqa-smoke/config.json',
      resumeDir: '/tmp/interviewqa-smoke/resume',
      userDir: '/tmp/interviewqa-smoke',
      engine: 'mimo',
      localEngineAvailable: false,
      updateMode: 'notify',
      portable: false,
      signingKind: process.platform === 'darwin' ? 'adhoc' : 'n/a',
    }),
    'setup:get': () => SETUP_STATE,
    'setup:save': (patch) => {
      validatePatch(patch);
      return { ok: true, view: SETTINGS_VIEW };
    },
    'setup:finish': () => ({ ok: true, setup: { ...SETUP_STATE, needsSetup: false, setupDone: true } }),
    'setup:pickResume': () => ({ ok: true, added: ['简历.pdf'], resume: SETUP_STATE.resume }),
    'resume:get': () => ({ state: 'none', dir: SETUP_STATE.resume.dir, sources: [] }),
    'resume:reload': () => ({ state: 'ready', name: '候选人', source: '简历.pdf', sources: ['简历.pdf'], cached: false }),
    'settings:get': () => SETTINGS_VIEW,
    'settings:save': (patch) => {
      validatePatch(patch);
      return { ok: true, view: SETTINGS_VIEW, resume: SETUP_STATE.resume };
    },
    'settings:resumeRemove': () => ({ ok: true, resume: { ...SETUP_STATE.resume, sources: [] } }),
    'settings:revealResumeDir': () => ({ ok: true }),
    'settings:revealConfig': () => ({ ok: true }),
    'settings:testDeepSeek': () => ({ ok: true, message: 'DeepSeek 连接正常' }),
    'update:state': () => updateState,
    'update:check': () => {
      updateState = {
        ...updateState,
        status: 'available',
        latestVersion: '9.9.9',
        message: '发现新版本 9.9.9',
        actions: [{ id: 'open', label: '打开下载页' }],
      };
      return { ok: true };
    },
    'update:install': () => ({ ok: false }),
    'update:openPage': () => {
      openedUpdatePage += 1;
      return { ok: true };
    },
    'capture:status': () => SETUP_STATE.privacy || { granted: true },
    'capture:openPrivacy': () => ({ ok: true }),
    'recording:start': () => ({ ok: true }),
    'recording:stop': () => ({ ok: true }),
    'recording:cancel': () => ({ ok: true }),
    'answer:abort': () => ({ ok: true }),
    'question:submit': () => ({ ok: true }),
  };
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args) => fn(...args));
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 从 app.js 里抽出所有 $('id') 引用，作为「必须存在」的元素清单 */
function referencedIds() {
  const source = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  const ids = new Set();
  const re = /\$\('([A-Za-z0-9_-]+)'\)/g;
  let match;
  while ((match = re.exec(source))) ids.add(match[1]);
  return [...ids];
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  registerStubs();

  const win = new BrowserWindow({
    width: 1100,
    height: 860,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (...args) => {
    const [event, level, message] = args;
    const isError =
      typeof event === 'object' && event !== null && 'level' in event
        ? event.level === 'error' || event.level === 3
        : level === 3;
    if (isError) problems.push(`渲染进程报错：${typeof event === 'object' && event !== null ? event.message : message}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    problems.push(`渲染进程崩溃：${JSON.stringify(details)}`);
  });

  win.webContents.on('did-fail-load', (_event, code, description) => {
    problems.push(`页面加载失败：${code} ${description}`);
  });

  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await wait(1500);

  const run = (code) => win.webContents.executeJavaScript(`(() => { ${code} })()`);

  // 1) 元素 ID 完整性
  const missing = await win.webContents.executeJavaScript(
    `(() => ${JSON.stringify(referencedIds())}.filter((id) => !document.getElementById(id)))()`
  );
  if (missing.length) problems.push(`index.html 缺少 app.js 引用的元素：${missing.join(', ')}`);

  // 2) 引导向导首屏
  const boot = await run(`
    return {
      overlayVisible: !document.getElementById('setupOverlay').hidden,
      stepCount: document.querySelectorAll('#setupSteps .step').length,
      activePane: document.querySelector('#setupOverlay .pane.is-active')?.dataset.pane,
      resumeItems: document.querySelectorAll('#setupResumeList .resume-item').length,
      checkItems: document.querySelectorAll('#setupCheckList li').length,
      recordText: document.getElementById('recordBtnText').textContent,
      statusText: document.getElementById('statusText').textContent,
      badge: document.getElementById('resumeBadge').textContent,
      inputDisabled: document.getElementById('questionInput').disabled,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  `);

  if (!boot.overlayVisible) problems.push('首次启动没有弹出初始化引导');
  if (boot.stepCount !== 3) problems.push(`引导步骤数应为 3，实际 ${boot.stepCount}`);
  if (boot.activePane !== '1') problems.push(`引导初始应停在第 1 步，实际第 ${boot.activePane} 步`);
  if (boot.resumeItems !== SAMPLE_RESUME.length) problems.push('引导里的简历清单没有渲染出来');
  const expectedChecks = process.platform === 'darwin' ? 4 : 3;
  if (boot.checkItems !== expectedChecks) {
    problems.push(`第 3 步的检查项数量异常：${boot.checkItems}（应为 ${expectedChecks}）`);
  }
  if (boot.recordText !== '开始录音') problems.push(`录音按钮文案异常：${boot.recordText}`);
  if (boot.inputDisabled) problems.push('空闲状态下输入框不应被禁用');

  // 3) 引导下一步（第 1 步 → 第 2 步）
  await run(`document.getElementById('setupDeepseekKey').value = 'sk-smoke-test-key'; document.getElementById('setupNextBtn').click(); return 1;`);
  await wait(700);
  const step2 = await run(`
    return document.querySelector('#setupOverlay .pane.is-active')?.dataset.pane;
  `);
  if (step2 !== '2') problems.push(`点下一步后应进入第 2 步，实际第 ${step2} 步`);

  // 4) 跳到第 3 步并走完引导
  await run(`document.getElementById('setupNextBtn').click(); return 1;`);
  await wait(600);
  await run(`document.getElementById('setupNextBtn').click(); return 1;`);
  await wait(700);
  const afterFinish = await run(`
    return {
      overlayVisible: !document.getElementById('setupOverlay').hidden,
      toastCount: document.querySelectorAll('.toast').length,
    };
  `);
  if (afterFinish.overlayVisible) problems.push('点「开始使用」后引导没有关闭');
  if (afterFinish.toastCount < 1) problems.push('引导完成后没有给出提示');

  // 5) 设置面板：打开、切页签、保存
  await run(`document.getElementById('settingsBtn').click(); return 1;`);
  await wait(700);
  const drawer = await run(`
    return {
      open: !document.getElementById('settingsDrawer').hidden,
      mask: !document.getElementById('drawerMask').hidden,
      resumeItems: document.querySelectorAll('#setResumeList .resume-item').length,
      aboutRows: document.querySelectorAll('#aboutList dt').length,
      keyState: document.getElementById('setDeepseekKeyState').textContent,
    };
  `);
  if (!drawer.open || !drawer.mask) problems.push('设置抽屉没有正常打开');
  if (drawer.resumeItems !== SAMPLE_RESUME.length) problems.push('设置里的简历清单没有渲染出来');
  if (drawer.aboutRows !== 6) problems.push(`关于页签字段数异常：${drawer.aboutRows}`);
  if (!drawer.keyState.includes('已配置')) problems.push('已配置的 Key 状态没有回显');

  await run(`document.querySelector('#settingsTabs .tab[data-tab="answer"]').click(); return 1;`);
  await wait(300);
  await run(`document.getElementById('settingsSaveBtn').click(); return 1;`);
  await wait(700);
  const saved = await run(`return document.getElementById('settingsNote').textContent;`);
  if (saved !== '已保存') problems.push(`保存设置后的提示异常：${saved}`);

  // 6) 关于页签里的自动更新入口
  await run(`document.querySelector('#settingsTabs .tab[data-tab="about"]').click(); return 1;`);
  await wait(300);
  const updateIdle = await run(`
    return {
      hint: document.getElementById('updateHint').textContent,
      checkDisabled: document.getElementById('updateCheckBtn').disabled,
      actionHidden: document.getElementById('updateActionBtn').hidden,
    };
  `);
  if (!updateIdle.hint.trim()) problems.push('关于页的更新状态没有渲染');
  if (updateIdle.checkDisabled) problems.push('提示模式下「检查更新」不应被禁用');
  if (!updateIdle.actionHidden) problems.push('没有待处理动作时不该显示操作按钮');

  await run(`document.getElementById('updateCheckBtn').click(); return 1;`);
  await wait(600);
  const updateFound = await run(`
    return {
      hint: document.getElementById('updateHint').textContent,
      actionHidden: document.getElementById('updateActionBtn').hidden,
      actionLabel: document.getElementById('updateActionBtn').textContent,
      actionId: document.getElementById('updateActionBtn').dataset.action,
    };
  `);
  if (!updateFound.hint.includes('9.9.9')) problems.push(`检查更新后的状态没有回显版本号：${updateFound.hint}`);
  if (updateFound.actionHidden) problems.push('发现新版本后应出现操作按钮');
  if (updateFound.actionLabel !== '打开下载页') problems.push(`提示模式下的操作应为打开下载页：${updateFound.actionLabel}`);

  await run(`document.getElementById('updateActionBtn').click(); return 1;`);
  await wait(400);
  if (openedUpdatePage !== 1) problems.push(`点「打开下载页」没有走到主进程，调用次数 ${openedUpdatePage}`);

  await run(`document.getElementById('settingsCloseBtn').click(); return 1;`);
  await wait(400);
  const closed = await run(`return document.getElementById('settingsDrawer').hidden;`);
  if (!closed) problems.push('设置抽屉没有正常关闭');

  // 界面保存过的字段必须都能被后端接受
  const coveredFields = new Set(savedPatches.flatMap((patch) => Object.keys(patch)));
  for (const field of ['answer.reasoningEffort', 'answer.maxChars', 'resume.contextMode']) {
    if (!coveredFields.has(field)) problems.push(`设置面板没有提交 ${field}`);
  }

  // 结果
  if (problems.length) {
    console.error('\n界面冒烟测试未通过：');
    problems.forEach((item) => console.error(`  ✗ ${item}`));
    app.exit(1);
    return;
  }

  console.log('界面冒烟测试通过：元素引用完整、引导向导、设置面板与更新入口交互正常');
  console.log(`  检查元素 ${referencedIds().length} 个，引导 3 步，设置 4 个页签`);
  console.log(`  保存字段 ${coveredFields.size} 个，全部命中后端白名单`);
  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
