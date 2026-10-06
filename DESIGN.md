---
name: Pi Remote（macOS 助手）
description: 暖白与深绿的原生桌面连接台，菜单栏常驻，服务 Relay 连接与 Claude 本地服务。
colors:
  canvas: "#F7F8F5"
  sidebar: "#EEF2EC"
  surface: "#FFFFFF"
  surface-hover: "#E8EEE6"
  border: "#DCE3D9"
  control-border: "#7A877D"
  text-primary: "#202A24"
  text-secondary: "#59665E"
  text-tertiary: "#657269"
  accent: "#216B52"
  primary-fill: "#216B52"
  on-primary: "#FFFFFF"
  warning: "#845810"
  danger: "#B23F3B"
  focus-ring: "#216B52"
  qr-paper: "#FFFFFF"
  canvas-dark: "#151B18"
  sidebar-dark: "#1C2420"
  surface-dark: "#242E28"
  surface-hover-dark: "#2D3931"
  border-dark: "#405046"
  control-border-dark: "#798F80"
  text-primary-dark: "#EDF2EA"
  text-secondary-dark: "#B0BDB3"
  text-tertiary-dark: "#9AADA0"
  accent-dark: "#94D9B4"
  primary-fill-dark: "#94D9B4"
  on-primary-dark: "#132C20"
  warning-dark: "#E8BC6A"
  danger-dark: "#F0A09A"
  focus-ring-dark: "#94D9B4"
typography:
  brand:
    fontFamily: "system-ui (SF Pro; 中文回退 PingFang SC)"
    fontSize: "17px"
    fontWeight: 600
  hero:
    fontFamily: "system-ui (SF Pro; 中文回退 PingFang SC)"
    fontSize: "28px"
    fontWeight: 600
  section:
    fontFamily: "system-ui (SF Pro; 中文回退 PingFang SC)"
    fontSize: "17px"
    fontWeight: 600
  body:
    fontFamily: "system-ui (SF Pro; 中文回退 PingFang SC)"
    fontSize: "13px"
    fontWeight: 400
  control:
    fontFamily: "system-ui (SF Pro; 中文回退 PingFang SC)"
    fontSize: "13px"
    fontWeight: 500
  caption:
    fontFamily: "system-ui (SF Pro; 中文回退 PingFang SC)"
    fontSize: "12px"
    fontWeight: 400
  mono:
    fontFamily: "ui-monospace (SF Mono)"
    fontSize: "11.5px"
    fontWeight: 400
rounded:
  control: "10px"
  segment: "12px"
  segment-plate: "9px"
  qr-tray: "14px"
  stage: "20px"
components:
  button-primary:
    backgroundColor: "{colors.primary-fill}"
    textColor: "{colors.on-primary}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    height: "40px"
  button-primary-dark:
    backgroundColor: "{colors.primary-fill-dark}"
    textColor: "{colors.on-primary-dark}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    height: "32px"
    padding: "0 14px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-hover}"
  button-link:
    textColor: "{colors.accent}"
    height: "28px"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    height: "38px"
    padding: "0 10px"
  segmented-choice:
    backgroundColor: "{colors.surface-hover}"
    rounded: "{rounded.segment}"
    padding: "3px"
  segmented-choice-plate:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.segment-plate}"
    height: "32px"
  status-badge:
    textColor: "{colors.accent}"
    typography: "{typography.caption}"
    rounded: "999px"
    height: "26px"
    padding: "0 10px"
  notice:
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
    padding: "12px"
  pairing-stage:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.stage}"
    padding: "24px"
  qr-tray:
    backgroundColor: "{colors.qr-paper}"
    rounded: "{rounded.qr-tray}"
    padding: "20px"
---

# Design System: Pi Remote（macOS 助手）

> **来源说明。** 这是一个 SwiftUI + AppKit 的原生 macOS 应用，没有 CSS、Tailwind 或网页组件，所以 `document.md` 的 Scan 模式（依赖 CSS 自定义属性、`getComputedStyle`、浏览器渲染）**不适用**。本文的每个 token 都手工取自 Swift 源码，没有运行任何网页检测：
> - `macos/Sources/PiRemote/Theme.swift`：颜色（`adaptive(light, dark)`）、`Theme.Font`、`Theme.Radius`、三种按钮样式。
> - `macos/Sources/PiRemote/Motion.swift`：动效常量。
> - `macos/Sources/PiRemote/Views/Components/FormComponents.swift`：StatusBadge、SectionTitle、InputField、FieldBox、SegmentedChoice、Notice。
> - `macos/Sources/PiRemote/Views/Components/PairingCodeView.swift`：二维码托盘与占位。
> - 状态色映射（`StatusTone`）读自 `Presentation/ConnectionPresentation.swift`，仅用于说明色彩用法。
>
> 深色取值写成带 `-dark` 后缀的键，因为 DESIGN.md 前置元数据一个键只能有一个值；浅色键与 Swift 中的 token 同名（`textPrimary` → `text-primary`）。`accent`、`primary-fill`、`focus-ring` 在代码里是三个独立 token，当前取值恰好相同，所以这里也保留三项而不合并。**颜色之外的「Creative North Star」命名与描述性语言是对已有实现的概括，不是用户确认过的品牌词汇**（见 Overview）。
>
> 没有写入的内容：代码里没有间距刻度 token（间距是视图里的字面量），所以前置元数据没有 `spacing`；没有字体文件（用系统字体）；没有行高与字距 token。

## Overview

**Creative North Star: "安静的连接台"（The Quiet Connection Desk）**

这个名字是对 `macos/FRONTEND-REWRITE-PLAN.md` 中「暖白与深绿的原生桌面连接台」的提炼，属于**假设**，未经用户确认。它描述的是一件常驻菜单栏、偶尔打开的操作工具：画面以实色表面、细边界和一个主要动作建立层级，状态靠图标加文字说清楚，而不是靠装饰。

整体是暖调的灰白底（`#F7F8F5`）配深绿操作色（`#216B52`）。深色模式把画布压成带绿的近黑（`#151B18`），并把主色翻转成浅薄荷（`#94D9B4`），所以「主按钮」在深色里是浅色填充配深色文字。颜色的暖度和绿相贯穿所有中性色，没有纯灰、没有纯黑文本（最深文本是 `#202A24`）。字体完全使用系统字体，识别度来自配色、π 标志和构图，而不是字体。

动效很少，且每一个都对应一次真实状态变化；开启「减弱动态效果」后，位移与缩放被去掉，只保留 0.1 秒的淡入。

**Key Characteristics:**
- 暖白与深绿，浅色与深色都是完整设计，不是反色。
- 实色表面分层，不用玻璃材质；只有浅色模式的扫码舞台有极轻的阴影。
- 单一强调色：深绿（浅色）/ 薄荷（深色）同时承担「主操作、选中、成功」。
- 圆角连续曲线（`.continuous`），控件 10、分段 12、舞台 20。
- 状态一律图标 + 文字，颜色只是补充。
- 二维码永远黑码白底，不随主题变化。

## Colors

一个绿色主调，加琥珀与红两个状态色，其余都是带一点绿的暖灰。

### Primary
- **深林绿 / 薄荷绿（Forest Green / Mint）**：浅色 `#216B52`，深色 `#94D9B4`。在代码里是 `accent`（链接、选中、成功图标）、`primaryFill`（主按钮底色）、`focusRing`（键盘焦点和输入框聚焦边框）三个 token，目前同值。主按钮上的文字用 `onPrimary`：浅色 `#FFFFFF`，深色 `#132C20`。

### Secondary
- 无。项目只有一个强调色。

### Tertiary
- **琥珀（Amber）**：`warning`，浅色 `#845810`，深色 `#E8BC6A`。用于「连接恢复中」、需要处理的提示。
- **警示红（Signal Red）**：`danger`，浅色 `#B23F3B`，深色 `#F0A09A`。用于错误、输入校验失败的边框与说明文字。

### Neutral
- **画布（Canvas）** `canvas`：浅 `#F7F8F5` / 深 `#151B18`。窗口主区域；二维码未就绪时的占位底也用它。
- **侧栏（Sidebar）** `sidebar`：浅 `#EEF2EC` / 深 `#1C2420`。左侧配置栏，略深于画布。
- **表面（Surface）** `surface`：浅 `#FFFFFF` / 深 `#242E28`。输入框、次要按钮、扫码舞台、分段控件选中板。
- **表面悬停（Surface Hover）** `surfaceHover`：浅 `#E8EEE6` / 深 `#2D3931`。次要按钮悬停与按下底色；分段控件的凹槽底色。
- **装饰边界（Border）** `border`：浅 `#DCE3D9` / 深 `#405046`。舞台描边、占位虚线框——只做装饰分隔，不承担控件识别。
- **控件边界（Control Border）** `controlBorder`：浅 `#7A877D` / 深 `#798F80`。输入框和次要按钮的描边，需要看得出控件的地方用它。
- **主文本（Text Primary）** `textPrimary`：浅 `#202A24` / 深 `#EDF2EA`。
- **次文本（Text Secondary）** `textSecondary`：浅 `#59665E` / 深 `#B0BDB3`。说明文字、未选中的分段项。
- **三级文本（Text Tertiary）** `textTertiary`：浅 `#657269` / 深 `#9AADA0`。页脚一类的次要元数据。
- **二维码纸（QR Paper）** `qrPaper`：`#FFFFFF`，两种主题相同。

### Named Rules
**The One Voice Rule.** 只有一个强调色。主操作、选中状态、成功标记都用同一个绿；不要为新服务（例如 Claude）再引入第二个品牌色。

**The Status Is Not Color Alone Rule.** `StatusTone` 的五种语气（neutral、working、success、warning、danger）都配有 SF Symbol（`circle`、`arrow.left.arrow.right`、`checkmark.circle.fill`、`arrow.clockwise`、`exclamationmark.circle.fill`）。`working` 与 `success` 当前同为强调绿，区分它们的是图标与文字，不能删掉图标。

**The Paper Stays White Rule.** 二维码底色 `qrPaper` 在深色模式也是白的，码图是黑白的，不着色、不做渐变、不叠 Logo。

**The Tint Ladder Rule.** 状态色的背景用语气色的透明度表达：徽标底 12%，提示框底 8%、描边 35%。不要为每种状态另造一组背景色。

## Typography

**Display / Body Font:** 系统字体（SwiftUI `Font.system`，拉丁字符是 SF Pro，中文由系统回退，通常是 PingFang SC）。
**Label/Mono Font:** 系统等宽（`design: .monospaced`），用于诊断日志、路径一类。

**Character:** 中性、紧凑的系统界面字体。标题与正文的区分靠字重（semibold 与 regular/medium）和 13→17→28 的字号跳跃，不靠字体切换。

### Hierarchy
- **Hero**（semibold 28）：状态舞台主标题，例如「已准备好，随时连接」。
- **Brand / Section**（semibold 17）：顶部栏品牌名、区域标题（`SectionTitle`，带标题无障碍特征）、二维码卡片标题。`brand` 与 `section` 在代码里是两个 token，当前同值。
- **Control**（medium 13）：按钮文字、输入标签、提示标题。
- **Body**（regular 13）：正文、输入框内文字。
- **Caption**（regular 12；`caption.weight(.medium)` 用于徽标与链接按钮）：说明、帮助文字、错误文字、页脚。
- **Mono**（regular 11.5，等宽）：日志与路径。

代码里没有定义行高与字距，沿用系统默认值。

### Named Rules
**The System Type Rule.** 不引入自带字体。品牌识别来自 π 标志、构图和绿色，不来自字体。

**The Fixed Size Rule.** `Theme.Font` 是固定点数的字号（没有 `relativeTo:`），所以不随系统文字缩放变化。新界面如需支持动态字号，要先在这里作为一次明确的改动做出，而不是在个别视图里偷偷用 `.dynamicTypeSize`。（这是对现状的记录，不是对该做法的评价。）

## Layout

左侧固定宽度的配置栏加右侧弹性的状态舞台，底部诊断区跨栏，这些尺寸来自 `FRONTEND-REWRITE-PLAN.md` §4（左栏 340 pt、顶部栏 56 pt、折叠诊断 36 pt），不是 token；这里只列出在组件源码中真实出现的数值。

- 表单字段内部：标签到控件 8 pt（`InputField` 的 `VStack` 间距）；输入框水平内边距 10 pt；高度 38 pt。
- 按钮：主按钮高 40 pt；次要按钮高 32 pt（`fill` 时 40 pt），水平内边距 14 pt；链接按钮最小高 28 pt。
- 分段控件：选项间距 2 pt，外围内边距 3 pt，选项高 32 pt（紧凑 28 pt）。
- 徽标：高 26 pt，水平内边距 10 pt，图标与文字间距 6 pt。
- 提示框：内边距 12 pt，图标与内容间距 10 pt，标题与正文间距 4 pt。
- 扫码舞台：内边距 24 pt，最大宽度 440 pt，内部垂直间距 14 pt；码图目标边长 232 pt，占位框为 272 pt 见方（232 + 40）。
- 码图按整数设备像素对齐（`snapped`），静区至少 20 pt，且不少于 4 个模块宽。

代码里没有统一的间距刻度，视图里是字面量；新增界面请沿用上面这些已出现的值，不要新造相近值（例如 9、11、13）。

## Elevation & Depth

以**色调分层**为主，几乎没有阴影：画布 → 侧栏 → 表面是三级由暗到亮（深色模式则由暗到稍亮）的底色。深度由底色差与 1 pt 边界承担。

### Shadow Vocabulary
- **舞台环境阴影**（`black 5% 不透明度, radius 20, y 6`，仅浅色模式；深色为 0）：只在扫码舞台，让它从画布浮出一点点。深色模式靠描边（1 pt `border`）区分，浅色描边仅 0.5 pt。
- **分段控件选中板阴影**（`black 6% 不透明度, radius 2, y 1`）：让选中板从凹槽里浮起。

### Named Rules
**The Flat-By-Default Rule.** 表面静止时是平的。阴影只属于上面两个词汇；不要给按钮、输入框、提示框加阴影。

**The No Glass Rule.** 不用 `Material`/毛玻璃做表单和二维码的底；稳定实色。（方案 §3.1 只允许窗口顶部使用轻量系统材质，代码里目前未使用。）

## Shapes

形状语言是**连续曲线的圆角矩形**（`RoundedRectangle(..., style: .continuous)`）。圆角随容器层级递增：控件与提示框 10，分段控件凹槽 12，选中板 9（= 凹槽圆角 − 3，与 3 pt 内边距同心），码图白色托盘 14，扫码舞台 20。状态徽标是完整胶囊（`Capsule`）。

边界：输入框和次要按钮 1 pt 描边；输入框聚焦或校验失败时升到 2 pt。占位框用 1 pt、5-5 虚线描边，表示「这里将来有内容」。二维码托盘的圆角只属于白色托盘本身，不侵入码图和静区。

## Components

### Buttons
- **Shape:** 连续圆角 10 pt。
- **Primary**（`PrimaryButtonStyle`）：实心 `primaryFill`，文字 `onPrimary`，Control 字体；撑满宽度，最小高 40 pt。按下时亮度 −0.06、缩放 0.985（减弱动态效果时不缩放）；禁用时整体 45% 不透明度。
- **Secondary**（`SecondaryButtonStyle`）：底色 `surface`，悬停或按下 `surfaceHover`，1 pt `controlBorder` 描边（70% 不透明度），文字默认 `textPrimary`（可传入 `tint`）；高 32 pt，`fill` 时撑满宽度、高 40 pt。禁用 50% 不透明度。
- **Link**（`LinkButtonStyle`）：只有文字，`accent` 色，Caption 字号加中等字重；最小高 28 pt；按下 70% 不透明度，禁用 45%。用于「从 .env 导入」之类的次级入口。

### Status Badge
- **Style:** 胶囊，高 26 pt；图标（11 pt semibold SF Symbol）+ 文字（Caption 中等字重），前景用语气色，底色是语气色 12% 不透明度。
- **Accessibility:** 合并为一个元素，标签「状态：…」。

### Segmented Choice
- **Style:** 等宽选项，凹槽底色 `surfaceHover`，选中项是 `surface` 底的圆角板（带 `black 6%` 小阴影），选中文字 `textPrimary`，未选中 `textSecondary`。
- **Motion:** 选中板用 `matchedGeometryEffect` 滑动，时长取 `Motion.modeSwitch`（0.18 秒，减弱动态效果时取 0.1 秒淡入）。
- **Accessibility:** 每项是按钮，选中项带 `isSelected`；整体带 `accessibilityName`。

### Inputs / Fields
- **Style（`FieldBox`）:** 无边框原生文本框外套 `surface` 底、10 pt 圆角、高 38 pt、水平内边距 10 pt；描边 1 pt `controlBorder`。
- **Focus:** 描边变 2 pt `focusRing`，过渡 `Motion.hover`（0.12 秒）。
- **Error:** 描边变 2 pt `danger`；错误文字在字段下方，用 `exclamationmark.circle` 图标 + `danger` 色 Caption；帮助文字用 `textSecondary`。出错时帮助文字让位给错误文字。
- **Disabled:** 底色 60% 不透明度、描边 50%。
- **Field group（`InputField`）:** 标签（Control 字体）→ 控件 → 错误或帮助文字，间距 8 pt。

### Notice
- **Style:** 10 pt 圆角，底色是语气色 8%，描边 1 pt 语气色 35%；左侧图标按语气（danger 为填充三角警示、warning 为填充感叹圆、其他为信息圆）；标题 Control、正文 Caption `textSecondary`，正文可选择文字；可带一个 Link 按钮。

### Section Title
- 17 pt semibold `textPrimary`，带标题无障碍特征。

### Pairing Stage（签名组件）
- **Character:** 全界面唯一的「舞台」。扫码时是一块安静的白卡，里面一张白底黑码。
- **Shape / Fill:** 20 pt 圆角，`surface` 底，内边距 24 pt，最大宽度 440 pt；描边 `border`（浅 0.5 pt、深 1 pt）；浅色模式有舞台环境阴影。
- **Has code:** 标题「用手机扫码」+ 说明；码图：`interpolation(.none)`、整数像素对齐、白色托盘 14 pt 圆角、静区 ≥ 20 pt；页脚「连接码包含访问密钥，仅供自己的设备使用」（`textTertiary`）。
- **No code:** 标题「手机连接码」+ 占位说明；同尺寸占位框（`canvas` 底、14 pt 圆角、1 pt 虚线 `border` 描边）+ 40 pt 细线 SF Symbol（取 `placeholderTone` 颜色）。真实二维码与占位之间**立即切换**，不做淡出。
- **Accessibility:** 码图标签「手机连接二维码，包含连接凭据」；占位对辅助技术隐藏。

### Motion（与组件一起使用）
`Motion.swift` 定义的全部时长：入场 0.24 秒 easeOut；模式切换 0.18 秒 easeInOut；按下 0.09 秒 easeOut；释放 0.14 秒 easeOut；悬停 0.12 秒 easeOut；成功 0.22 秒 easeOut；交叉淡入 0.16 秒 easeInOut；展开 0.2 秒 easeInOut；反馈 0.12 秒 easeOut；路线循环周期 1.4 秒。`Motion.resolved` 在「减弱动态效果」时统一替换为 0.1 秒 easeOut。`WindowVisibilityReader` 用窗口遮挡与最小化通知判断窗口是否可见，循环动画只在窗口可见时运行。

## Do's and Don'ts

### Do:
- **Do** 通过 `Theme` 取色，所有颜色都用 `adaptive(light, dark)` 定义，浅色与深色成对给出；新增 token 也要同时给两套取值。
- **Do** 状态一律用「图标 + 文字」，颜色只作补充（`StatusTone`）。
- **Do** 主按钮用 `PrimaryButtonStyle`（40 pt 高、10 pt 圆角），次要动作用 `SecondaryButtonStyle`，文字入口用 `LinkButtonStyle`；一个区域只放一个主按钮。
- **Do** 用 `FieldBox` 和 `InputField` 做所有文本输入；聚焦 2 pt `focusRing`，错误 2 pt `danger`，错误文字紧跟字段。
- **Do** 所有动画取自 `Motion`，并通过 `Motion.resolved` 与 `accessibilityReduceMotion` 配合；循环动画只在窗口可见时运行。
- **Do** 二维码保持黑码白底、整数像素对齐、静区 ≥ 20 pt 且 ≥ 4 个模块宽。
- **Do** 新增 Claude 本地服务界面时沿用同一套 Notice、StatusBadge、按钮层级和 `StatusTone`，让它与 Relay 连接看起来是同一个 App。

### Don't:
- **Don't** 在视图中写死十六进制色值或 `Color.black/white` 以外的字面颜色；唯一的白色字面量是 `qrPaper`。
- **Don't** 为第二个服务引入第二个强调色。
- **Don't** 给二维码做淡出、缩放、旋转、模糊、半透明或叠加 Logo；失效时立即换成同尺寸占位。
- **Don't** 给按钮、输入框、提示框加阴影；阴影只属于扫码舞台和分段控件选中板。
- **Don't** 在表单和二维码底下使用 `Material` 毛玻璃。
- **Don't** 用 `border`（装饰分隔色）当作控件的识别边界；需要看得出控件的描边用 `controlBorder`。
- **Don't** 在循环动画里驱动整页刷新，或在窗口不可见时继续循环。
- **Don't** 因为「看起来更协调」就改圆角、字号、字重的既有数值；这些数值是 `Theme` 里唯一的来源。
