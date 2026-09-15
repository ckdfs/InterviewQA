'use strict';

/**
 * 自动更新。
 *
 * 三种工作方式，由「是否打包 + 平台 + 运行形态 + 签名类型」共同决定：
 *
 *   auto    下载完成后由应用自己替换并重启
 *           —— Windows 安装版（NSIS）、用 Developer ID 证书签名的 macOS 版
 *   notify  只提示有新版本，由使用者自己到发布页下载
 *           —— Windows 免安装版（自身是解压出来的单文件，替换不了）、
 *              未用 Developer ID 签名的 macOS 版（见下）
 *   off     源码模式不做任何检查
 *
 * macOS 为什么要求 Developer ID：electron-updater 在 macOS 上把 zip 交给系统自带的
 * Squirrel.Mac 安装，Squirrel 会校验下载包的签名是否满足**当前运行应用的指定要求**。
 * ad-hoc 签名的应用，指定要求就是它自己那份 cdhash，换一个构建必然对不上，
 * 更新会被直接拒绝。因此只有 Developer ID 签名才具备自动安装的条件，
 * 其余情况退回到「提示 + 打开下载页」，不去做注定失败的事。
 */

/** 打包后的免安装版会带上这个环境变量，指向自身那个 exe */
const PORTABLE_ENV = 'PORTABLE_EXECUTABLE_FILE';

const OWNER = 'ckdfs';
const REPO = 'InterviewQA';
const RELEASE_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;

/** 启动后先让界面稳定下来再检查，避免和首屏加载抢网络 */
const FIRST_CHECK_DELAY_MS = 15 * 1000;
/** 之后定期复查，长开的会话也能拿到新版本 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 从 `codesign -dv --verbose=4` 的输出判断签名类型。
 *
 * 三种输出形态：
 *   ad-hoc      只有 `Signature=adhoc`，没有任何 Authority
 *   开发者 ID   一连串 `Authority=Developer ID Application: …`
 *   开发证书    有 `Authority=` 但不是 Developer ID（Apple Development / 企业证书）
 *   未签名      `code object is not signed at all`，没有任何标记行
 */
function parseSigningKind(codesignOutput) {
  const text = String(codesignOutput || '');
  if (/^Signature=adhoc\s*$/m.test(text)) return 'adhoc';
  if (/Authority=Developer ID Application/.test(text)) return 'developer-id';
  if (/^Authority=/m.test(text)) return 'other';
  if (/^Signature=/m.test(text)) return 'other';
  return 'unsigned';
}

/** 判定更新方式，纯逻辑，便于自测 */
function decideMode({ isPackaged, platform, portable, signingKind }) {
  if (!isPackaged) return 'off';
  if (portable) return 'notify';
  if (platform === 'darwin' && signingKind !== 'developer-id') return 'notify';
  return 'auto';
}

function initialState(mode, currentVersion) {
  if (mode === 'off') {
    return {
      mode,
      status: 'off',
      currentVersion,
      latestVersion: '',
      percent: 0,
      message: '源码模式不检查更新',
    };
  }
  if (mode === 'notify') {
    return {
      mode,
      status: 'idle',
      currentVersion,
      latestVersion: '',
      percent: 0,
      message: '有新版本时提示，由你自行下载安装',
    };
  }
  return {
    mode,
    status: 'idle',
    currentVersion,
    latestVersion: '',
    percent: 0,
    message: '有新版本时自动下载，重启即可生效',
  };
}

/**
 * 把更新器事件映射成界面状态。纯函数，自测直接喂事件即可，
 * 不需要真的去连更新源。
 */
function reduceState(state, event) {
  const type = event && event.type;
  switch (type) {
    case 'checking':
      return { ...state, status: 'checking', percent: 0, message: '正在检查更新…' };

    case 'available':
      return {
        ...state,
        status: 'available',
        latestVersion: event.version || '',
        percent: 0,
        message: `发现新版本 ${event.version}`,
      };

    case 'current':
      return {
        ...state,
        status: 'current',
        latestVersion: '',
        percent: 0,
        message: `已是最新版本（${state.currentVersion}）`,
      };

    case 'progress':
      return {
        ...state,
        status: 'downloading',
        percent: Number(event.percent) || 0,
        message: `正在下载新版本 ${Math.round(Number(event.percent) || 0)}%`,
      };

    case 'downloaded':
      return {
        ...state,
        status: 'downloaded',
        latestVersion: event.version || state.latestVersion,
        percent: 100,
        message: `新版本 ${event.version || state.latestVersion} 已就绪，重启后生效`,
      };

    case 'installing':
      return { ...state, status: 'installing', message: '正在重启并安装…' };

    case 'error':
      return { ...state, status: 'error', message: event.message || '更新检查失败' };

    case 'reset':
      return { ...state, status: 'idle', percent: 0, message: event.message || '' };

    default:
      return state;
  }
}

/** 界面上的可操作项，由状态决定 */
function actionsFor(state, { canInstall } = {}) {
  const acts = [];
  if (state.mode === 'off') return acts;
  if (state.mode === 'notify') {
    if (state.status === 'available' && state.latestVersion) {
      acts.push({ id: 'open', label: '打开下载页' });
    }
    return acts;
  }
  if (state.status === 'checking' || state.status === 'downloading') return acts;
  if (state.status === 'downloaded') {
    acts.push({ id: 'install', label: '重启并安装' });
    return acts;
  }
  return acts;
}

/**
 * 运行时装配。依赖由外部注入，方便在自测里换成假的更新器，
 * 把「事件 → 状态 → 可用操作」这条链路完整跑一遍。
 */
function createUpdater({
  mode,
  currentVersion,
  updater,
  onState,
  canInstall = () => true,
  openPage = () => {},
  log = console,
}) {
  let state = initialState(mode, currentVersion);
  const listeners = [];
  let timer = null;

  const publish = () => {
    const snapshot = { ...state, actions: actionsFor(state, { canInstall }) };
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        log.warn(`[更新] 状态订阅者抛错：${err && err.message}`);
      }
    }
    if (onState) onState(snapshot);
    return snapshot;
  };

  const apply = (event) => {
    state = reduceState(state, event);
    return publish();
  };

  if (mode === 'off') {
    publish();
    return {
      getState: () => ({ ...state, actions: actionsFor(state, { canInstall }) }),
      subscribe(listener) {
        listeners.push(listener);
        return () => {
          const i = listeners.indexOf(listener);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      check: async () => ({ skipped: true, message: '源码模式不检查更新' }),
      install: () => false,
      openDownloadPage: () => false,
      start() {},
      stop() {},
    };
  }

  // 未签名的 macOS 版与免安装版只做提示，不去下载注定装不上的包
  updater.autoDownload = mode === 'auto';
  updater.autoInstallOnAppQuit = false;

  updater.on('checking-for-update', () => apply({ type: 'checking' }));

  updater.on('update-available', (info) =>
    apply({ type: 'available', version: (info && info.version) || '' })
  );

  updater.on('update-not-available', () => apply({ type: 'current' }));

  updater.on('download-progress', (progress) =>
    apply({ type: 'progress', percent: progress && progress.percent })
  );

  updater.on('update-downloaded', (info) => {
    if (mode !== 'auto') return;
    apply({ type: 'downloaded', version: (info && info.version) || '' });
  });

  updater.on('error', (err) => {
    const message = (err && err.message) || String(err || '未知错误');
    log.warn(`[更新] ${message}`);
    apply({ type: 'error', message });
  });

  const check = async () => {
    if (mode === 'notify') {
      // 提示模式下不需要下载，但要让 updater 相信自己已经是最新的，
      // 否则它会在后台把包下完再报错
      updater.autoDownload = false;
    }
    apply({ type: 'checking' });
    try {
      const result = await updater.checkForUpdates();
      if (!result) {
        // 源码模式或暂不支持时会返回 null，别让界面卡在“检查中”
        apply({ type: 'reset', message: '暂时无法检查更新' });
        return { ok: false, message: '暂时无法检查更新' };
      }
      return { ok: true };
    } catch (err) {
      const message = (err && err.message) || String(err || '检查更新失败');
      apply({ type: 'error', message });
      return { ok: false, message };
    }
  };

  const install = () => {
    if (mode !== 'auto') return false;
    if (state.status !== 'downloaded') return false;
    if (!canInstall()) {
      apply({ type: 'reset', message: '正在录制，结束后再安装更新' });
      return false;
    }
    apply({ type: 'installing' });
    // 交给 Squirrel / NSIS 接管，进程会在这里退出
    setImmediate(() => {
      try {
        updater.quitAndInstall(false, true);
      } catch (err) {
        apply({ type: 'error', message: (err && err.message) || '安装更新失败' });
      }
    });
    return true;
  };

  const openDownloadPage = () => {
    try {
      openPage(RELEASE_PAGE);
      return true;
    } catch (err) {
      log.warn(`[更新] 打开下载页失败：${err && err.message}`);
      return false;
    }
  };

  const start = () => {
    stop();
    timer = setTimeout(() => {
      check();
      timer = setInterval(check, CHECK_INTERVAL_MS);
    }, FIRST_CHECK_DELAY_MS);
    if (timer.unref) timer.unref();
  };

  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      clearInterval(timer);
      timer = null;
    }
  };

  publish();

  return {
    getState: () => ({ ...state, actions: actionsFor(state, { canInstall }) }),
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    check,
    install,
    openDownloadPage,
    start,
    stop,
  };
}

module.exports = {
  PORTABLE_ENV,
  RELEASE_PAGE,
  FIRST_CHECK_DELAY_MS,
  CHECK_INTERVAL_MS,
  parseSigningKind,
  decideMode,
  initialState,
  reduceState,
  actionsFor,
  createUpdater,
};
