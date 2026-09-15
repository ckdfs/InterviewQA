# 面试问答助手 · 维护说明

这份文档面向继续改动本项目的人与 agent。使用方式、配置项、常见问题在 [README.md](README.md)，
这里只放维护这个项目需要知道的事：模块分工、设计理由、自测与 CI、发布流程、以及踩过的坑。

改代码前先读第三节（音频链路）与第十一节（改动约定），这两节覆盖了最容易踩空的地方。

## 一、运行形态

应用不自带任何模型额度，作答与转写全部走使用者自己的 API Key。两种运行形态的差别集中在可写目录：

| | 源码运行 | 打包运行 |
| --- | --- | --- |
| 判定 | `app.isPackaged === false` | `app.isPackaged === true` |
| 配置与简历 | 项目目录 | `%APPDATA%\InterviewQA` / `~/Library/Application Support/InterviewQA` |
| 更新检查 | 不检查（`update.js` 的 `decideMode` 返回 `off`） | 按平台与签名类型决定 |
| 界面元素 | 与打包版完全一致 | 同左 |

可写目录的选择在 `main.js` 构造 `ConfigStore` 时完成，原因是打包后 `app.asar` 只读。
`config.json` 是**增量式**的：只写用户改过的字段，读取时与默认值合并，详见第四节。

## 二、进程与模块分工

| 文件 | 职责 | 边界 |
| --- | --- | --- |
| `main.js` | 主进程。窗口与菜单、IPC、采集权限、PCM 缓冲与切片、转写调度、DeepSeek 调用、引导与设置 | 不直接碰 DOM |
| `asr.js` | 语音识别层：WAV 封装、MiMo 转写、连接与转写可用性探测 | 不依赖 Electron，可在普通 Node 里跑 |
| `config.js` | 配置层：默认值、字段白名单与校验、原子写回、首次启动判定 | 不依赖 Electron |
| `resume.js` | 简历加载：多文件提取文字 → DeepSeek 整理成档案 → 缓存复用 | 网络调用走注入的取数函数 |
| `resume-context.js` | 按问题类型决定注入档案的哪部分 | 纯函数 |
| `update.js` | 自动更新：更新方式判定、状态机、检查与安装 | 纯函数 + 可注入运行时 |
| `transcript-merge.js` | 切片重叠部分去重拼接 | 纯函数 |
| `preload.js` | 渲染进程安全桥，只暴露具名方法 | 不放开任意通道 |
| `renderer/app.js` | 聊天界面、引导向导、设置面板、音源与设备、AudioWorklet 采集 | 不做任何网络请求与配置读写 |
| `renderer/audio-worklet.js` | 16k 单声道 PCM 采集与电平上报 | 运行在音频线程 |
| `scripts/launch.js` | Electron 启动器，统一处理环境变量差异 | 所有拉起 Electron 的地方都走它 |
| `scripts/after-pack.js` | 打包后补 ad-hoc 签名 | 只在无证书时生效 |

数据流：

```
渲染层采集 PCM ──audio:pcm──▶ main 缓冲与切片 ──▶ asr.transcribe（MiMo）
   ▲                                                      │
   └──answer:delta / transcript:partial◀── transcript-merge 拼接 ──▶ DeepSeek 流式作答
```

判定逻辑一律抽成纯函数或可注入依赖（`decideMode`、`classifyMimo`、`mergeDefaults`、`probeMimo` 的
`deps.send`），这样自测不用联网、不用 Key、不依赖个人材料。

## 三、音频链路

### 采集

两种音源，出口统一成一条 `MediaStream`：

- `system`：`getDisplayMedia({ video: true, audio: true })`，实际音源由主进程的
  `setDisplayMediaRequestHandler` 给出（`audio: 'loopback'`），拿到后立刻停掉视频轨；
- `microphone`：`getUserMedia`，可选 `deviceId: { exact }` 指定设备。

几条不能删的保护：

1. **macOS 固定走 Screen & System Audio Recording 体系**。Electron 39 起 Chromium 默认改用
   CoreAudio Tap；该路径创建失败时只返回一条**已结束的静音轨**，官方文档明确说明不会抛出任何
   错误或警告，表现为「录完什么都没识别到」。`main.js` 用
   `disable-features=MacCatapLoopbackAudioForScreenShare` 固定切回旧体系。
2. **拿到轨必须校验 `readyState === 'live'`**（`audioTrackLive`）。这是上面那条静音轨的兜底，
   没有它，采集失败会静默地录下一整段空白。
3. **权限分 `granted` 与 `usable` 两档**。`denied` / `restricted` 才是硬拦；`not-determined`
   属于「还没问过」，此时应该发起申请（`askForMediaAccess`）而不是让用户去系统设置里翻。
   把两者混为一谈，首次使用麦克风的人会被引导到一个还没出现勾选项的页面。
4. **`deviceId` 失效要退回默认设备**。设备被拔掉或重装后 `getUserMedia` 抛
   `OverconstrainedError`，此时清掉保存的 `audio.deviceId` 再用默认设备重试，否则会一直失败。
5. **录音中禁止切音源**（`renderControls` 里 disable 掉开关），避免录到一半换了设备。

三处界面（底栏、引导第 3 步、设置面板）共用 `SOURCE_VIEWS` 一套渲染与交互，底栏是权威入口，
切换立即落盘。新增一处音源界面只需往 `SOURCE_VIEWS` 里加一项。

### 切片

16k 单声道 16bit。静音段（`rms < silenceThresholdRms * 0.5`）直接跳过转写，省时间也避免模型
对纯静音产生幻觉。停止录音时把剩余音频切成多段并行转写，让最后一段的等待降到原来的
1/2 至 1/3（`flushTailParallel`）。

### 转写

走 MiMo 的 `chat/completions`，音频以 `input_audio` 的 data URL 内联，并发上限
`stt.maxConcurrent`。**项目已不包含任何本地语音引擎**：打包版没有 Python 运行时，模型要额外
下载数百 MB，且本地与云端识别口径不一致会让自检结论失去意义。

### 自检口径

| 检查项 | 实现 | 为什么这么做 |
| --- | --- | --- |
| DeepSeek 作答 | `GET /models` | 不消耗 token，验 Key、地址、网络 |
| MiMo 转写 | 用代码生成的静音音频走**一次真实转写** | 接口能通不等于模型名写对了、账号开通了语音识别。只打接口会让这三类错误留到面试现场才暴露 |
| 录音 | 按当前音源打开 2 秒，读电平峰值 | 设备能否打开、权限是否就绪、到底有没有收到声音 |

静音音频由 `asr.js` 的 `silentWav()` 生成，不依赖任何音频文件，打包版里同样可用。
判定只看 HTTP 状态与响应结构，**不要求识别结果为空**：实测纯静音也会返回 2 个字，
把「文本非空」当失败条件会误报。

录音自检的结论分三档：打不开设备、设备正常但没收到声音、收到声音（附峰值）。
「设备能打开但没声音」必须单独成档，否则用户拿到的是一句没用的「正常」。

HTTP 结论归类集中在 `classifyMimo`，新增状态码只改这一处；`200` 里夹带 `error` 对象的网关
也要按失败处理。渲染层两条链路的结论行共用 `paintProbe`，引导与设置显示的措辞始终一致。

## 四、配置层

- **增量式**：`DEFAULT_CONFIG` 是骨架，磁盘上的 `persisted` 按类型逐字段覆盖
  （`mergeDefaults`）。因此 `config.json` 里可以只有两三行，缺的字段由默认值补齐；
  用户手改时删掉字段等于恢复默认。
- **白名单校验**：设置界面能改的字段全部登记在 `EDITABLE`，未知字段直接拒绝并回错误信息。
  这是防止渲染层写入任意路径或类型的关键一环。
- **密钥只回显尾部四位**（`safeView`），完整值不进渲染层。
- **原子写回**：先写 `.tmp` 再 rename，避免写到一半留下半截 JSON。
- **环境变量覆盖**：`DEEPSEEK_API_KEY` / `MIMO_API_KEY` 优先于文件，便于 CI 与临时启动。

新增一个配置字段要动四处，缺一处会在界面上表现为「保存了但下次打开又变回去」：

1. `DEFAULT_CONFIG` 加默认值；
2. `EDITABLE` 加校验规则；
3. `safeView()` 加回显字段；
4. 渲染层 `settings.fill()` 回填、`settings.collect()` 收集（界面可改时）。
   引导页若也要用，另加 `setupState()`。

## 五、自动更新

更新源是本仓库的 Releases，配置在 `electron-builder.yml` 的 `publish` 段，打包时会写进应用内的
`resources/app-update.yml`——**缺这个文件，检查更新必然失败，且报错不说明原因**。

更新方式由 `update.js` 的 `decideMode()` 决定，纯函数、可断言：

| 场景 | 方式 | 行为 |
| --- | --- | --- |
| 源码运行 | `off` | 不检查 |
| Windows 安装版（NSIS） | `auto` | 自动下载，退出并替换 |
| Windows 免安装版 | `notify` | 只提示，按钮打开下载页 |
| macOS，Developer ID 签名 | `auto` | 自动下载，退出并替换 |
| macOS，ad-hoc / 未签名 | `notify` | 只提示，按钮打开下载页 |

**为什么未签名的 macOS 版不能自动更新**：electron-updater 在 macOS 上把 zip 交给系统自带的
Squirrel.Mac 安装，Squirrel 会校验下载包的签名是否满足**当前运行应用的指定要求**。
ad-hoc 签名的应用，指定要求就是它自己那份 cdhash，换一个构建必然对不上，更新会被直接拒绝。
配上 Developer ID 证书（仓库 Secrets 的 `CSC_LINK` / `CSC_KEY_PASSWORD`）后判定自动切到
`auto`，代码无需改动。

**为什么免安装版不能自动更新**：它是运行时解压出来的单个 exe，没有可被替换的安装目录。

两个容易踩空的细节：

- **更新清单只有一个文件名**。`latest-mac.yml` 分两次单架构构建时，后一次会整体覆盖前一次，
  清单里只剩一个架构，另一半用户从此收不到新版本。mac 的双架构必须在同一次
  `electron-builder --mac --arm64 --x64` 里构建。
- **检查与下载走的域名不同**。检查走 `github.com/<owner>/<repo>/releases.atom`，下载走
  `.../releases/download/<tag>/<file>`，都不走 `api.github.com`；atom 解析失败时的报错措辞
  会让人误以为走的是 API。

`update.js` 还有两个约定：录制中拒绝安装（用户可能正对着面试题，换版本比晚几分钟次要得多），
以及事件到达后由 `reduceState` 统一算界面状态，不在各处散写判断。

## 六、打包与签名

```bash
npm run build:win        # nsis（安装版）+ portable（免安装版）
npm run build:mac        # arm64 + x64，dmg + zip
```

- Windows 两个目标各有用途：只有 nsis 支持自动更新，portable 双击即用但不能自我替换。
  `electron-builder.yml` 里的 `nsis.artifactName` 与 `portable.artifactName` 必须区分开，
  否则两者会抢同一个文件名。
- **macOS 必须同时产出 `zip` 目标**，它是 Squirrel.Mac 的安装包；只出 dmg 时不会生成
  `latest-mac.yml`。
- `identity: null` 表示不主动找证书；`scripts/after-pack.js` 在无证书时补一次 ad-hoc 签名。
  未签名的 `.app` 在 Apple Silicon 上会被 Gatekeeper 判为「已损坏」而无法启动。
- Info.plist 需要 `NSAudioCaptureUsageDescription` 与 `NSMicrophoneUsageDescription`
  两个键，缺了会拿到一条没有声音的死流或麦克风直接不可用。
- `files` 白名单只列运行必需文件。`resume/` 与 `config.json` 属于使用者个人材料，
  **绝不进包**；CI 会直接断言 `app.asar` 的实际内容，比只检查配置更可靠。

## 七、自测体系

```bash
npm run selftest      # 用 scripts/fixtures/test_sample.wav 模拟一次录音，跑通全链路（联网）
npm run test:context  # 简历注入策略：合成档案夹具，20 条问题断言注入模式
npm run test:resume   # 简历链路：PDF 提取、源文件识别、首次解析、缓存命中与失效
npm run test:merge    # 转写拼接：切片重叠去重（含同音字造成的重叠）
npm run test:asr      # 语音识别：WAV 封装、响应解析、HTTP 结论归类、转写请求与探测
npm run test:update   # 自动更新：签名判定、更新方式、状态迁移、安装条件
npm run test:ui       # 界面冒烟：元素引用、引导向导、音源切换、连接自检、设置面板、保存字段白名单
```

除 `selftest` 外都不联网、不需要 Key，可直接在 CI 里跑。切分原则是**按判定边界切**，不是按文件切：
每个脚本对应一组「改错了会静默出错」的判断，断言的措辞就是出错时的现象。

`selftest` 用的 `scripts/fixtures/test_sample.wav` 是本人录音，按隐私口径不入库（见 `.gitignore`），
所以 CI 不跑它。本地要跑就先自己录一段 16kHz 单声道 PCM 放在该路径，内容随意。

几条维护上的约定：

- `test:ui` 会从 `app.js` 抽出全部 `$('id')` 引用与 `index.html` 比对，**新增界面元素但忘了改
  HTML 会在这里失败**；它还会校验设置面板提交的字段都落在 `EDITABLE` 里。
- `test:ui` 的桩状态要跟着保存请求变化（`applyPatch`），否则「保存后回到上一步」这类正常流程
  会在冒烟里假失败。
- 本地跑界面冒烟：

```bash
node scripts/launch.js --script scripts/ui-check.js -- --no-sandbox --disable-gpu --disable-gpu-compositing
```

- 想用自己的档案看注入判定效果（只打印、不断言）：

```bash
node test-resume-context.js --profile resume/profile.md
```

## 八、CI

`.github/workflows/build.yml` 三段式，后一段只在前一段通过后启动：

1. **checks**（ubuntu）：语法检查 → 各纯逻辑自测 → 安装依赖 → 简历链路 → 界面冒烟（xvfb）；
2. **build-windows / build-mac**（可并行）：打包 → 校验产物 → 校验更新元数据 → 上传产物；
   mac 任务额外做四件事：断言 Info.plist 权限键与签名有效性、断言更新清单含两个架构、
   断言包内不含个人材料与疑似密钥、启动打包后的二进制并要求日志里出现更新方式判定；
3. **release**（仅 tag）：下载全部产物 → 断言更新清单齐备 → 创建 Release。
   发布前先校验清单是有意为之：清单缺失时客户端只会一直报错，缺增量包则只影响下载量，
   因此后者只提示、不阻断。

打 tag 即发布：

```bash
git tag v1.2.0 && git push --tags
```

## 九、实测记录与判断依据

以下数据来自本机与 CI 的实测，改动相关参数前先看这里，避免把调过的值改回去。

- **作答思考深度**：`deepseek-flash` 默认设置下首个正文要等 4~8 秒，`reasoningEffort: none`
  后降到 0.3~0.7 秒，回答质量没有可见差别。因此作答固定 `none`，简历解析这类一次性任务
  仍用 `resume.reasoningEffort`（默认 `low`）。
- **测试音频取 6.5 秒**：云端 ASR 对 2 秒级短语音会把技术术语听错（「进程和线程」在短句上约
  两成概率被听成「近程和远程」），6 秒以上稳定复现。自检样本刻意取长，避免出现与线上不符的
  偶发失败。
- **转写耗时**：6.5 秒音频一次转写约 0.7 秒；静音探测约 0.5 秒。
- **静音也会返回文本**：空音频实测返回 2 个字。因此探测的通过条件是 HTTP 200 且响应结构可解析，
  与识别文本是否为空无关。
- **macOS 采集**：ad-hoc 签名下屏幕录制权限每次升级安装后可能需要重新授予，这是系统行为，
  不是签名流程的问题。

## 十、本地验证的坑

- **`ELECTRON_RUN_AS_NODE=1`**：部分终端环境会带这个变量，Electron 会退化成纯 Node，
  表现为「打包后的二进制没有任何输出且挂在标准输入」。用 `scripts/launch.js` 启动，
  它会自动清掉；直接跑二进制时用 `env -u ELECTRON_RUN_AS_NODE <binary>`。
- **沙箱或远程环境里 GPU 进程反复崩溃**：加 `--no-sandbox --disable-gpu --disable-gpu-compositing`
  才能活到首次网络请求。
- **`codesign -dv --verbose=4` 的输出打在标准错误**，只收 stdout 会拿到空串；判定签名类型要
  同时收 stdout 与 stderr。
- **`timeout` 命令在 macOS 上不存在**，脚本里用 `curl --max-time` 之类自带超时的参数。
- **下载 GitHub 任务日志是两步跳转**：第一步带 `Authorization`，第二步（对象存储）不能带，
  否则 401。
- **macOS 更新检查的网络依赖**：公司网络拦截 `github.com` 时检查更新会失败，这属于网络环境
  问题，不必改代码。

## 十一、改动约定

- **新增 IPC**：主进程 `ipcMain.handle` → `preload.js` 加具名方法；事件还要加进 `on` 的
  通道白名单，否则渲染层订阅不到且不报错。
- **新增配置**：按第四节的四处清单一起改。
- **改了判定或状态机**：同步补 `scripts/check-*.js` 的断言，措辞写成出错时的现象。
- **改了界面结构**：跑 `test:ui`，它会覆盖元素引用与字段白名单两类静默错误。
- **提交前**：

```bash
for f in main.js asr.js config.js preload.js resume.js resume-context.js \
         transcript-merge.js update.js start.js test-resume-context.js scripts/*.js; do
  node --check "$f"
done
npm run test:asr && npm run test:update && npm run test:merge && npm run test:resume
node test-resume-context.js
npm run test:ui
```

- **注释写「为什么」**：这个项目里几乎所有非常规写法都是被某个具体的坑逼出来的
  （静音轨不报错、清单互相覆盖、原子写回），注释要留住那个理由，否则下一个人会把保护删掉。
