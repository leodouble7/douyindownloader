---
version: alpha
name: "视频下载"
description: "面向普通用户的链接下载、直接保存与失败恢复工具"
colors:
  background: "#101521"
  surface: "#182131"
  inset: "#141c2b"
  border: "#2d3a50"
  primary: "#8ab4ff"
  primary-hover: "#accaff"
  text: "#e6edf7"
  muted: "#aab8cb"
  subtle: "#8999b0"
  success: "#7eddb2"
  audio: "#bcacf3"
  danger: "#ffaba8"
  on-primary: "#12233e"
typography:
  sans:
    fontFamily: '"PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  mono:
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
rounded:
  control: "8px"
  panel: "16px"
spacing:
  section-gap: "24px"
  page-max: "none"
components:
  button:
    height: "40px"
  input:
    minHeight: "46px"
  progress:
    height: "6px"
---

# 视频下载设计规范

## Overview

面向中文桌面用户，唯一主流程是粘贴抖音链接、选择本地保存目录、查看下载与合并结果。用户已确认 Electron + React 单窗口方案。语言为 zh-CN；没有其他市场或语言需求。

延续工程启动页的深蓝背景、浅蓝重点色与柔和边框。单页上方常驻链接、保存位置和下载/取消按钮；下方原位显示内容选择、总进度和结果。视频浅蓝、音频淡紫的双轨技术明细收进「下载详情」。没有营销首屏、大数字装饰或无功能导航。

## Token ownership and mapping

`src/renderer/styles.css` 的 `:root` 是运行时颜色及字体的唯一来源，本文镜像实际值。`colors.KEY` 对应 `--color-KEY`；`rounded.control/panel` 对应 `--radius-control/panel`；字体对应 `--font-body/--font-data`。组件只消费 CSS 变量。修改颜色必须同时更新两处；`scripts/verify-design.cjs` 检查颜色和圆角漂移。

滚动条使用 `--scrollbar-thumb/#42536d`、`--scrollbar-hover/#647c9e`、`--scrollbar-active/#8ab4ff`、`--scrollbar-track/#141c2b`，全局应用标准属性与 Chromium 后备样式；系统强制颜色模式保留可操作性。

## Typography

中文系统字体承载正文与标题，避免外部字体加载导致布局变化。标题 24px/600，正文 14px，标签和按钮 12–13px，辅助文字 10–12px。技术数字和速度使用等宽字体，默认保存路径使用正文字体。长标题与路径换行；输入区有内部滚动，清空按钮可通过键盘操作。

## Layout

内容直接铺在原生桌面窗口中，不再使用固定宽度、居中边框或模拟窗口。原生标题栏负责应用名称；页面保留屏幕阅读器标题，不重复显示第二条标题栏。常驻表单直接放在页面背景上，下方当前下载区域用分隔线与间距区分；下载卡片只承担内容分组。桌面页面内边距为 28px 32px 32px，窄屏为 24px 20px。所有尺寸使用文档自然滚动，选择操作位于列表下方的正常文档流中，没有嵌套滚动区或独立页面。原型的评审导航和演示控制不进入产品。

输入字段错误各自保留高度；任务页始终显示完整保存路径并可换行；表单路径可聚焦横向查看。状态变化不切换页面、不抢走焦点或重置滚动。运行中表单显示实际执行的原链接和目录；空闲时恢复下一次编辑草稿。

## Components and behavior

- Form: `App.tsx` 拥有字段、关联标签、错误文本与首个错误焦点；提交使用 `noValidate`。平台原生目录对话框由主进程控制。
- Buttons: `.button` 是统一样式。主操作浅蓝实心、次操作描边。悬停、键盘焦点、按下和禁用均定义；忙碌时防止重复提交。主按钮在运行时变为取消，取消点击阻止原生表单默认提交，避免状态切换后误触发再次开始。
- Progress: `DownloadProgress.tsx` 为单项和队列统一按真实字节汇总总进度；只有所有轨道大小已知时才显示百分比。「下载详情」内使用 `MediaProgress.tsx` 展示逐轨大小和速度。合并、校验统一显示「正在保存」。
- Candidates: `MediaSelection.tsx` 拥有目标作品的简洁清晰度选择与通用资源列表两个变体。抖音链接确认作品后只显示真实标题、清晰度下拉框与「下载视频」，不显示勾选、全选或手动音频；单版本由后端直接下载。未确认归属时显示失败提示。通用采集测试/资源模式为 checkbox 列表，默认不选；一项自动使用 single API，多项使用 batch API，每组一个版本、每批最多 100 项。详情按行展开；实际多版本使用原生 select，接受系统弹层几何及键盘行为。手动音频为「声音设置」折叠区内的原生 radio，同一音频组的所有版本只允许分配给一个视频。未知关系用视频/音频编号命名，列表顶部只保留一次「页面中可能有其他视频」提醒；不猜测音画对应关系。
- Queue: `DownloadQueue.tsx` 为每项保留进度、结果与错误，按顺序执行，一项失败继续后续。结果页失败项优先，重试为主要操作；活动任务禁用打开结果和重复重试，表单下方就近说明开始新下载后旧任务重试信息将失效。取消停止当前和待处理项，完成项保留；重试只执行所选失败/取消项。重试凭证只留主进程内存 10 分钟，过期或新解析后不可继续用旧资源。每项结果打开到其实际文件位置。
- Feedback: 字段错误用 alert，任务变化用 polite status；失败后保留输入与目录，允许重试；成功展示文件名、保存位置与“打开文件夹”。长技术错误收进「查看原因」。没有临时 toast 承载重要信息。
- Scrollbar: 所有应用滚动区域自动继承全局规范。
- Icons: 沿用本地 SVG 功能图标，功能按钮都有中文文本或 accessible name；不显示虚构封面。

## Motion and accessibility

只有状态等待图标和真实进度过渡采用动画，尊重 reduced-motion。键盘可操作所有按钮与 radio、checkbox、select，焦点高亮；不依赖颜色表达阶段或错误。强制颜色模式仍显示进度边界。单一深色主题，当前版本没有主题切换。

## Verification

`npm test -- --project renderer` 验证交互；`npm run test:e2e` 验证真实浏览器和 Electron；`npm run verify:design` 检查样式与本文的颜色、圆角一致。截图检查桌面、窄屏、加载、失败、候选和成功状态。premium-ui.json 指向本项目的实际命令与证据。

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Form | src/renderer/App.tsx | User-requested single-page flow; shared desktop API | Persistent input / active read-only request / retry | tests/unit/desktop-ui.test.tsx; tests/e2e/desktop.spec.ts |
| Scrollbar | src/renderer/styles.css | Root scrollbar tokens in DESIGN.md | Single document scroll owner at every width | Computed style and narrow viewport E2E |
| Table Selection | src/renderer/components/MediaSelection.tsx | Shared desktop API, approved V3 design | Generic capture only: unified checkboxes; at most 100 groups; reserved audio excluded | tests/unit/desktop-ui.test.tsx; tests/e2e/desktop.spec.ts |
| Select/Listbox | src/renderer/components/MediaSelection.tsx | Native platform popup; DESIGN.md selection rules | Confirmed work: quality only; generic capture: versions and manual audio radios | tests/unit/desktop-ui.test.tsx; tests/e2e/desktop.spec.ts |

## Reconcile drift — 2026-09-16

“最多选两项”现由已确认的单个/批量模式取代：单项仍最多两个合并输入，批量由多个独立任务组成。原双轨进度迁移到 MediaProgress 共享组件。颜色、字体、圆角保持不变。

## Reconcile drift — 第三版正式接入

已实现用户确认的全宽列表、行内详情、高级音频、独立底栏及失败优先流程，取代原左右双栏。颜色与字体 token 不变。原型能力边界依照 `src/shared/desktop.ts` 与 `src/main/desktop/download-service.ts`；真实下载事件驱动进度，单候选自动下载仍由后端决定。新建任务草稿独立于保留的旧结果，过期事件不会覆盖输入。

## Reconcile drift — 普通用户精简与直接保存

去掉编号步骤、双栏输入、来源上下文、每行重复的未知质量/归属标签和默认双轨参数；保留必要选择及声音设置。文件系统由 `src/main/desktop/save-download.ts` 负责：选定目录仅发布可见成品，系统临时目录承载抓取结果、分轨和报告，结束后清理；同名时排他创建带序号的文件，不覆盖。打开文件夹定位实际成品。旧版本的隐藏输出不自动迁移或删除。

## Reconcile drift — 单页与后台解析

用户明确要求所有功能同页，因此取消旧的表单/任务页切换与返回/新建按钮，复用现有选择、进度和结果组件在表单下原位更新。resultDirectory 与下次目录偏好分开保存；重试显示原任务输入，不误导用户。

默认后台隐藏、静音解析，保持页面运行并尝试播放视口内视频。没有可下载媒体或页面加载失败时在同页提示；只有用户点击「打开抖音网页重试」才显示辅助网页，不自动处理登录或验证码。


## Reconcile drift — 按链接确认作品

用户确认只下载链接对应作品。主进程从作品 ID、结构化播放地址以及 audioFileId → fileId 关系确定归属，排除预加载和特效；同一文件的已完成请求合并，不凭大小、顺序或时长关联。地址只忽略已验证的播放器附加参数 temp/testst，签名、主机、路径及其他查询值仍须一致。分享短链接首次确认作品后锁定，用户后续切换视频不替换目标。元数据缺失或音频不匹配时同页报错，可重试。

目标作品只有一个已确认可下载版本时直接下载；多版本复用 MediaSelection 内的 WorkQualitySelection，默认选择已捕获版本中最高分辨率，只显示清晰度、估算大小与下载按钮，自动配对音频。真实标题来自作品资料；原来的多资源/批量选择仅保留为通用采集能力，抖音解析失败不回退到该列表。颜色、字体、目录规则和单页布局不变。


## Reconcile drift — 去掉窗口内的模拟窗口

用户指出“大窗口套小窗口”。移除 app-shell 的居中限宽、圆角边框、外层留白及重复可见标题栏；表单取消整块卡片外框。只保留原生窗口、直接铺开的输入区域和下方下载内容卡片。文档滚动、字段错误预留空间、长路径换行及所有操作保持一致。
