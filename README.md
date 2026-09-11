# 面试问答助手（InterviewQA）

录制**电脑正在播放的声音** → 边录边转文字 → DeepSeek V4.1 Flash 结合你的简历，给出约 200 字、可口头作答的面试参考答案 → 聊天对话形式流式显示。也支持直接手动输入问题。

## 快速开始

```bash
npm install          # 首次
npm start
```

应用启动即可用（语音识别走云端），无需等待模型加载。

首次使用需要填 API Key：把 `config.example.json` 复制成 `config.json`，填入 DeepSeek 与 MiMo 的 Key。也可以直接用环境变量注入（CI / 免改文件）：

```bash
DEEPSEEK_API_KEY=sk-xxx MIMO_API_KEY=sk-yyy npm start
```

> `config.json` 与 `resume/` 下的个人材料都已在 `.gitignore` 中排除，**不会进仓库**。

## 打包成可执行文件

```bash
npm run build:win    # Windows 绿色版（portable exe，免安装，输出 dist/*.exe）
npm run build:mac    # macOS zip + dmg（输出 dist/*.zip、dist/*.dmg）
```

推到 GitHub 后，`.github/workflows/build.yml` 会自动构建：

- push 到 `main` 或手动触发 → 在 Actions 里产出 Windows / macOS 构件（下载即可用）；
- 打 tag（如 `git tag v1.0.0 && git push --tags`）→ 额外自动创建 Release 并附上安装包。

**平台差异说明**：系统声音录制用的是 Windows WASAPI 回环，**macOS 没有对应的原生能力**——要在 Mac 上录系统声音，需先装虚拟声卡（如 [BlackHole](https://existential.audio/blackhole/)）并把系统输出设为它；手动输入提问在两个平台上都正常。

签名说明：仓库默认**不做代码签名**。Windows 会提示"未知发布者"，点"更多信息 → 仍要运行"即可；macOS 需在"系统设置 → 隐私与安全性"里点"仍要打开"，或用 `xattr -cr InterviewQA.app` 解除隔离。有证书的话可在 CI 配 `CSC_LINK`、`CSC_KEY_PASSWORD` 等密钥启用签名。

自检（用 `stt/test_sample.wav` 模拟一次录音，跑通「切片 → 转写 → 拼接 → 结合简历生成回答 → 中断」，并验证手动输入）：

```bash
npm run selftest
```

## 使用方式

1. 打开你想问的面试视频/音频并开始播放；
2. 点击底部「开始录音」——直接采集系统声音，无需任何虚拟声卡；
3. 录音过程中已识别的文字会实时出现；
4. 点击「结束这一段」，约 1~2 秒后补全最后一句，随即由 DeepSeek 流式生成回答（适合分点的问题会自动用 1. 2. 3. 分点作答）；
5. 回答生成中按钮会变成「**停止回答**」，点击可随时中断，已生成的内容会保留；
6. 也可以忽略录音，直接在底部输入框里打字提问（回车发送）。

## 基于简历作答（resume 目录）

把简历放进项目的 `resume/` 目录即可，支持 **pdf / txt / md**，并且**可以同时放多份**（例如「简历 + 成绩单」，会合并成一份背景档案）：

- **首次启动**：自动提取文字 → 调 DeepSeek 整理成结构化背景档案 → 缓存为 `resume/profile.md`，界面右上角显示「背景资料：张新科」；
- **之后启动**：直接复用缓存，不再调用模型；
- **换了文件**：源文件的大小或修改时间变了会自动重新解析；也可以在代码里调用 `resume:reload` 强制重解析；
- **想微调档案**：直接编辑 `resume/profile.md` 就行（源文件不变时不会被覆盖），改动立刻生效；
- **只想拿到结果给软件使用者**：把 `resume/profile.md` 一起拷过去，即使没有源文件也能用；
- 首屏解析约 10~15 秒（一次性，不阻塞使用，期间录音和提问照常工作）。

> 注意：`resume/` 目录里是你的个人材料，分享软件时请自行确认是否要一起打包。

### 按问题类型智能注入（默认开启）

不会每次都把整份简历塞给模型，而是先判断问题类型，只注入相关片段：

| 问题类型 | 举例 | 注入内容 |
| --- | --- | --- |
| 技术八股 / 理论题 | "什么是进程和线程的区别？"、"解释一下 TCP 三次握手" | **不注入**（并提示模型不要硬扯候选人经历） |
| 项目类 | "你项目里最难的地方是什么？" | 项目经历 + 科研成果 |
| 实习类 | "你在特斯拉实习具体做了什么？" | 实习经历 + 专业技能 |
| 科研 / 荣誉 / 学业 / 技能 | "你拿过哪些奖项？"、"本科成绩怎么样？" | 对应章节 |
| 自我介绍 / 优势 / 动机 | "介绍一下你自己"、"为什么选这个岗位？" | 完整档案 |

判断全在本地用关键词完成，**不额外调用模型、不增加等待时间**。日志里会打印判定结果，例如：

```
[简历注入] project，803 字（命中主题：project（含理论词但有经历信号））
[简历注入] 不注入（技术理论题（2 个理论特征词））
```

想看/调判定效果：

```bash
npm run test:context
```

它会跑一批典型问题并列出判定与注入字数。觉得某类判得不对，改 `resume-context.js` 顶部的关键词表即可。也可以用 `resume.contextMode` 切换成 `all`（永远注入完整档案）或 `none`（从不注入）。


## 为什么快

- **转写用 MiMo-V2.5-ASR 云端接口**：实测 9 秒音频约 1 秒返回，还自带标点；
- **边录边转**：AudioWorklet 取 16kHz 单声道 PCM（不用 WebM，可任意位置切片），累计约 8 秒或检测到停顿就切一段送识别，点"结束"时只剩尾巴要等；
- **音频提前初始化**：应用启动时就创建 AudioContext 并加载 AudioWorklet，点录音时省掉这段等待；
- **连接复用 + 启动预热**：HTTP keep-alive 复用连接，启动时先访问一次 DeepSeek `/models` 预热，首次提问少一次 TLS 握手。

## 配置（config.json）

| 字段 | 说明 |
| --- | --- |
| `stt.engine` | `mimo`（云端，默认）或 `local`（本地 faster-whisper） |
| `stt.mimo.apiKey` / `model` / `language` | MiMo ASR 的 Key、模型（`mimo-v2.5-asr`）、语种（`zh`） |
| `stt.maxConcurrent` | 云端转写并发数，默认 4 |
| `stt.fallbackToLocal` | 云端失败时自动回退本地 Whisper（首次回退才启动本地进程） |
| `whisper.*` | 本地兜底引擎参数（模型大小、线程数、worker 数） |
| `chunk.targetSeconds` / `maxSeconds` | 切片目标时长与硬上限，越小越"实时" |
| `chunk.overlapSeconds` | 相邻片段重叠时长，避免词被切断 |
| `chunk.tailMaxParts` | 停止时把剩余音频切成几段并行转写（默认 1，即不切；调大更快但边界措辞可能失真） |
| `resume.enabled` / `dir` / `profileFile` | 是否启用简历、材料目录、档案缓存路径 |
| `resume.reasoningEffort` | 解析简历时的思考强度，默认 `low`（更快） |
| `resume.contextMode` | 注入策略：`smart`（按问题类型，默认）/ `all`（总是完整档案）/ `none`（从不注入） |
| `resume.defaultInject` | 判不出问题类型时的默认行为，默认 `none`（不注入） |
| `deepseekApiKey` / `deepseekModel` | DeepSeek 参数，模型名 `deepseek-flash`（V4.1 Flash） |
| `answer.maxChars` / `historyTurns` | 回答长度要求与携带的历史轮数 |

## 目录结构

```
main.js                 主进程：系统声音授权、PCM 缓冲与切片、云端/本地转写调度、DeepSeek 流式调用、中断控制
resume.js               简历加载：多文件提取文字 → DeepSeek 整理成档案 → 缓存复用
resume-context.js       按问题类型决定注入哪部分档案（八股不注入、项目/实习只注入对应片段）
test-resume-context.js  注入策略自测脚本（npm run test:context）
start-app.bat           双击启动
preload.js              渲染进程安全桥
renderer/               聊天界面、手动输入、AudioWorklet PCM 采集
stt/worker.py           本地兜底转写进程（预加载模型，行式 JSON 协议）
stt/test_transcribe.py  本地转写自检脚本
resume/                 你的简历材料（pdf/txt/md）与解析产物 profile.md
config.json             API Key 与各项参数
```

## 环境要求

- Windows（系统声音回环依赖 WASAPI loopback）
- 已安装 Electron 依赖与 `pdf-parse`；本地兜底引擎需要 `.venv` 内的 faster-whisper

## 常见问题

- **提示没有录到声音**：确认电脑确实在播放音频且未静音；可调小 `chunk.silenceThresholdRms`，或点击按钮前先播放 1 秒声音。
- **回答没有结合简历**：确认右上角显示了「背景资料：xxx」；若显示未提供，检查 `resume/` 目录下是否放入了 pdf/txt/md 文件。
- **简历解析失败**：多半是扫描件（图片型 PDF）提取不到文字，换成文本版 PDF 或直接放 txt/md；界面右上角会显示失败状态。
- **想改回本地识别**：把 `stt.engine` 改成 `local`，应用启动时会加载本地模型（首次约需 10 秒，之后常驻内存）。
- **识别有错别字**：MiMo 可在 `stt.mimo.language` 明确语种；用本地引擎时可把岗位/技术栈关键词写进 `whisper.initialPrompt`。
- **回答没生成完就停了**：这是「停止回答」的正常行为，已生成部分会保留在对话里。
- **想更长/更短的回答**：改 `config.json` 里的 `answer.maxChars`，并同步调整 `main.js` 里 `BASE_SYSTEM_PROMPT` 的字数要求。
