/**
 * 启动器：确保以 GUI 模式拉起 Electron。
 * 某些终端环境（例如集成终端）会带 ELECTRON_RUN_AS_NODE=1，
 * 这会让 electron 以纯 Node 方式运行，导致找不到 app 等 API。
 */
const { spawn } = require('child_process');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronPath = require('electron'); // node 模式下返回 electron 可执行文件路径

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  cwd: __dirname,
  env,
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code === null ? 1 : code));
