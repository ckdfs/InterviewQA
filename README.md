# 面试问答助手（InterviewQA）

录制**电脑正在播放的声音** → 边录边转文字 → DeepSeek 结合你的简历，给出约 200 字、可口头作答的面试参考答案 → 聊天形式流式显示。也支持直接手动输入问题。

## 快速开始（源码运行）

```bash
npm install
npm start
```

首次启动会弹出初始化引导，分三步完成：

1. **模型服务**：填 DeepSeek 与 MiMo ASR 的 API Key（可用「测试连接」当场验证）；
2. **个人简历**：选择 PDF / TXT / MD 简历文件（可多选，也可暂时跳过）；
3. **录音权限**：检查系统声音采集权限，缺权限时一键跳到系统设置。

三步走完才会进入使用界面。之后任何时候都能从右上角齿轮图标打开设置面板修改。

也可以完全用环境变量注入，跳过填 Key 这一步：

```bash
DEEPSEEK_API_KEY=sk-xxx MIMO_API_KEY=sk-yyy npm start
```

> `config.json` 与 `resume/` 下的个人材料都在 `.gitignore` 中排除，**不会进仓库**；打包时也不会进安装包。

## 平台差异

| 能力 | Windows | macOS |
| --- | --- | --- |
| 录制系统声音 | WASAPI 回环，开箱可用 | 通过 CoreAudio Tap 采集，需 macOS 13+ 并授予「屏幕录制」权限 |
| 手动输入提问 | 可用 | 可用 |
| 本地 Whisper 兜底 | 需自建 `.venv` | 同左 |

**macOS 首次使用**：点「开始录音」时系统会弹出屏幕录制授权，勾选本应用后**需要重新打开应用**才生效。若误点了拒绝，到「系统设置 → 隐私与安全性 → 屏幕录制」里勾选回来即可；应用内的提示条上也有直达按钮。

## 使用方式

1. 打开面试视频 / 音频并开始播放；
2. 点底部「开始录音」，直接采集系统声音，无需虚拟声卡；
3. 录音过程中已识别的文字实时出现；
4. 点「结束这一段」，约 1~2 秒后补全最后一句，随即由 DeepSeek 流式生成回答（适合分点的问题会自动用 1. 2. 3. 分点作答）；
5. 生成中按钮变为「停止回答」，点击可随时中断，已生成内容保留；
6. 也可以忽略录音，直接在底部输入框打字提问（回车发送）。

## 设置面板

右上角齿轮图标，分四个页签：

- **模型服务**：DeepSeek / MiMo 的 Key、接口地址、模型名，内置连接自检；
- **回答与识别**：回答字数上限、携带历史轮数、思考深度、简历注入策略、识别引擎与切片参数；
- **简历材料**：添加 / 移除简历文件、强制重新解析、打开材料目录；
- **关于**：版本、平台、配置文件与简历目录位置。

配置落在系统用户目录，界面里可以直接打开：

- Windows：`%APPDATA%\InterviewQA\config.json`
- macOS：`~/Library/Application Support/InterviewQA/config.json`

密钥在界面里只回显尾部四位，完整值不会回传到渲染层。

## 打包

```bash
npm run icon          # 生成应用图标 build/icon.png（已提交，一般无需重跑）
npm run build:win     # Windows 免安装 exe → dist/*.exe
npm run build:mac     # macOS dmg + zip（arm64 与 x64）→ dist/
npm run build:mac:arm64
npm run build:mac:x64
```

推到 GitHub 后 `.github/workflows/build.yml` 自动构建：

- 任何 push / PR：先跑语法检查、注入策略自测与界面冒烟测试，通过后再并行构建 Windows（x64）与 macOS（arm64 / x64）；
  mac 任务构建完会断言 Info.plist 权限键与 ad-hoc 签名有效性——签名无效的包在 Apple Silicon 上会被 Gatekeeper 判为「已损坏」，
  这一步把它挡在发布之前。产物在 Actions 页面可直接下载；
- 打包任务只在 checks 全部通过后才启动，避免「代码改了但跑不起来」还占用构建机；
- 打 tag 后额外创建一个 Release，把安装包附上去：

```bash
git tag v1.1.0 && git push --tags
```

### macOS 签名

仓库默认**不做代码签名**。但未签名的 `.app` 在 Apple Silicon 上会被 Gatekeeper 判为「已损坏」而无法启动，因此构建时会自动补一次 **ad-hoc 签名**（`codesign --sign -`，不依赖任何证书）——这一步在 `scripts/after-pack.js` 里完成。

- GitHub Actions 的构建：签名与校验由 CI 自动完成，签名无效会直接失败，不会把坏包发出去；
- 本地下载到的 dmg/zip：首次打开需右键 →「打开」，或执行 `xattr -cr /Applications/InterviewQA.app`；
- 有自己的 Apple 开发者证书：在仓库 Secrets 配 `CSC_LINK` 与 `CSC_KEY_PASSWORD`，ad-hoc 签名会自动让位。

> 签名是「屏幕录制」权限能稳定授予的前提。每次安装新版本后，macOS 可能要求重新授权。

## 自检

```bash
npm run selftest      # 用 stt/test_sample.wav 模拟一次录音，跑通切片 → 转写 → 拼接 → 回答 → 中断
npm run test:context  # 简历注入策略自测（纯本地关键词判定，不外呼）
npm run test:resume   # 简历链路自检：PDF 提取、源文件识别、首次解析、缓存命中与失效、无 Key 时复用缓存
npm run test:ui       # 界面冒烟测试：元素引用、引导向导、设置面板、保存字段白名单
npm run test:stt      # 本地 Whisper 链路自测（需先建好 .venv）
```

以上四项都不联网、不需要 API Key，可直接在 CI 里跑；PDF 夹具由 `scripts/mini-pdf.js`
在运行时手写生成，仓库里不放二进制样本，也不依赖任何个人材料。

`stt/test_sample.wav` 是 6.5 秒的普通话问句，长度对齐真实切片（默认 8 秒）。云端 ASR 对
2 秒级的短语音会把技术术语听错（实测「进程和线程」在短句上有约两成概率被听成「近程和远程」），
6 秒以上则稳定复现，因此自检样本刻意取长，避免出现与线上不符的偶发失败。

## 配置项

`config.json` 由应用维护，也可以手改（改完重启生效）。常用字段：

| 字段 | 说明 |
| --- | --- |
| `deepseekApiKey` / `deepseekModel` | DeepSeek 的 Key 与模型名 |
| `stt.engine` | `mimo`（云端，默认）或 `local`（本地 faster-whisper，需自建 .venv） |
| `stt.mimo.apiKey` / `model` / `language` | MiMo ASR 的 Key、模型、语种 |
| `stt.maxConcurrent` | 云端转写并发数，默认 4 |
| `stt.fallbackToLocal` | 云端失败时是否回退本地 Whisper |
| `chunk.targetSeconds` / `maxSeconds` | 切片目标时长与硬上限，越小越实时 |
| `chunk.silenceThresholdRms` | 静音判定阈值，录不到声音时调小 |
| `resume.enabled` / `contextMode` | 是否启用简历、注入策略（`smart` / `all` / `none`） |
| `answer.maxChars` / `historyTurns` | 回答长度要求与携带的历史轮数 |
| `answer.reasoningEffort` | 作答时的思考深度，默认 `none`（见下） |
| `ui.setupDone` | 初始化引导是否已走完 |

### 关于思考深度

DeepSeek 的对话模型默认会先生成一大段思考内容再作答。面试场景下这段等待很致命——实测
`deepseek-flash` 在默认设置下首个正文要等 4~8 秒，而把 `answer.reasoningEffort` 设为
`none` 后首字降到 0.3~0.7 秒，回答质量没有可见差别。因此作答固定走 `none`，设置界面的
「思考深度」可随时调整；简历解析这类一次性任务仍用 `resume.reasoningEffort`（默认 `low`），
不受这里影响。

## 基于简历作答

把简历放进应用数据目录下的 `resume/`（在设置里直接「添加简历文件」即可）：

- **首次解析**：提取文字 → 调 DeepSeek 整理成结构化背景档案 → 缓存为 `profile.md`；
- **之后启动**：直接复用缓存，不再调用模型；
- **换了文件**：源文件的大小或修改时间变了会自动重新解析；
- **想微调档案**：直接编辑 `profile.md`（源文件不变时不会被覆盖）。

解析期间录音和提问照常可用，首屏约 10~15 秒。

### 按问题类型智能注入（默认开启）

不会每次都把整份简历塞给模型，而是先判断问题类型，只注入相关片段：

| 问题类型 | 举例 | 注入内容 |
| --- | --- | --- |
| 技术八股 / 理论题 | "进程和线程的区别？" | **不注入** |
| 项目类 | "你项目里最难的地方是什么？" | 项目经历 + 科研成果 |
| 实习类 | "你在上一家公司具体做了什么？" | 实习经历 + 专业技能 |
| 科研 / 荣誉 / 学业 / 技能 | "你拿过哪些奖项？" | 对应章节 |
| 自我介绍 / 优势 / 动机 | "介绍一下你自己" | 完整档案 |

判定全在本地用关键词完成，**不额外调用模型、不增加等待时间**。日志里会打印判定结果。

## 目录结构

```
main.js                 主进程：系统声音授权、PCM 缓冲与切片、转写调度、DeepSeek 流式调用、引导与设置 IPC
config.js               配置层：默认值、校验、原子写回、首次启动判定
resume.js               简历加载：多文件提取文字 → DeepSeek 整理成档案 → 缓存复用
resume-context.js       按问题类型决定注入哪部分档案
renderer/               聊天界面、引导向导、设置面板、AudioWorklet PCM 采集
preload.js              渲染进程安全桥
stt/worker.py           本地兜底转写进程（预加载模型，行式 JSON 协议）
scripts/after-pack.js   macOS ad-hoc 签名
scripts/make-icon.js    生成应用图标
.github/workflows/      多平台构建与 Release
```

## 环境要求

- Node.js 20+
- 系统声音录制：Windows 10+ / macOS 13+
- 本地 Whisper 兜底（可选）：在项目目录建 `.venv` 并安装 `stt/requirements.txt`

## 常见问题

- **提示没有录到声音**：确认电脑确实在播放音频且未静音；可调小 `chunk.silenceThresholdRms`，或点按钮前先播放 1 秒声音。
- **macOS 点了录音没反应**：检查「系统设置 → 隐私与安全性 → 屏幕录制」是否勾选了本应用，授权后需要重新打开应用。
- **回答没有结合简历**：看顶部徽标是否显示「简历：xxx」；没有就到设置的「简历材料」里添加文件。
- **简历解析失败**：多半是扫描件（图片型 PDF）提取不到文字，换成文本版 PDF 或直接放 txt/md。
- **回答没生成完就停了**：这是「停止回答」的正常行为，已生成部分会保留。
- **想更长/更短的回答**：在设置里改「回答字数上限」，或直接改 `config.json` 的 `answer.maxChars`。
