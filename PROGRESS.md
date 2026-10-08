# PROGRESS — 流音 Flowcut

## 开工回执（2026-10-08）
- 目标：网页歌曲剪辑（导入 15+ 格式 → 裁剪/切开/删除/排序/音量/淡入淡出/交叉淡化/标准化 → 导出 7 种格式），磨砂玻璃界面，上线 jyb635050-ai.github.io/flowcut，判卷 tools/accept.mjs 全绿。
- 任务 0 核对：指纹 760d7b73…cf3e 一致；`node tools/accept.mjs` 0/1；`--prove` 21/22（漏「还没有网站」）退出码 2 —— 与任务书一致。
- 顺序：①引擎（数据模型/撤销/渲染图，试听与导出同一套）+ 导入（原生解码→ffmpeg.wasm 兜底）+ 导出（WAV/AIFF 自写、Opus 用 WebCodecs+自写 Ogg 封装、MP3/FLAC/OGG/M4A 走 ffmpeg.wasm）②界面与性能（canvas 单层画可见区波形）③上线。
- 最大风险：ffmpeg.wasm 出错后实例坏掉（要重建）；液态玻璃滤镜在 backdrop-filter 里不被支持时整条声明失效（要留纯 blur 兜底）。

## 进度
- [x] 任务 0
- [x] 任务 1：导入/剪辑/导出（scenario+formats 31/31）。反向验证：导出去掉交叉淡化 → S5/S9/S11 红（时长差 1.000s），还原后全绿
- [x] 任务 2：界面与性能（perf+ui 15/15）。反向验证：删掉全部 backdrop-filter → U4 红（0 个），还原后 4 个。截图 shots/final-1440x900-{light,dark}.png
- [x] 任务 3：上线 https://jyb635050-ai.github.io/flowcut/（仓库 main=源码，gh-pages=site/ 内容，`git subtree push --prefix site origin gh-pages`）
- 最终（2026-10-08）：本地 44/44、线上 `--url` 45/45、`--prove` 26/26 退出码 0；指纹 760d7b73…cf3e 未变（git 里同样）
- 额外自查：96k FLAC、单声道 MP3、中文+空格文件名、5.1 AC3、带封面 MP3 都能导入，导出双声道、时长分毫不差，切口无咔哒；反作弊 grep 无命中

## 改动过程中的决定（建议类，偏离原因）
- 波形不用「每段一个 canvas」，改成时间线上一张画布只画看得见的部分：任意缩放都清晰，拖动 60fps
- 导出面板导出后不自动关（可连续导多种格式），关闭动画压到 0.15s——原来 0.6s 的关闭动画会让「刚关又开」的点击落空（判卷 S18 曾因此耗时 206s）
- 导入时 IndexedDB 存 File 本身，不存 ArrayBuffer：省掉主线程 14MB 拷贝（曾造成 86ms 卡顿）
- 交叉淡化用等功率曲线、淡入淡出用线性
