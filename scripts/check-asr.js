/**
 * 语音识别层自测。
 *
 * 这一层有两处容易出错的地方：
 *   1. 送出去的音频是不是合法的 WAV——静音探测音频完全由代码生成，
 *      头写错会被服务端判成格式错误，而这类失败在界面上只会显示「转写失败」；
 *   2. HTTP 结果到用户结论的映射——401 / 404 / 429 各自该说什么话，
 *      直接决定用户能不能自己把问题修好。
 *
 * 两处都是纯逻辑，不需要联网也不需要 Key，因此全部固化成用例。
 * 请求用注入的假发送函数模拟，真实网络路径不在这里跑。
 *
 * 用法：npm run test:asr
 */
const {
  SAMPLE_RATE,
  BYTES_PER_SAMPLE,
  PROBE_SECONDS,
  pcmToWav,
  silentWav,
  rms,
  extractText,
  extractError,
  classifyMimo,
  transcribe,
  probeMimo,
} = require('../asr');

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) {
    if (detail !== undefined) console.log(`    ${detail}`);
    failures.push(name);
  }
}

/** 假发送：按预设回一条响应，同时记录收到的请求，便于断言请求内容 */
function fakeSend(reply) {
  const send = async (target) => {
    send.calls = send.calls || [];
    send.calls.push(target);
    if (typeof reply === 'function') return reply(target);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return send;
}

function okResponse(text) {
  return { statusCode: 200, body: JSON.stringify({ choices: [{ message: { content: text } }] }) };
}

const MIMO_CFG = {
  apiKey: 'sk-test-key',
  baseUrl: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.5-asr',
  language: 'zh',
  timeoutMs: 30000,
};

(async () => {
  // ---------------------------------------------------------------- WAV 封装

  {
    const wav = silentWav();
    check('静音音频是 RIFF/WAVE 容器', wav.subarray(0, 4).toString() === 'RIFF' && wav.subarray(8, 12).toString() === 'WAVE');
    check('静音音频带 fmt 与 data 块', wav.subarray(12, 16).toString() === 'fmt ' && wav.subarray(36, 40).toString() === 'data');
    check('PCM 单声道 16bit', wav.readUInt16LE(20) === 1 && wav.readUInt16LE(22) === 1 && wav.readUInt16LE(34) === 16);
    check('采样率写入正确', wav.readUInt32LE(24) === SAMPLE_RATE, wav.readUInt32LE(24));
    check('字节率与块对齐自洽', wav.readUInt32LE(28) === SAMPLE_RATE * BYTES_PER_SAMPLE && wav.readUInt16LE(32) === BYTES_PER_SAMPLE);
    const dataLength = wav.readUInt32LE(40);
    check('data 长度等于采样数乘字节宽', dataLength === Math.round(PROBE_SECONDS * SAMPLE_RATE) * BYTES_PER_SAMPLE, dataLength);
    check('RIFF 长度字段自洽', wav.readUInt32LE(4) === dataLength + 36);
    check('总长度等于头加数据', wav.length === 44 + dataLength, wav.length);
  }

  {
    // 空音频也要产出合法文件，否则极端情况下会送出一个服务端无法解析的包
    const empty = pcmToWav(Buffer.alloc(0));
    check('空音频仍是合法 WAV', empty.length === 44 && empty.readUInt32LE(40) === 0);
    const one = silentWav(1 / SAMPLE_RATE);
    check('不足一个采样点时按一个采样点处理', one.readUInt32LE(40) === BYTES_PER_SAMPLE);
  }

  {
    const wav = silentWav(0.5);
    check('静音音频自身的电平为零', rms(wav.subarray(44)) === 0);
  }

  // ---------------------------------------------------------------- 均方根

  {
    check('空缓冲的均方根为零', rms(Buffer.alloc(0)) === 0);
    const loud = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) loud.writeInt16LE(-32768, i * 2); // 满幅方波
    check('满幅信号得到 1', Math.abs(rms(loud) - 1) < 1e-3, rms(loud));
    const half = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) half.writeInt16LE(16384, i * 2);
    check('半幅信号得到 0.5', Math.abs(rms(half) - 0.5) < 1e-3, rms(half));
    check('半幅信号小于满幅', rms(half) < rms(loud));
    check('负满幅读作 -1 的幅度', Math.abs(rms(Buffer.from([0x00, 0x80])) - 1) < 1e-6);
    check('正满幅读作接近 1 的幅度', Math.abs(rms(Buffer.from([0xff, 0x7f])) - 1) < 1e-4);
    check('单声道 16bit 的读数不超过 1', rms(Buffer.from([0xff, 0x7f, 0x00, 0x80])) <= 1);
  }

  // ---------------------------------------------------------------- 响应解析

  {
    check('解析 message.content', extractText(JSON.stringify({ choices: [{ message: { content: '你好' } }] })) === '你好');
    check('解析 delta.content', extractText(JSON.stringify({ choices: [{ delta: { content: '片段' } }] })) === '片段');
    check(
      '解析分段式内容',
      extractText(JSON.stringify({ choices: [{ message: { content: [{ text: '前' }, '后'] } }] })) === '前后'
    );
    check('取不到内容时返回空串', extractText(JSON.stringify({ choices: [{ message: {} }] })) === '');
    check('缺少 choices 视为无法解析', extractText(JSON.stringify({ id: 'x' })) === null);
    check('非 JSON 视为无法解析', extractText('<html>502</html>') === null);
    check('空响应视为无法解析', extractText('') === null);
  }

  {
    check('识别字符串形式的 error', extractError(JSON.stringify({ error: '额度不足' })) === '额度不足');
    check('识别对象形式的 error', extractError(JSON.stringify({ error: { message: '模型不存在' } })) === '模型不存在');
    check('没有 error 时返回 null', extractError(JSON.stringify({ choices: [] })) === null);
    check('非 JSON 不误报 error', extractError('not json') === null);
  }

  // ---------------------------------------------------------------- 结论归类

  {
    const ok = classifyMimo(200, JSON.stringify({ choices: [{ message: { content: '你好世界' } }] }), MIMO_CFG);
    check('200 判为可用', ok.ok === true && ok.reason === 'ok', JSON.stringify(ok));
    check('可用结论里带上识别字数', ok.message.includes('4 字'), ok.message);
    check('可用结论里带上接口与模型', ok.message.includes('api.xiaomimimo.com') && ok.message.includes('mimo-v2.5-asr'));

    const silent = classifyMimo(200, JSON.stringify({ choices: [{ message: { content: '' } }] }), MIMO_CFG);
    check('静音识别出空文本仍算可用', silent.ok === true);

    const upstream = classifyMimo(200, JSON.stringify({ error: { message: '触发内容审核' } }), MIMO_CFG);
    check('200 里夹带 error 判为失败', upstream.ok === false && upstream.message.includes('触发内容审核'));

    const broken = classifyMimo(200, 'garbage', MIMO_CFG);
    check('200 但响应无法解析判为失败', broken.ok === false && broken.reason === 'bad-response');
  }

  {
    const cases = [
      [401, 'unauthorized', 'API Key 无效'],
      [403, 'forbidden', '拒绝'],
      [404, 'not-found', '接口地址或模型名不对'],
      [429, 'rate-limit', '过于频繁'],
      [500, 'server', '服务端出错'],
    ];
    for (const [status, reason, keyword] of cases) {
      const result = classifyMimo(status, '{}', MIMO_CFG);
      check(`HTTP ${status} 归为 ${reason}`, result.ok === false && result.reason === reason, JSON.stringify(result));
      check(`HTTP ${status} 的说明包含「${keyword}」`, result.message.includes(keyword), result.message);
    }
    const teapot = classifyMimo(418, 'I am a teapot', MIMO_CFG);
    check('未列举的状态码带出响应片段', teapot.ok === false && teapot.message.includes('I am a teapot'));
  }

  // ---------------------------------------------------------------- 转写请求

  {
    const send = fakeSend(okResponse('这是识别结果'));
    const text = await transcribe(MIMO_CFG, silentWav(), { send });
    check('转写返回识别文本', text === '这是识别结果', text);

    const call = send.calls[0];
    check('请求打到 chat/completions', call.url === 'https://api.xiaomimimo.com/v1/chat/completions', call.url);
    check('接口地址末尾的斜杠被去掉', (await (async () => {
      const s = fakeSend(okResponse('x'));
      await transcribe({ ...MIMO_CFG, baseUrl: 'https://api.xiaomimimo.com/v1///' }, silentWav(), { send: s });
      return s.calls[0].url;
    })()) === 'https://api.xiaomimimo.com/v1/chat/completions');

    check('请求带上 api-key 头', call.headers['api-key'] === 'sk-test-key');
    check('请求是 JSON', call.headers['Content-Type'] === 'application/json');

    const body = JSON.parse(call.body);
    check('请求模型取自配置', body.model === 'mimo-v2.5-asr');
    check('语种取自配置', body.asr_options.language === 'zh');
    check('音频以 data URL 形式内联', /^data:audio\/wav;base64,[A-Za-z0-9+/=]+$/.test(body.messages[0].content[0].input_audio.data));
    check('内联音频是合法 WAV', Buffer.from(body.messages[0].content[0].input_audio.data.split(',')[1], 'base64').subarray(0, 4).toString() === 'RIFF');
    check('超时取自配置', call.timeoutMs === 30000);
  }

  {
    const send = fakeSend({ statusCode: 401, body: '{"error":"bad key"}' });
    let caught = null;
    try {
      await transcribe(MIMO_CFG, silentWav(), { send });
    } catch (err) {
      caught = err;
    }
    check('4xx 抛出异常', !!caught);
    check('异常带上归类结论', !!caught.verdict && caught.verdict.reason === 'unauthorized');
    check('异常信息可直接展示', caught.message.includes('API Key 无效'), caught.message);
  }

  {
    const send = fakeSend({ statusCode: 200, body: JSON.stringify({ error: { message: '模型未开通' } }) });
    let caught = null;
    try {
      await transcribe(MIMO_CFG, silentWav(), { send });
    } catch (err) {
      caught = err;
    }
    check('200 夹带 error 时抛异常', !!caught && caught.message.includes('模型未开通'), caught && caught.message);
  }

  {
    let caught = null;
    try {
      await transcribe({ ...MIMO_CFG, baseUrl: '' }, silentWav(), { send: fakeSend(okResponse('x')) });
    } catch (err) {
      caught = err;
    }
    check('缺少接口地址时直接报错', !!caught && caught.message.includes('接口地址'), caught && caught.message);
  }

  // ---------------------------------------------------------------- 探测

  {
    const send = fakeSend(okResponse(''));
    const result = await probeMimo(MIMO_CFG, { send });
    check('探测成功返回可用', result.ok === true && result.reason === 'ok', JSON.stringify(result));
    check('探测结论说明转写可用', result.message.includes('连接与转写可用'), result.message);
    check('探测只发一次请求', send.calls.length === 1, send.calls.length);
    check('探测用的是静音音频', JSON.parse(send.calls[0].body).messages[0].content[0].input_audio.data.length > 100);
  }

  {
    const result = await probeMimo({ ...MIMO_CFG, apiKey: '' });
    check('未填 Key 时不发请求', result.ok === false && result.reason === 'no-key', JSON.stringify(result));
    check('未填 Key 的说明指向 Key', result.message.includes('MiMo API Key'));
  }

  {
    const result = await probeMimo({ ...MIMO_CFG, model: '' });
    check('未填模型名时不发请求', result.ok === false && result.reason === 'no-model', JSON.stringify(result));
  }

  {
    const send = fakeSend(new Error('getaddrinfo ENOTFOUND api.xiaomimimo.com'));
    const result = await probeMimo(MIMO_CFG, { send });
    check('网络不通归为 network', result.ok === false && result.reason === 'network', JSON.stringify(result));
    check('网络不通的说明带上底层原因', result.message.includes('ENOTFOUND'), result.message);
  }

  {
    const send = fakeSend(new Error('请求超时'));
    const result = await probeMimo(MIMO_CFG, { send });
    check('超时归为 network', result.ok === false && result.reason === 'network', JSON.stringify(result));
    check('超时的说明写明无法连接', result.message.includes('无法连接 MiMo'));
  }

  {
    const send = fakeSend({ statusCode: 404, body: 'not found' });
    const result = await probeMimo(MIMO_CFG, { send });
    check('探测把 404 透传成可读结论', result.ok === false && result.reason === 'not-found', JSON.stringify(result));
    check('404 结论里带上模型名', result.message.includes('mimo-v2.5-asr'), result.message);
  }

  {
    const send = fakeSend({ statusCode: 500, body: 'oops' });
    const result = await probeMimo(MIMO_CFG, { send });
    check('探测把 5xx 透传成可读结论', result.ok === false && result.reason === 'server');
  }

  // ---------------------------------------------------------------- 结果

  if (failures.length) {
    console.error(`\n语音识别自测未通过，${failures.length} 条不符`);
    failures.forEach((name) => console.error(`  ✗ ${name}`));
    process.exit(1);
  }
  console.log('\n语音识别自测通过：WAV 封装、响应解析、结论归类、转写请求与探测全部符合预期');
})();
