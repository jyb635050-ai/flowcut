# 流音 Flowcut

浏览器里的歌曲剪辑台：导入各种格式的音乐，裁剪、切开、删除、拖动排序、音量、淡入淡出、交叉淡化、响度标准化，导出 MP3 / WAV / FLAC / M4A / OGG / Opus / AIFF。全部在本机浏览器里处理，不上传。

线上：https://jyb635050-ai.github.io/flowcut/

## 目录
- `site/` 网站本体（纯静态，无需构建）：`index.html`、`css/app.css`、`js/{app,engine,codec,store,i18n}.js`、`vendor/ffmpeg/`（自托管 ffmpeg.wasm）
- `tools/accept.mjs` 验收判卷（冻结，不许改）；`tools/vendor.mjs` 把 node_modules 里的 ffmpeg.wasm 复制进 site/
- `tools/dev-*.mjs` 开发用小脚本（截图、导出计时）

## 常用
```
npm install && npm run vendor     # 准备 ffmpeg.wasm
node tools/accept.mjs             # 本地验收
node tools/accept.mjs --prove     # 反向验证
node tools/accept.mjs --url https://jyb635050-ai.github.io/flowcut/
git subtree push --prefix site origin gh-pages   # 部署（Pages 从 gh-pages 分支根目录发布）
```

## 技术要点
- 试听和导出共用 `engine.js` 的 `buildGraph`（同一套剪辑/音量/淡化），导出走 OfflineAudioContext
- 解码：浏览器原生优先；WMA/AIFF/ALAC/AMR/AC3 等交给 ffmpeg.wasm（用到才下载，约 10MB gzip）
- 编码：WAV/AIFF 自写；Opus 用 WebCodecs + 自写 Ogg 封装（ffmpeg.wasm 的 libopus 会崩）；MP3/FLAC/OGG/M4A 用 ffmpeg.wasm
- 第三方：FFmpeg（GPL-2.0-or-later，源码 https://github.com/ffmpegwasm/ffmpeg.wasm），@ffmpeg/ffmpeg（MIT）
