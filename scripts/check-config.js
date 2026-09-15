/**
 * 配置层自测。
 *
 * 重点守住一条：**环境变量只作用于本次运行，不能落盘**。
 * 曾经的实现把环境变量合并进内存配置后整份写回磁盘，于是任何一次保存
 * （哪怕只是记一下「引导已走完」）都会把环境变量里的 Key 写进 config.json，
 * 静默顶掉用户原先填在里面的 Key。这类损失没有任何提示，只能靠断言挡住。
 *
 * 用法：npm run test:config
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ConfigStore, DEFAULT_CONFIG, EDITABLE } = require('../config.js');

const failures = [];

function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok && detail) console.log(`    ${detail}`);
  if (!ok) failures.push(name);
}

/** 每轮用独立的临时目录，避免相互影响，也避免碰到真实配置 */
let seq = 0;
function makeStore(initial) {
  seq++;
  const dir = path.join(os.tmpdir(), `interviewqa-config-check-${process.pid}-${seq}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (initial) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(initial, null, 2), 'utf8');
  return { store: new ConfigStore({ appRoot: dir, userDir: dir, isPackaged: false }), dir, file: path.join(dir, 'config.json') };
}

function readFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function withEnv(env, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------- 增量式与白名单

{
  const { store } = makeStore({ answer: { maxChars: 260 } });
  check('磁盘上只写几个字段也能启动', store.get().answer.maxChars === 260,
    `实际 ${store.get().answer.maxChars}`);
  check('缺的字段由默认值补齐', store.get().audio.source === 'system');
}

{
  const { store } = makeStore({});
  const bad = store.update({ 'answer.notEditable': 1 });
  check('白名单外的字段被拒绝', bad.ok === false);
  const out = store.update({ 'answer.maxChars': 9999 });
  check('超范围的取值被拒绝', out.ok === false && /不能大于/.test(out.message || ''));
}

// ---------------------------------------------------------------- 环境变量不落盘

{
  const ENV_KEY = 'sk-env-injected-key-0123456789';
  const DISK_KEY = 'sk-user-key-on-disk-9876543210';
  const { store, file } = makeStore({ deepseekApiKey: DISK_KEY });

  withEnv({ DEEPSEEK_API_KEY: ENV_KEY, MIMO_API_KEY: undefined }, () => {
    const fresh = new ConfigStore({ appRoot: path.dirname(file), userDir: path.dirname(file), isPackaged: false });
    check('环境变量在本次运行内生效', fresh.get().deepseekApiKey === ENV_KEY);

    // 记一下引导已走完——真实场景里这一步就会触发写盘
    fresh.markSetupDone();
    check('环境变量没有被写进 config.json', readFile(file).deepseekApiKey === DISK_KEY,
      `磁盘上现在是 ${readFile(file).deepseekApiKey.slice(-4)}，应为用户填的 ${DISK_KEY.slice(-4)}`);
    check('同一次写盘里的其他字段照常落盘', readFile(file).ui.setupDone === true);
    check('环境变量仍对后续读取生效', fresh.get().deepseekApiKey === ENV_KEY);
  });
}

{
  // 磁盘上本来没有这个字段时，环境变量也不该把它凭空造出来
  const { store, file } = makeStore({ 'answer.maxChars': 200 });
  withEnv({ DEEPSEEK_API_KEY: 'sk-env-only-key-0123456789', MIMO_API_KEY: undefined }, () => {
    const fresh = new ConfigStore({ appRoot: path.dirname(file), userDir: path.dirname(file), isPackaged: false });
    check('未配置过的 Key 可由环境变量提供', fresh.hasDeepSeekKey());
    fresh.markSetupDone();
    check('环境变量提供的 Key 不会凭空出现在磁盘上', readFile(file).deepseekApiKey === undefined);
  });
}

{
  // 用户在设置里显式填的 Key 必须能落盘，不能被环境变量还原成旧值
  const { store, file } = makeStore({ deepseekApiKey: 'sk-old-on-disk-0000000000' });
  withEnv({ DEEPSEEK_API_KEY: 'sk-env-injected-key-0123456789', MIMO_API_KEY: undefined }, () => {
    const fresh = new ConfigStore({ appRoot: path.dirname(file), userDir: path.dirname(file), isPackaged: false });
    const saved = fresh.update({ deepseekApiKey: 'sk-typed-in-settings-1111111111' });
    check('设置里保存的 Key 能被接受', saved.ok === true);
    check('用户显式填的 Key 会落盘', readFile(file).deepseekApiKey === 'sk-typed-in-settings-1111111111',
      `磁盘上现在是 ${readFile(file).deepseekApiKey.slice(-4)}`);
    check('保存后内存里也是用户填的值', fresh.get().deepseekApiKey === 'sk-typed-in-settings-1111111111');
  });
}

{
  // 环境变量同时给出两把 Key 时，两条都要按同一规则处理
  const { file } = makeStore({ deepseekApiKey: 'sk-old-on-disk-0000000000' });
  withEnv({ DEEPSEEK_API_KEY: 'sk-env-deepseek-0123456789', MIMO_API_KEY: 'sk-env-mimo-0123456789' }, () => {
    const fresh = new ConfigStore({ appRoot: path.dirname(file), userDir: path.dirname(file), isPackaged: false });
    check('MiMo 的环境变量同样在运行内生效', fresh.get().stt.mimo.apiKey === 'sk-env-mimo-0123456789');
    fresh.markSetupDone();
    const disk = readFile(file);
    check('磁盘上没有留下任何环境变量里的 Key',
      disk.deepseekApiKey === 'sk-old-on-disk-0000000000' && disk.stt.mimo.apiKey === undefined,
      JSON.stringify({ deepseek: (disk.deepseekApiKey || '').slice(-4), mimo: (disk.stt.mimo.apiKey || '无').slice(-4) }));
  });
}

// ---------------------------------------------------------------- 写盘内容自洽

{
  // 写盘写的是合并后的完整骨架：手写进去的未知段会被丢掉，而不是被原样带回
  const { store, file } = makeStore({ answer: { maxChars: 260 }, unknownSection: { keep: 1 } });
  check('读盘时未知段被忽略', store.get().unknownSection === undefined);

  store.update({ 'audio.source': 'microphone' });
  const disk = readFile(file);
  check('写盘后未知段不会残留', disk.unknownSection === undefined);
  check('改过的字段真的写进去了', disk.audio.source === 'microphone');
  check(
    '写盘内容的顶层字段与默认骨架一致',
    JSON.stringify(Object.keys(disk).sort()) === JSON.stringify(Object.keys(DEFAULT_CONFIG).sort()),
    `实际 ${Object.keys(disk).sort().join(',')}`
  );
  check('写盘内容以换行收尾', fs.readFileSync(file, 'utf8').endsWith('\n'));
  check('EDITABLE 覆盖了音源字段', Boolean(EDITABLE['audio.source']));
}

if (failures.length) {
  console.error(`\n配置层自测未通过，${failures.length} 条不符`);
  process.exit(1);
}
console.log('\n配置层自测通过：增量式合并、白名单校验、环境变量只在运行期生效且从不落盘');
