/**
 * Electron 启动器：所有拉起 Electron 的地方都走这里，避免各自处理环境差异。
 *
 * 背景：部分终端环境会带 ELECTRON_RUN_AS_NODE=1，此时 electron 以纯 Node 方式运行，
 * require('electron') 返回可执行文件路径而不是 API 对象，主进程脚本会以
 * “Cannot read properties of undefined” 之类的形式失败。启动前清掉该变量即可。
 *
 * 用法：
 *   node scripts/launch.js --app [给应用的参数...]      以应用入口启动（electron .）
 *   node scripts/launch.js --script <文件> [参数...]     以指定脚本启动（electron <文件>）
 *
 * 需要临时放宽 Chromium 开关（例如无头环境跑界面测试）时，用 -- 分隔后追加开关：
 *   node scripts/launch.js --script scripts/ui-check.js -- --no-sandbox
 */
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const rawArgv = process.argv.slice(2);

// -- 之后的参数原样交给 Electron 作为命令行开关
const splitAt = rawArgv.indexOf('--');
const argv = splitAt === -1 ? rawArgv : rawArgv.slice(0, splitAt);
const electronFlags = splitAt === -1 ? [] : rawArgv.slice(splitAt + 1);

const mode = argv[0];
const rest = argv.slice(1);

let target;
if (mode === '--script') {
  if (!rest[0]) {
    console.error('用法：node scripts/launch.js --script <文件> [参数...]');
    process.exit(2);
  }
  target = rest;
} else if (mode === '--app' || mode === undefined) {
  target = ['.', ...rest];
} else {
  console.error(`未知参数：${mode}（可选 --app / --script）`);
  process.exit(2);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Node 模式下 require('electron') 返回值就是可执行文件路径，正是这里需要的形态
const electronPath = require('electron');

const child = spawn(electronPath, [...electronFlags, ...target], { cwd: ROOT, env, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code === null ? 1 : code));
