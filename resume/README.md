# 把你的简历材料放这里

支持 **pdf / txt / md**，可以同时放多份（例如「简历 + 成绩单」，会合并成一份背景档案）。

- 首次启动会自动提取文字 → 调 DeepSeek 整理成背景档案 → 缓存到本目录的 `profile.md`，之后直接复用；
- 换文件后（大小或修改时间变了）会自动重新解析；
- 想微调档案内容，直接编辑 `profile.md` 即可（源文件不变时不会被覆盖）。

**打包版（exe / app）的目录不在这里**，而在系统用户目录里，界面右上角「未提供简历」的提示上会显示具体路径：

- Windows：`%APPDATA%\InterviewQA\resume`
- macOS：`~/Library/Application Support/InterviewQA/resume`

> 隐私提醒：本目录里的文件属于个人材料，已在 `.gitignore` 中排除，不会被提交到仓库。
