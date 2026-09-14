/**
 * 本地 Whisper 自检脚本的启动包装。
 * Windows 的虚拟环境在 .venv/Scripts/python.exe，macOS / Linux 在 .venv/bin/python3，
 * 这里统一探测，避免把平台相关的路径写死在 npm script 里。
 *
 * 用法：npm run test:stt
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const candidates =
  process.platform === 'win32'
    ? [path.join(root, '.venv', 'Scripts', 'python.exe')]
    : [path.join(root, '.venv', 'bin', 'python3'), path.join(root, '.venv', 'bin', 'python')];

const python = candidates.find((file) => fs.existsSync(file));
if (!python) {
  console.error(
    [
      '未找到项目内的 Python 虚拟环境，本地 Whisper 自检无法运行。',
      '',
      '先在项目目录创建虚拟环境并安装依赖：',
      process.platform === 'win32'
        ? '  python -m venv .venv && .venv\\Scripts\\pip install -r stt\\requirements.txt'
        : '  python3 -m venv .venv && .venv/bin/pip install -r stt/requirements.txt',
    ].join('\n')
  );
  process.exit(1);
}

const result = spawnSync(python, [path.join(root, 'stt', 'test_transcribe.py')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', HF_ENDPOINT: 'https://hf-mirror.com' },
});
process.exit(result.status === null ? 1 : result.status);
