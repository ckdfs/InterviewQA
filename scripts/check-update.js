/**
 * 自动更新自测。
 *
 * 更新这条链路里真正会出错的是判定与状态迁移：什么情况下允许应用自我替换、
 * 事件到达后界面该显示什么、什么时候才能点「重启并安装」。这些都不需要联网，
 * 全部是纯逻辑，因此把它们固化成用例，改动时能立刻发现踩到了哪一条。
 *
 * 签名那一段用的是真实 `codesign -dv --verbose=4` 的输出，ad-hoc 那份就是从
 * 本项目的打包产物上取下来的。
 *
 * 用法：npm run test:update
 */
const { EventEmitter } = require('events');
const {
  parseSigningKind,
  decideMode,
  initialState,
  reduceState,
  actionsFor,
  createUpdater,
  RELEASE_PAGE,
} = require('../update');

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) {
    if (detail) console.log(`    ${detail}`);
    failures.push(name);
  }
}

// ---------------------------------------------------------------- 签名判定

const ADHOC_OUTPUT = `Executable=/Users/xinkezhang/Desktop/InterviewQA/dist/mac-arm64/InterviewQA.app/Contents/MacOS/InterviewQA
Identifier=com.interviewqa.desktop
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=304 flags=0x2(adhoc) hashes=3+3 location=embedded
Hash type=sha256 size=32
CDHash=b2c271600a8a1c435598795cfa01a8b2efc32ed7
Signature=adhoc
Info.plist entries=32`;

const DEVELOPER_ID_OUTPUT = `Executable=/Applications/InterviewQA.app/Contents/MacOS/InterviewQA
Identifier=com.interviewqa.desktop
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20500 size=1599 flags=0x10000(runtime) hashes=41+7 location=embedded
Authority=Developer ID Application: Example Technology (Shenzhen) Co., Ltd. (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Sep 15, 2026 at 12:05:00
Signature size=9042`;

const APPLE_DEVELOPMENT_OUTPUT = `Executable=/Users/x/Library/Developer/Xcode/DerivedData/InterviewQA.app/Contents/MacOS/InterviewQA
Identifier=com.interviewqa.desktop
Authority=Apple Development: Dev Name (TEAM123456)
Authority=Apple Worldwide Developer Relations Certification Authority
Signature size=4800`;

const UNSIGNED_OUTPUT = `code object is not signed at all
In subcomponent: /Applications/InterviewQA.app/Contents/MacOS/InterviewQA`;

check('真实 ad-hoc 产物被识别为 adhoc', parseSigningKind(ADHOC_OUTPUT) === 'adhoc', `得到 ${parseSigningKind(ADHOC_OUTPUT)}`);
check('带 Developer ID 证书被识别', parseSigningKind(DEVELOPER_ID_OUTPUT) === 'developer-id', `得到 ${parseSigningKind(DEVELOPER_ID_OUTPUT)}`);
check('Apple 开发证书不算可分发签名', parseSigningKind(APPLE_DEVELOPMENT_OUTPUT) === 'other', `得到 ${parseSigningKind(APPLE_DEVELOPMENT_OUTPUT)}`);
check('完全未签名被识别', parseSigningKind(UNSIGNED_OUTPUT) === 'unsigned', `得到 ${parseSigningKind(UNSIGNED_OUTPUT)}`);

// ---------------------------------------------------------------- 更新方式判定

const MODE_CASES = [
  { name: '源码模式不做检查', in: { isPackaged: false, platform: 'darwin', portable: false, signingKind: 'developer-id' }, want: 'off' },
  { name: 'Windows 安装版可以自我替换', in: { isPackaged: true, platform: 'win32', portable: false, signingKind: 'n/a' }, want: 'auto' },
  { name: 'Windows 免安装版只能提示', in: { isPackaged: true, platform: 'win32', portable: true, signingKind: 'n/a' }, want: 'notify' },
  { name: 'macOS 已用开发者 ID 签名可以自我替换', in: { isPackaged: true, platform: 'darwin', portable: false, signingKind: 'developer-id' }, want: 'auto' },
  { name: 'macOS ad-hoc 签名只能提示', in: { isPackaged: true, platform: 'darwin', portable: false, signingKind: 'adhoc' }, want: 'notify' },
  { name: 'macOS 未签名只能提示', in: { isPackaged: true, platform: 'darwin', portable: false, signingKind: 'unsigned' }, want: 'notify' },
];

for (const item of MODE_CASES) {
  const got = decideMode(item.in);
  check(item.name, got === item.want, `期望 ${item.want}，实际 ${got}`);
}

// ---------------------------------------------------------------- 状态迁移

let state = initialState('auto', '1.2.0');
check('初始状态为待检查', state.status === 'idle' && state.currentVersion === '1.2.0');

state = reduceState(state, { type: 'checking' });
check('检查中', state.status === 'checking');

state = reduceState(state, { type: 'available', version: '1.3.0' });
check('发现新版本记录版本号', state.status === 'available' && state.latestVersion === '1.3.0');

state = reduceState(state, { type: 'progress', percent: 42.6 });
check('下载进度四舍五入到状态里', state.status === 'downloading' && state.percent === 42.6 && state.message.includes('43%'), state.message);

state = reduceState(state, { type: 'downloaded', version: '1.3.0' });
check('下载完成标记为可安装', state.status === 'downloaded' && state.percent === 100);

state = reduceState(state, { type: 'error', message: '连接超时' });
check('错误状态带出原因', state.status === 'error' && state.message === '连接超时');

state = reduceState(state, { type: 'current' });
check('已是最新时清掉待更新版本', state.status === 'current' && state.latestVersion === '');

check('未知事件不改变状态', reduceState(state, { type: 'nonsense' }) === state);

// ---------------------------------------------------------------- 可操作项

const downloadedAuto = { mode: 'auto', status: 'downloaded', latestVersion: '1.3.0' };
check('下载完成后提供重启安装', actionsFor(downloadedAuto)[0]?.id === 'install');

const availableNotify = { mode: 'notify', status: 'available', latestVersion: '1.3.0' };
check('提示模式提供打开下载页', actionsFor(availableNotify)[0]?.id === 'open');

check('检查过程中不提供动作', actionsFor({ mode: 'auto', status: 'checking' }).length === 0);
check('提示模式下永不提供安装动作', actionsFor({ mode: 'notify', status: 'downloaded' }).every((a) => a.id !== 'install'));
check('源码模式没有任何动作', actionsFor({ mode: 'off', status: 'idle' }).length === 0);

// ---------------------------------------------------------------- 运行时装配

function fakeUpdater() {
  const emitter = new EventEmitter();
  emitter.autoDownload = null;
  emitter.autoInstallOnAppQuit = null;
  emitter.checkCalls = 0;
  emitter.installCalls = 0;
  emitter.failWith = null;
  emitter.checkForUpdates = async () => {
    emitter.checkCalls += 1;
    if (emitter.failWith) throw new Error(emitter.failWith);
    return { updateInfo: { version: '1.3.0' } };
  };
  emitter.quitAndInstall = () => {
    emitter.installCalls += 1;
  };
  return emitter;
}

(async () => {
  // 可自动安装的模式：事件推着状态走，最后能装上
  {
    const updater = fakeUpdater();
    let recording = false;
    const opened = [];
    const seen = [];
    const app = createUpdater({
      mode: 'auto',
      currentVersion: '1.2.0',
      updater,
      onState: (s) => seen.push(s.status),
      canInstall: () => !recording,
      openPage: (url) => opened.push(url),
    });

    check('可自动安装时开启自动下载', updater.autoDownload === true);
    check('不在退出时静默安装', updater.autoInstallOnAppQuit === false);

    await app.check();
    check('检查更新调用到底层', updater.checkCalls === 1);

    updater.emit('update-available', { version: '1.3.0' });
    check('新版本写进状态', app.getState().status === 'available' && app.getState().latestVersion === '1.3.0');

    updater.emit('download-progress', { percent: 12.5 });
    check('下载中不提供安装动作', app.getState().actions.length === 0);

    updater.emit('update-downloaded', { version: '1.3.0' });
    check('下载完成后出现安装动作', app.getState().actions[0]?.id === 'install');
    check('状态变化被推送给订阅者', seen.includes('downloaded'), seen.join(' → '));

    // 录制中不允许重启
    recording = true;
    const blocked = app.install();
    check('录制中拒绝安装', blocked === false && updater.installCalls === 0);
    check('录制中给出解释', app.getState().message.includes('录制'), app.getState().message);

    recording = false;
    updater.emit('update-downloaded', { version: '1.3.0' });
    const ok = app.install();
    check('空闲时安装被接受', ok === true);
    await new Promise((resolve) => setImmediate(resolve));
    check('安装交给底层更新器执行', updater.installCalls === 1);

    app.stop();
  }

  // 提示模式：只检查，绝不下载也绝不安装
  {
    const updater = fakeUpdater();
    const opened = [];
    const app = createUpdater({
      mode: 'notify',
      currentVersion: '1.2.0',
      updater,
      openPage: (url) => opened.push(url),
    });

    check('提示模式关闭自动下载', updater.autoDownload === false);

    await app.check();
    updater.emit('update-available', { version: '1.3.0' });
    check('提示模式发现新版本', app.getState().status === 'available');

    updater.emit('update-downloaded', { version: '1.3.0' });
    check('提示模式下不进入可安装状态', app.getState().status === 'available', app.getState().status);
    check('提示模式拒绝安装', app.install() === false && updater.installCalls === 0);

    app.openDownloadPage();
    check('打开下载页走到发布页', opened[0] === RELEASE_PAGE, opened.join(','));

    app.stop();
  }

  // 源码模式：不碰更新器
  {
    const app = createUpdater({ mode: 'off', currentVersion: '1.2.0', updater: null });
    const result = await app.check();
    check('源码模式跳过检查', result.skipped === true && app.getState().mode === 'off');
    check('源码模式不提供任何动作', app.getState().actions.length === 0);
    app.install();
    app.openDownloadPage();
    app.start();
    app.stop();
  }

  // 网络失败不能把界面卡在「检查中」
  {
    const updater = fakeUpdater();
    updater.failWith = 'net::ERR_INTERNET_DISCONNECTED';
    const app = createUpdater({ mode: 'auto', currentVersion: '1.2.0', updater });
    const result = await app.check();
    check('检查失败返回原因', result.ok === false && result.message.includes('ERR_INTERNET_DISCONNECTED'));
    check('检查失败落到错误状态', app.getState().status === 'error');
    app.stop();
  }

  // checkForUpdates 返回空值时也不能卡住
  {
    const updater = fakeUpdater();
    updater.checkForUpdates = async () => null;
    const app = createUpdater({ mode: 'auto', currentVersion: '1.2.0', updater });
    await app.check();
    check('拿不到更新信息时回到待机', app.getState().status === 'idle', app.getState().status);
    app.stop();
  }

  if (failures.length) {
    console.error(`\n自动更新自测未通过，${failures.length} 条不符`);
    process.exit(1);
  }
  console.log('\n自动更新自测通过：签名判定、更新方式、状态迁移与安装条件全部符合预期');
})();
