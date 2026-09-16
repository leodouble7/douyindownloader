---
version: alpha
name: Media Security Lab
description: A Chinese forensic inspection desk with a chronological evidence spine and an isolated target preview well.
colors:
  primary: "#076e66"
  primary-hover: "#07574f"
  primary-soft: "#e4f2ef"
  background: "#eef2f5"
  surface: "#ffffff"
  surface-muted: "#f5f7f8"
  ink: "#172b35"
  muted: "#526570"
  line: "#cdd7dc"
  warning: "#895714"
  warning-soft: "#fff3db"
  danger: "#b23736"
  danger-soft: "#fceceb"
  well: "#152b35"
  well-text: "#d5e1e6"
  focus: "#145bca"
  scroll-thumb: "#82949e"
  scroll-track: "#e7edef"
  scroll-hover: "#607a87"
  scroll-active: "#365b6c"
typography:
  sans:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
  mono:
    fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace'
rounded:
  DEFAULT: "6px"
  sm: "3px"
spacing:
  section-gap: "22px"
  page-max: "1920px"
components:
  button:
    background: "{colors.primary}"
    foreground: "{colors.surface}"
    hover: "{colors.primary-hover}"
    selected: "{colors.primary-soft}"
    focus: "{colors.focus}"
    danger: "{colors.danger}"
    danger-hover: "{colors.danger-soft}"
  panel:
    background: "{colors.surface}"
    foreground: "{colors.ink}"
    muted-text: "{colors.muted}"
    border: "{colors.line}"
    inset: "{colors.surface-muted}"
  input: {}
  select: {}
  timeline: {}
  table: {}
  status:
    warning: "{colors.warning}"
    warning-background: "{colors.warning-soft}"
  drawer: {}
  target-preview:
    background: "{colors.well}"
    foreground: "{colors.well-text}"
  scrollbar:
    thumb: "{colors.scroll-thumb}"
    track: "{colors.scroll-track}"
    hover: "{colors.scroll-hover}"
    active: "{colors.scroll-active}"
---

# Media Security Lab Design System

## Overview

### Creative North Star

A forensic inspection bench: cool gray working surface, white evidence sheets, a deep recessed preview well, and a thin numbered spine that connects observations to conclusions. A useful technical instrument, with the restraint of printed lab records.

### Product context and register

- Audience and primary job: authorized media security reviewers inspecting a single public playback page and reproducing its server access conditions.
- Target market and evidence: no geographic market promise; Chinese language and desktop inspection requirements come from `docs/superpowers/specs/2026-09-15-media-security-lab-design.md`.
- Locale: zh-CN copy, local device timezone explicitly named in the footer, Gregorian dates, technical identifiers preserved only when safe. No remote font dependency.
- Usage scene: extended desktop sessions on Windows and macOS, compact information density, inspectable detail, deliberate download approval.
- Register: PRODUCT renderer; PLATFORM main process. The target is a separate untrusted Electron WebContentsView.
- Memorable signature: the narrow numbered evidence spine doubles as a chronological index and finding navigation destination.
- Restraint: familiar form controls, clear rows, no invented data graphics or decorative dashboards.
- Anti-references: neon dark dashboards, excessive pill cards, oversized empty panels, security claims inferred from tool failures.
- Token ownership/runtime mapping: this file documents the canonical visual tokens, manually mapped by exact role names in `src/renderer/styles.css :root`; `rounded.DEFAULT` maps to `--radius`, `rounded.sm` to `--radius-sm`, typography maps to `--font-sans` and `--font-mono`. No theme generator exists. `tests/unit/design-tokens.test.ts` is the drift gate. See `UX-CONTRACT.md` for behavior ownership.

## Colors

`background` is the cool bench, `surface` is paper and `surface-muted` is an inset evidence field. `ink` and `muted` supply text hierarchy. `line` separates regions without shadows. `primary` is restrained teal for safe actions and verified results; `warning` marks incomplete evidence and encryption; `danger` marks cancellation controls, failures and explicit denials. All statuses also use written labels. `well` and `well-text` define only the target aperture. `focus` is a 3 px visible keyboard outline. Scrollbar tokens have separate normal, hover and active values. Light mode is canonical; forced colors preserves native system contrast.

## Typography

Offline system fonts support simplified Chinese and mixed technical text. Body text is 14 px with line height 1.6. Dense evidence uses 11–12 px text with 1.65–1.9 line height; 10 px annotation is reserved for short noncritical timestamps and indices. Main headings use 25–32 px, medium weight. Mono text is limited to numeric progress, times, hashes and request details. Long values wrap. No automatic uppercase transformation of Chinese copy, font fetching or font swaps.

## Layout

The app is document-scrolled with a maximum width of 1920 px. Header, reserved status band and footer establish stable chrome. Desktop workbench uses three columns at 1180 px and above; 800–1179 px uses two columns with the inspector below; narrower viewports use one column. Panels retain explicit empty/loading footprints. Timeline and probe matrix have their own bounded vertical scroll regions; new-run form remains naturally tall. Global visible scrollbars and stable scrollbar gutters apply to owned surfaces. Page padding is 32 px desktop, 24 px medium and 18 px narrow. No horizontal page scroll is permitted. The 238 px high preview aperture is hidden by main when outside the safe visible region.

## Elevation & Depth

Borders and tonal layers convey depth; no floating glass or large drop shadows. The target preview is a native child surface inside its measured aperture. Product overlays must never be placed above that native surface. The bottom progress drawer is a persistent, nonmodal document region, without focus trap or floating positioning.

## Shapes

Panels use `rounded.DEFAULT` (6 px), controls and technical fields use `rounded.sm` (3 px). Round marks are reserved for the tiny status indicator and the evidence spine node. Most data is presented as compact rows rather than pill cards. Dividers are 1 px.

## Components

### Foundational visual states

Every action has default, hover, keyboard focus, pressed, disabled and pending treatment. Busy text occupies the same button geometry. A reserved status band holds global feedback with `aria-live`; field messages remain inline. Empty, loading, partial, failure and cancelled states preserve the panel frame. Text communicates status independently of color. Native progress elements represent measured or indeterminate progress honestly.

### Buttons and actions

Solid teal is primary; outlined neutral is secondary; text/ghost is tertiary. Cancellation uses an outlined danger action. Targets are 40 px for main buttons and at least 28 px for dense evidence actions. Full retrieval requires full-download mode, authorization confirmation and an explicit workbench click. The action group stays outside the target aperture.

### Navigation and data display

Four native-button navigation destinations share a single header. Disabled workbench/report destinations explain their state through the absence of a selected run. Timeline loads 60 latest events, with explicit load-earlier controls. History is bounded to the latest 200 persisted runs and paginated by 20. Tables are semantic read-only tables; evidence links are real buttons. Findings link to highlighted, expanded timeline records. Status labels are consistent across history, workbench and results.

### Forms and overlays

Forms use `noValidate`, explicit labels, associated error/help IDs, and first-error focus. Native selects are intentionally accepted for asset selection and 1–4 concurrency, including OS-owned popup geometry and keyboard behavior. The URL field is masked by default with an accessible show/hide action. Directory choice is platform-native and output authority is main-side. There are no custom modal overlays; the persistent download region is nonmodal. New-run draft stays mounted when navigating history. No browser alert, confirm or prompt.

### Iconography

Small text-based arrows and a technical reticle are used sparingly, with visible labels or accessible names. Icons never replace the written outcome. No external icon font or image is required.

### Motion

The UI uses no decorative animation. Pressed controls shift by 1 px; reduced motion removes this movement. Evidence navigation uses immediate scrolling. No essential information depends on animation.

### Content and data visualization

Chinese copy states what happens and why, then presents modified conditions, server response and decision limits. Expandable evidence uses the headings 准备做什么 / 为什么 / 修改了什么 / 服务端返回 / 如何判定. Never label an execution failure as secure. No target-provided string is interpreted as markup. Verified Markdown and JSON are rendered as text. The evidence spine and native progress bars are the only necessary data visualizations.

## Do's and Don'ts

- Do keep conclusions linked to actual terminal evidence events.
- Do use the shared Status, Panel, Empty and button contracts across all four views.
- Don't transmit source identity tuples or raw request headers to the renderer.
- Don't cover product controls with the native target view or place product overlays above it.
- Don't replace inconclusive evidence with an absolute security claim.
