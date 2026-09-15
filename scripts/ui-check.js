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
  appVersion: '1.2.0-smoke',
  deepseekBaseUrl: 'https://api.deepseek.com',
  mimoBaseUrl: 'https://api.xiaomimimo.com/v1',
  resume: {
    sources: SAMPLE_RESUME,
    dir: '/tmp/interviewqa-smoke/resume',
    profilePath: '/tmp/interviewqa-smoke/resume/profile.md',
    hasProfile: true,
    supported: ['pdf', 'txt', 'md', 'markdown'],
  },
  audio: { source: 'system', deviceId: '', deviceLabel: '' },
  capture: {
    platform: process.platform,
    source: 'system',
    screen:
      process.platform === 'darwin'
        ? {
            kind: 'screen',
            label: '电脑声音',
            granted: false,
            usable: false,
            status: 'denied',
            message: '冒烟测试：模拟未授予屏幕录制权限',
          }
        : { kind: 'screen', label: '电脑声音', granted: true, usable: true, status: 'granted', message: null },
    microphone: {
      kind: 'microphone',
      label: '麦克风',
      granted: true,
      usable: true,
      status: 'granted',
      message: null,
    },
  },
};

const SETTINGS_VIEW = {
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekModel: 'deepseek-flash',
  deepseekKeySet: true,
  deepseekKeyTail: '••••abcd',
  mimoKeySet: true,
  mimoKeyTail: '••••wxyz',
  mimoBaseUrl: 'https://api.xiaomimimo.com/v1',
  mimoModel: 'mimo-v2.5-asr',
  mimoLanguage: 'zh',
  audioSource: 'system',
  audioDeviceId: '',
  audioDeviceLabel: '',
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
  capture: SETUP_STATE.capture,
};

/** 界面提交过的保存请求，用于校验字段是否落在后端白名单内 */
const savedPatches = [];

/** 渲染层提交过的问题，用于校验重试确实把原问题重新送了出去 */
const submittedQuestions = [];

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
  applyPatch(patch);
}

/**
 * 桩状态要跟着保存请求变化，否则「保存后再回到上一步，Key 会被当成没配置」
 * 这类流程在真实环境正常、在冒烟里假失败。
 */
function applyPatch(patch) {
  if (patch.deepseekApiKey) SETUP_STATE.deepseekKeySet = true;
  if (patch['stt.mimo.apiKey']) SETUP_STATE.mimoKeySet = true;
  if (patch['audio.source']) {
    SETUP_STATE.audio.source = patch['audio.source'];
    SETTINGS_VIEW.audioSource = patch['audio.source'];
    SETUP_STATE.capture.source = patch['audio.source'];
  }
  if (patch['audio.deviceId'] !== undefined) {
    SETUP_STATE.audio.deviceId = patch['audio.deviceId'];
    SETTINGS_VIEW.audioDeviceId = patch['audio.deviceId'];
  }
  if (patch['audio.deviceLabel'] !== undefined) {
    SETUP_STATE.audio.deviceLabel = patch['audio.deviceLabel'];
    SETTINGS_VIEW.audioDeviceLabel = patch['audio.deviceLabel'];
  }
}

function registerStubs() {
  const handlers = {
    'status:get': () => ({ state: 'idle', message: '就绪，点击录音开始或直接在下方输入问题' }),
    'app:info': () => ({
      version: '1.2.0-smoke',
      platform: process.platform,
      arch: process.arch,
      packaged: false,
      configPath: '/tmp/interviewqa-smoke/config.json',
      resumeDir: '/tmp/interviewqa-smoke/resume',
      userDir: '/tmp/interviewqa-smoke',
      audioSource: 'system',
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
    'settings:testDeepSeek': () => ({ ok: true, message: 'DeepSeek 连接正常，Key 有效' }),
    'settings:testMimo': () => ({
      ok: true,
      reason: 'ok',
      message: 'MiMo 连接与转写可用（https://api.xiaomimimo.com/v1 / mimo-v2.5-asr），识别返回 0 字',
    }),
    'capture:status': () => SETUP_STATE.capture,
    'capture:requestMicrophone': () => ({ ok: true, access: SETUP_STATE.capture.microphone }),
    'capture:openPrivacy': (_event) => ({ ok: true }),
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
    'recording:start': () => ({ ok: true }),
    'recording:stop': () => ({ ok: true }),
    'recording:cancel': () => ({ ok: true }),
    'answer:abort': () => ({ ok: true }),
    'question:submit': (text) => {
      submittedQuestions.push(text);
      return { ok: true };
    },
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

/**
 * 汇总结果。断言脚本里点不到元素会让 executeJavaScript 抛错，
 * 这类失败要报成一条问题，否则整轮自测卡在未处理的 Promise 上，
 * 日志里只剩一句看不出原因的堆栈。中断退出时拿不到覆盖字段数，因此允许缺省。
 */
function report(coveredFields) {
  if (problems.length) {
    console.error('\n界面冒烟测试未通过：');
    problems.forEach((item) => console.error(`  ✗ ${item}`));
    app.exit(1);
    return;
  }

  console.log('界面冒烟测试通过：元素引用完整、引导向导、音源切换、连接自检、报错重试、设置面板与更新入口交互正常');
  console.log(`  检查元素 ${referencedIds().length} 个，引导 3 步，设置 4 个页签`);
  console.log(`  保存字段 ${coveredFields ? coveredFields.size : 0} 个，全部命中后端白名单`);
  app.exit(0);
}

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
      probeItems: document.querySelectorAll('#setupProbeList .probe-item').length,
      probeStates: [...document.querySelectorAll('#setupProbeList .probe-state')].map((n) => n.textContent),
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
  // 五项检查：两个 Key、电脑声音、麦克风、简历
  if (boot.checkItems !== 5) problems.push(`第 3 步的检查项数量异常：${boot.checkItems}（应为 5）`);
  if (boot.probeItems !== 2) problems.push(`连接自检应有两条链路，实际 ${boot.probeItems} 条`);
  if (boot.probeStates.some((text) => text !== '未测试')) {
    problems.push(`自检初始状态应都是「未测试」：${boot.probeStates.join(' / ')}`);
  }
  if (boot.recordText !== '开始录音') problems.push(`录音按钮文案异常：${boot.recordText}`);
  if (boot.inputDisabled) problems.push('空闲状态下输入框不应被禁用');

  // 3) 第 1 步的「测试连接与转写」：两条链路都要出结论
  await run(`
    document.getElementById('setupDeepseekKey').value = 'sk-smoke-test-key';
    document.getElementById('setupTestBtn').click();
    return 1;
  `);
  await wait(900);
  const probed = await run(`
    return [...document.querySelectorAll('#setupProbeList .probe-item')].map((n) => ({
      ok: n.classList.contains('is-ok'),
      text: n.querySelector('.probe-state').textContent,
    }));
  `);
  if (!probed[0].ok || !probed[0].text.includes('DeepSeek')) {
    problems.push(`作答链路自检没有落到成功：${probed[0].text}`);
  }
  if (!probed[1].ok || !probed[1].text.includes('转写可用')) {
    problems.push(`转写链路自检没有落到成功：${probed[1].text}`);
  }

  // 4) 引导下一步（第 1 步 → 第 2 步）
  await run(`document.getElementById('setupNextBtn').click(); return 1;`);
  await wait(700);
  const step2 = await run(`
    return document.querySelector('#setupOverlay .pane.is-active')?.dataset.pane;
  `);
  if (step2 !== '2') problems.push(`点下一步后应进入第 2 步，实际第 ${step2} 步`);

  // 5) 第 3 步：音源切换、麦克风选择、试录失败时的说明
  await run(`document.getElementById('setupNextBtn').click(); return 1;`);
  await wait(700);
  const step3 = await run(`
    return {
      pane: document.querySelector('#setupOverlay .pane.is-active')?.dataset.pane,
      activeSource: document.querySelector('#setupSourceSwitch .seg.is-active')?.dataset.source,
      micHidden: document.getElementById('setupMicField').hidden,
      micOptions: document.querySelectorAll('#setupMicSelect option').length,
    };
  `);
  if (step3.pane !== '3') problems.push(`应进入第 3 步，实际第 ${step3.pane} 步`);
  if (step3.activeSource !== 'system') problems.push(`默认音源应为电脑声音，实际 ${step3.activeSource}`);
  if (!step3.micHidden) problems.push('默认音源下不该显示麦克风选择');
  if (step3.micOptions < 1) problems.push('麦克风下拉至少要有一个默认项');

  await run(`
    document.querySelector('#setupSourceSwitch .seg[data-source="microphone"]').click();
    return 1;
  `);
  await wait(500);
  const switched = await run(`
    return {
      micHidden: document.getElementById('setupMicField').hidden,
      activeSource: document.querySelector('#setupSourceSwitch .seg.is-active')?.dataset.source,
      bottomSource: document.querySelector('#sourceSwitch .seg.is-active')?.dataset.source,
      settingsSource: document.querySelector('#setSourceSwitch .seg.is-active')?.dataset.source,
      hint: document.getElementById('setupSourceHint').textContent,
    };
  `);
  if (switched.micHidden) problems.push('切到麦克风后应显示麦克风选择');
  if (switched.activeSource !== 'microphone') problems.push('音源没有切到麦克风');
  if (switched.bottomSource !== 'microphone' || switched.settingsSource !== 'microphone') {
    problems.push(`三处音源视图没有同步：底栏 ${switched.bottomSource}，设置 ${switched.settingsSource}`);
  }
  if (!switched.hint.includes('麦克风')) problems.push(`音源说明没有跟着换：${switched.hint}`);

  // 麦克风被系统拒绝时，给出的必须是可操作的说明，而不是笼统的失败
  await run(`
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    document.getElementById('setupProbeBtn').click();
    return 1;
  `);
  await wait(900);
  const probeFailed = await run(`return document.getElementById('setupProbeResult').textContent;`);
  if (!probeFailed.includes('麦克风')) problems.push(`试录失败没有说明原因：${probeFailed}`);
  if (!probeFailed.includes('系统设置')) problems.push(`试录失败没有给出下一步：${probeFailed}`);

  // 切回电脑声音再走完引导
  await run(`
    document.querySelector('#setupSourceSwitch .seg[data-source="system"]').click();
    return 1;
  `);
  await wait(400);
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
  if (drawer.aboutRows !== 7) problems.push(`关于页签字段数异常：${drawer.aboutRows}`);
  if (!drawer.keyState.includes('已配置')) problems.push('已配置的 Key 状态没有回显');

  // 模型服务页签：两条链路各自可以单独测
  const deepseekBefore = await run(`return document.querySelector('#setProbeDeepseek .probe-state').textContent;`);
  await run(`document.getElementById('setTestMimoBtn').click(); return 1;`);
  await wait(700);
  const mimoProbe = await run(`
    return {
      ok: document.getElementById('setProbeMimo').classList.contains('is-ok'),
      text: document.querySelector('#setProbeMimo .probe-state').textContent,
      deepseekText: document.querySelector('#setProbeDeepseek .probe-state').textContent,
    };
  `);
  if (!mimoProbe.ok || !mimoProbe.text.includes('转写可用')) {
    problems.push(`MiMo 自检没有落到成功：${mimoProbe.text}`);
  }
  if (mimoProbe.deepseekText !== deepseekBefore) {
    problems.push('只测转写时不该改动作答链路的结论');
  }

  await run(`document.getElementById('setTestDeepseekBtn').click(); return 1;`);
  await wait(700);
  const deepseekProbe = await run(`
    return {
      ok: document.getElementById('setProbeDeepseek').classList.contains('is-ok'),
      text: document.querySelector('#setProbeDeepseek .probe-state').textContent,
    };
  `);
  if (!deepseekProbe.ok || !deepseekProbe.text.includes('DeepSeek')) {
    problems.push(`DeepSeek 自检没有落到成功：${deepseekProbe.text}`);
  }

  await run(`document.querySelector('#settingsTabs .tab[data-tab="answer"]').click(); return 1;`);
  await wait(300);
  await run(`document.getElementById('settingsSaveBtn').click(); return 1;`);
  await wait(700);
  const saved = await run(`return document.getElementById('settingsNote').textContent;`);
  if (saved !== '已保存') problems.push(`保存设置后的提示异常：${saved}`);

  // 设置里的音源控件要反映底栏的状态，切过来就能直接改
  const settingsSource = await run(`
    return {
      active: document.querySelector('#setSourceSwitch .seg.is-active')?.dataset.source,
      micHidden: document.getElementById('setMicField').hidden,
    };
  `);
  if (settingsSource.active !== 'system') problems.push(`设置里的音源没有同步：${settingsSource.active}`);
  if (!settingsSource.micHidden) problems.push('电脑声音下设置里不该显示麦克风选择');

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

  // 7) 报错中断后的重试：报错旁边要有重试按钮，点了用原问题重跑且不重复插一条提问
  const RETRY_Q = '你项目里最难解决的一个问题是什么';
  const rowsBefore = await run(`
    return {
      user: document.querySelectorAll('.row.is-user').length,
      ai: document.querySelectorAll('.row.is-ai').length,
    };
  `);

  // 模拟主进程走完一轮失败：开始作答 → 报错 → 收尾
  win.webContents.send('answer:start', { question: RETRY_Q });
  await wait(200);
  win.webContents.send('error', {
    message: '调用 DeepSeek 失败：连接被重置',
    retry: { kind: 'answer', question: RETRY_Q },
  });
  await wait(200);
  win.webContents.send('answer:done', { text: '', failed: true });
  await wait(300);

  const failedTurn = await run(`
    const btn = document.querySelector('.retry-btn');
    return {
      user: document.querySelectorAll('.row.is-user').length,
      ai: document.querySelectorAll('.row.is-ai').length,
      errorText: document.querySelector('.row .bubble.is-error')?.textContent || '',
      retryLabel: btn ? btn.getAttribute('aria-label') : '',
      retryTitle: btn ? btn.title : '',
      retryIcon: Boolean(btn && btn.querySelector('svg path')),
      retryText: btn ? btn.textContent.trim() : '有文字',
      retryBox: btn ? [Math.round(btn.getBoundingClientRect().width), Math.round(btn.getBoundingClientRect().height)] : [0, 0],
      retryRadius: btn ? getComputedStyle(btn).borderRadius : '',
      retryBg: btn ? getComputedStyle(btn).backgroundColor : '',
      emptyAi: [...document.querySelectorAll('.row.is-ai .bubble')].filter((n) => !n.textContent.trim()).length,
    };
  `);
  if (failedTurn.user !== rowsBefore.user + 1) {
    problems.push(`报错一轮应正好多一条提问，实际 ${rowsBefore.user} → ${failedTurn.user}`);
  }
  if (failedTurn.ai !== rowsBefore.ai + 1) {
    problems.push(`失败后应只留报错行，实际回答行 ${rowsBefore.ai} → ${failedTurn.ai}`);
  }
  if (failedTurn.emptyAi) problems.push('失败后留下了空的回答气泡');
  if (!failedTurn.errorText.includes('连接被重置')) problems.push(`报错内容没有呈现：${failedTurn.errorText}`);
  if (failedTurn.retryLabel !== '重试') problems.push(`重试按钮没有可读的名称：${failedTurn.retryLabel}`);
  if (failedTurn.retryTitle !== '重试') problems.push(`重试按钮缺少悬停提示：${failedTurn.retryTitle}`);
  if (!failedTurn.retryIcon) problems.push('重试按钮里没有图标');
  if (failedTurn.retryText) problems.push(`重试按钮应是纯图标，却带了文字：${failedTurn.retryText}`);
  if (failedTurn.retryBox[0] > 32 || failedTurn.retryBox[1] > 32) {
    problems.push(`重试按钮过大了：${failedTurn.retryBox.join('×')}，应是一个小圆点`);
  }
  if (failedTurn.retryBox[0] !== failedTurn.retryBox[1]) {
    problems.push(`重试按钮应为正圆，实际 ${failedTurn.retryBox.join('×')}`);
  }
  if (failedTurn.retryRadius !== '50%' && parseFloat(failedTurn.retryRadius) < failedTurn.retryBox[0] / 2) {
    problems.push(`重试按钮应为正圆：半径 ${failedTurn.retryRadius}，边长 ${failedTurn.retryBox[0]}`);
  }
  if (!failedTurn.retryBg.startsWith('rgb(229, 72, 77')) problems.push(`重试按钮应为红色：${failedTurn.retryBg}`);

  await run(`document.querySelector('.retry-btn').click(); return 1;`);
  await wait(400);
  const afterRetry = await run(`
    return {
      user: document.querySelectorAll('.row.is-user').length,
      errors: document.querySelectorAll('.row .bubble.is-error').length,
      actions: document.querySelectorAll('.retry-btn').length,
    };
  `);
  if (submittedQuestions[submittedQuestions.length - 1] !== RETRY_Q) {
    problems.push(`重试没有把原问题重新提交：${submittedQuestions.join(' | ') || '（没有提交过）'}`);
  }
  if (afterRetry.errors) problems.push('点重试后旧的报错行没有收掉');
  if (afterRetry.actions) problems.push('点重试后按钮没有收掉');
  if (afterRetry.user !== rowsBefore.user + 1) {
    problems.push(`重试不该再插一条相同的提问：现在 ${afterRetry.user} 条`);
  }

  // 主进程重跑这次提问时，同一个问题不该在对话里出现第二遍
  win.webContents.send('answer:start', { question: RETRY_Q });
  await wait(200);
  const retryTurn = await run(`
    return {
      user: document.querySelectorAll('.row.is-user').length,
      typing: document.querySelectorAll('.row.is-ai .bubble.is-typing').length,
    };
  `);
  if (retryTurn.user !== rowsBefore.user + 1) {
    problems.push(`重试后的提问被重复插入：现在 ${retryTurn.user} 条`);
  }
  if (retryTurn.typing !== 1) problems.push('重试后没有出现新的回答气泡');

  // 8) 录音启动失败同样要给出重试（麦克风已被上面替换成必然拒绝的桩）
  await run(`
    document.querySelector('#sourceSwitch .seg[data-source="microphone"]').click();
    return 1;
  `);
  await wait(500);
  await run(`document.getElementById('recordBtn').click(); return 1;`);
  await wait(900);
  const recordFailed = await run(`
    const btn = document.querySelector('.retry-btn');
    return {
      errorText: [...document.querySelectorAll('.row .bubble.is-error')].map((n) => n.textContent).join(' '),
      retryCount: document.querySelectorAll('.retry-btn').length,
      retryLabel: btn ? btn.getAttribute('aria-label') : '',
    };
  `);
  if (!recordFailed.errorText.includes('麦克风')) problems.push(`录音失败没有说明原因：${recordFailed.errorText}`);
  if (recordFailed.retryCount !== 1) problems.push(`录音失败应恰有一个重试入口，实际 ${recordFailed.retryCount} 个`);
  if (recordFailed.retryLabel !== '重试') problems.push(`录音失败旁边的重试按钮没有可读名称：${recordFailed.retryLabel}`);

  // 界面保存过的字段必须都能被后端接受
  const coveredFields = new Set(savedPatches.flatMap((patch) => Object.keys(patch)));
  for (const field of ['answer.reasoningEffort', 'answer.maxChars', 'resume.contextMode', 'audio.source']) {
    if (!coveredFields.has(field)) problems.push(`设置面板没有提交 ${field}`);
  }

  // 结果
  report(coveredFields);
})
  .catch((err) => {
    problems.push(`自测脚本中断：${err.message}`);
    report();
  });

app.on('window-all-closed', () => app.exit(0));
