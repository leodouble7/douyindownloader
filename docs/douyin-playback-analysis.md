# 抖音播放方式与工程实现分析

## 分析依据

- 工程：Media Security Lab，新增功能基于 `2e9ad01`。
- 实测页面：<https://www.douyin.com/jingxuan?modal_id=7684438409082866998>。
- 页面标题：师徒四人身世吐槽大会 雪莲大将？（抖音作品）。
- 检查日期：2026-09-15。站点会调整分发协议，以下实测仅代表该作品在当前环境中的请求。

## 该页面实际如何播放

页面可以在临时 Electron 会话内播放，并产生 `MediaSource` / `SourceBuffer` 事件。媒体不在 HTML 的 `blob:` 字符串里；播放器从 CDN 获取媒体数据，将数据送入浏览器媒体缓冲区，浏览器再解码和同步播放。

实测同时存在目标作品与预加载内容，共观察到三个位于页面中的视频元素和四条可下载候选：

| 轨道 | 字节数 | 路径标记 |
| --- | ---: | --- |
| 目标视频 | 62,409,109 | `media-video-hvc1/` |
| 目标音频 | 9,478,113 | `media-audio-und-mp4a/` |
| 其他预加载视频 | 14,056,189 | `media-video-hvc1/` |
| 其他预加载音频 | 614,376 | `media-audio-und-mp4a/` |

请求来自 `v26-web.douyinvod.com`、`v11-weba.douyinvod.com` 等 CDN 域名，同一个作品的域名和出现顺序可能改变。资源路径、查询参数参与 CDN 分发，不应删除后再下载。该页面的这组实际请求**没有 `video_id` 查询参数**；只增加 `video_id` 关联规则不足以完成该例的自动配对。

`hvc1`、`mp4a` 是路径中的编码线索，实际编码仍以下载后的 ffprobe 输出为准。用 `video/mp4` 响应头判断“文件包含音频”会出错；这里的视频、音频需要分别下载后重新封装。

完整下载后，两条分轨的 MP4 元数据均包含同一内容标识 `vid:v0200fg10000dai9lm7og65v1ra4kh40`。FFprobe 核对结果如下：

| 项目 | 视频 | 音频 |
| --- | --- | --- |
| 编码 | HEVC Main / hvc1 | AAC LC / mp4a |
| 参数 | 1280 × 720 | 44100 Hz，双声道 |
| 时长 | 390.033333 秒 | 390.096009 秒 |
| 包数量 | 11701 | 16800 |

已下载的两条分轨经本地合并入口成功生成约 6 分 30 秒的 MP4。最终输出保持两条流的编码参数、extradata SHA-256 和包数量；`downloads/real-douyin-test/douyin-merge-pWrkcD/result.json` 保存本次真实结果，旁边的 `video.mp4` 是可播放文件。

```text
抖音页面 / 播放器
  ├── HTTP Range → 视频 CDN 文件 ─┐
  └── HTTP Range → 音频 CDN 文件 ─┤→ MSE SourceBuffer → 解码、同步播放
                                  │
下载工具：捕获有效 GET → 核对响应 → 分别完整下载 → ffprobe → FFmpeg stream copy
```

MSE 允许脚本把编码媒体字节送入 `SourceBuffer`，它本身不是远程下载协议，见 [W3C MSE 规范](https://www.w3.org/TR/media-source-2/)。字节跳动的开源播放器也展示了 MP4 按阶段加载的路线，但本次未据此断言目标页面使用其某个特定版本，见 [xgplayer 项目](https://github.com/bytedance/xgplayer)。

## 现有工程的可复用部分

1. `browser/cdp-capture.ts`：在页面、iframe、Worker 等目标上捕获网络与 MSE 元数据；原始 GET 模板通过独立回调留在内存。
2. `media/media-correlator.ts`：按响应 MIME、URL、MSE 和内容标识识别轨道；它有意在关联存在歧义时停止自动配对。
3. `probes/http-transport.ts`：先验证媒体起始区间，记录实际媒体字节、长度和响应版本信息。
4. `download/downloader.ts`：支持顺序 Range、限长响应、短读检查、取消和完整性校验，确认完整后才发布文件。
5. `media/ffmpeg-adapter.ts`：探测输入、检查分轨、无损封装，再检查输出流参数和时长。

新增入口把这些模块接成可运行流程。页面捕获放在 Electron 子进程，下载与 FFmpeg 放在 Node 主进程，避免 Node/Electron 原生模块 ABI 与下载工作进程启动方式混用。

## 选择与合并策略

- 只有一个可用资产时自动选择。
- 已由明确 MSE 关系或内容标识关联的音视频可成对选择。
- 存在多个候选时，在同一次捕获中显示列表并要求选择单文件或两个分轨序号，不依赖不同运行中的旧序号。
- 用户明确选择的两条轨仍需满足纯视频 / 纯音频、容器和时长兼容要求；不通过就保留分轨并报告失败。
- 原文件已有视频和音频时直接保存，避免重复混音或转码。

无损合并的核心为 `-map 0:v:0 -map 1:a:0 -c copy`。流映射指定使用哪条轨，stream copy 保留原压缩数据，见 [FFmpeg 文档](https://ffmpeg.org/ffmpeg.html#Stream-selection)。输出仍需要 FFprobe 验证，不能只根据 FFmpeg 退出码宣告视频完整。

该作品的 HEVC 存在 B 帧解码重排。原适配器提前写入空 `moov` 时，重新封装可能产生不正确的起始偏移；现改为 `frag_keyframe+delay_moov+default_base_moof`，在获知首批包时间戳后写初始化信息，保留音视频同步。对通过管道读取的输出，FFprobe 使用最多 30 秒的初始分析时间和 16 MiB 探测缓冲，避免首个视频片段较长时漏判 AAC profile。原先的起始时间、时长、编码与包数量检查全部保留，并增加真实 B 帧样本回归测试。相关选项见 [FFmpeg MP4 封装说明](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv)。

## 当前环境中特别处理的网络问题

本机系统 DNS 返回 `198.18.*` Fake-IP，原工程的公网地址策略会拒绝该地址。浏览器能播放而 Node 下载失败在这里属于本地网络适配问题，不能解释成抖音禁止下载。

CLI 在遇到 Fake-IP 时查询阿里公共 DNS 的 HTTPS 接口获取公网地址，随后继续由原地址策略校验；不放开内网地址、不关闭 TLS 校验。解析结果在同一次运行中固定，以减少 Range 请求切换到不同 CDN 节点造成的版本验证失败。

## 可验证的交付范围

自动测试覆盖真实 Electron MSE 捕获、限长 HTTP Range 下载、字节一致性、H.264/AAC 合并、完整 MP4、单独音频、纯视频提示、403、大小限制、取消、参数歧义和 DNS 地址约束。运行产生的 `capture.json` 与 `result.json` 分别保存页面观察摘要和文件验证结果。

本工具没有实现所有抖音页面、登录状态或流媒体格式的通用解析；不保证以后每个作品仍使用相同路径结构。
