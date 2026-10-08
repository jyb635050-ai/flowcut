# PROGRESS — 流音 Flowcut

## 开工回执（2026-10-08）
- 目标：网页歌曲剪辑（导入 15+ 格式 → 裁剪/切开/删除/排序/音量/淡入淡出/交叉淡化/标准化 → 导出 7 种格式），磨砂玻璃界面，上线 jyb635050-ai.github.io/flowcut，判卷 tools/accept.mjs 全绿。
- 任务 0 核对：指纹 760d7b73…cf3e 一致；`node tools/accept.mjs` 0/1；`--prove` 21/22（漏「还没有网站」）退出码 2 —— 与任务书一致。
- 顺序：①引擎（数据模型/撤销/渲染图，试听与导出同一套）+ 导入（原生解码→ffmpeg.wasm 兜底）+ 导出（WAV/AIFF 自写、Opus 用 WebCodecs+自写 Ogg 封装、MP3/FLAC/OGG/M4A 走 ffmpeg.wasm）②界面与性能（canvas 单层画可见区波形）③上线。
- 最大风险：ffmpeg.wasm 出错后实例坏掉（要重建）；液态玻璃滤镜在 backdrop-filter 里不被支持时整条声明失效（要留纯 blur 兜底）。

## 进度
- [x] 任务 0
