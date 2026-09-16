# Media Security Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows/macOS Electron desktop application that observes a single authorized public playback page, explains every capture and probe step, verifies media access controls, downloads accessible tracks, remuxes them, and produces evidence-backed Chinese reports.

**Architecture:** A sandboxed Electron BrowserView loads the target while the main process attaches through CDP to page, frame, worker, service-worker, network, runtime, and media events. Pure TypeScript services correlate media, generate bounded request probes, stream verified downloads, invoke FFmpeg/ffprobe, persist sanitized evidence in SQLite, and publish immutable `RunEvent` records to a React workbench.

**Tech Stack:** Electron, TypeScript, React, Vite/electron-vite, Vitest, Testing Library, Playwright, better-sqlite3, Zod, Zustand, fast-xml-parser, m3u8-parser, ffmpeg-static, ffprobe-static, electron-builder.

**Spec:** `docs/superpowers/specs/2026-09-15-media-security-lab-design.md`

## Global Constraints

- Support Windows x64, macOS x64, and macOS arm64.
- Accept one explicitly entered target page per run; do not crawl, enumerate IDs, or search a site.
- Support public pages without login, imported cookies, CAPTCHA handling, or credential collection.
- Do not bypass DRM, extract decryption keys, or download encrypted payloads as playable output.
- Run target pages with `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`.
- Never persist plaintext Cookie, Authorization, signatures, or token query values.
- Default probe concurrency is 4 and all long-running operations must support cancellation.
- Full-media retrieval requires the user-selected “完整下载验证” mode; other modes use bounded byte probes.
- Every browser, capture, probe, download, FFmpeg, verification, and reporting action emits a visible `RunEvent` before and after execution.
- A failed tool action is never reported as proof that media is secure.

---

## Planned File Structure

```text
package.json                         scripts, runtime/dev dependencies, electron-builder config
electron.vite.config.ts             main/preload/renderer build configuration
tsconfig.json                       shared TypeScript policy
vitest.config.ts                    node and jsdom projects
playwright.config.ts                packaged Electron end-to-end configuration
src/shared/contracts.ts             IPC and domain contracts
src/shared/schemas.ts               Zod validation for IPC boundaries
src/main/index.ts                    Electron lifecycle and secure windows
src/main/ipc.ts                      typed command/event IPC registration
src/main/runs/run-orchestrator.ts    run state machine and cancellation
src/main/runs/event-repository.ts    SQLite run/event persistence
src/main/browser/browser-controller.ts isolated target window lifecycle
src/main/browser/cdp-capture.ts      CDP attachment and normalized observations
src/main/browser/mse-instrumentation.ts safe MediaSource instrumentation source
src/main/media/media-correlator.ts   request/track/asset classification
src/main/media/playlist-parser.ts    HLS and DASH relationship extraction
src/main/probes/probe-planner.ts     bounded request mutation matrix
src/main/probes/probe-runner.ts      replay transport and evidence classification
src/main/download/range-plan.ts      validated byte-range planning
src/main/download/downloader.ts      streaming, resume, hashing, atomic completion
src/main/media/ffmpeg-adapter.ts     ffprobe and stream-copy remux
src/main/reports/finding-engine.ts   evidence-to-risk rules
src/main/reports/report-generator.ts JSON and Markdown reports
src/preload/index.ts                 narrow typed renderer bridge
src/renderer/main.tsx                React entry
src/renderer/App.tsx                 application routing and workbench shell
src/renderer/store/run-store.ts      renderer projection of immutable events
src/renderer/components/*            form, preview, timeline, tracks, probes, progress, report
src/renderer/styles.css              visual tokens and responsive desktop layout
lab/server.ts                        localhost target lab
lab/scenarios.ts                     deterministic access-control policies
lab/media.ts                         small FFmpeg-generated media fixtures
tests/unit/*                         pure domain tests
tests/integration/*                  lab, HTTP, download, FFmpeg tests
tests/e2e/*                          Electron workbench flows
docs/implementation-principles.md   delivered architecture and operation guide
docs/vulnerability-response.md      delivered control-by-control remediation guide
```

### Task 1: Secure Electron foundation and shared contracts

**Files:**
- Create: `package.json`
- Create: `electron.vite.config.ts`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/shared/contracts.ts`
- Create: `src/shared/schemas.ts`
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/main.tsx`
- Create: `src/renderer/App.tsx`
- Create: `src/renderer/styles.css`
- Test: `tests/unit/schemas.test.ts`

**Interfaces:**
- Produces: `RunMode`, `RunPhase`, `RunEvent`, `CapturedRequest`, `MediaAsset`, `MediaTrack`, `ProbeResult`, `DownloadArtifact`, `Finding`, `StartRunInput`, and `window.mediaLab`.

- [ ] **Step 1: Scaffold dependencies and scripts**

Create `package.json` with `dev`, `build`, `test`, `test:unit`, `test:integration`, `test:e2e`, `typecheck`, `lint`, and `package` scripts. Install Electron/React runtime packages and TypeScript, electron-vite, Vitest, Testing Library, Playwright, ESLint, electron-builder, better-sqlite3, Zod, Zustand, XML/HLS parsers, and FFmpeg locator packages. Commit the generated lockfile.

- [ ] **Step 2: Write the failing IPC schema tests**

```ts
import { describe, expect, it } from 'vitest';
import { startRunInputSchema } from '../../src/shared/schemas';

describe('startRunInputSchema', () => {
  it('accepts one authorized public HTTP target', () => {
    expect(startRunInputSchema.parse({
      targetUrl: 'https://media.example.test/watch/1',
      outputDirectory: '/tmp/media-lab',
      mode: 'standard',
      maxConcurrency: 4,
      authorizationConfirmed: true
    }).mode).toBe('standard');
  });

  it('rejects credentials in the target URL and missing authorization', () => {
    expect(() => startRunInputSchema.parse({
      targetUrl: 'https://user:secret@example.test/watch/1',
      outputDirectory: '/tmp/media-lab',
      mode: 'standard',
      maxConcurrency: 4,
      authorizationConfirmed: false
    })).toThrow();
  });
});
```

- [ ] **Step 3: Run the schema test and verify it fails**

Run: `npm run test:unit -- tests/unit/schemas.test.ts`

Expected: FAIL because `src/shared/schemas.ts` does not exist.

- [ ] **Step 4: Define exact shared contracts and validation**

```ts
export type RunMode = 'observe' | 'standard' | 'full-download';
export type RunPhase =
  | 'browser' | 'capture' | 'correlate' | 'probe'
  | 'download' | 'ffmpeg' | 'verify' | 'report';
export type StepStatus =
  | 'queued' | 'running' | 'succeeded' | 'denied'
  | 'warning' | 'failed' | 'cancelled';

export interface RunEvent {
  id: string;
  runId: string;
  sequence: number;
  timestamp: string;
  phase: RunPhase;
  action: string;
  purpose: string;
  status: StepStatus;
  inputSummary?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  conclusion?: string;
  relatedIds: string[];
}
```

Implement Zod schemas for every renderer-to-main command. Reject non-HTTP(S) URLs, embedded credentials, concurrency outside 1–4, missing authorization confirmation, and empty output paths.

- [ ] **Step 5: Build the secure application shell**

Create the main window with:

```ts
webPreferences: {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false
}
```

Expose only `startRun`, `cancelRun`, `chooseOutputDirectory`, `startDownload`, `exportReport`, and `onRunEvent` through preload. Render a minimal application shell that displays startup self-check status.

- [ ] **Step 6: Verify foundation**

Run: `npm run test:unit -- tests/unit/schemas.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json electron.vite.config.ts tsconfig.json vitest.config.ts src tests/unit/schemas.test.ts
git commit -m "feat: scaffold secure media lab desktop app"
```

### Task 2: Immutable run events and sanitized evidence store

**Files:**
- Create: `src/main/security/redact.ts`
- Create: `src/main/runs/event-repository.ts`
- Create: `src/main/runs/run-orchestrator.ts`
- Test: `tests/unit/redact.test.ts`
- Test: `tests/unit/event-repository.test.ts`

**Interfaces:**
- Consumes: `RunEvent`, `RunMode`, `StartRunInput`.
- Produces: `redactUrl(url: string): string`, `redactHeaders(headers: Record<string,string>): Record<string,string>`, `EventRepository`, and `RunOrchestrator.emit(input)`.

- [ ] **Step 1: Write URL and header redaction tests**

```ts
expect(redactUrl('https://cdn.test/v.mp4?x-signature=secret&quality=720'))
  .toBe('https://cdn.test/v.mp4?x-signature=%5BREDACTED%5D&quality=720');
expect(redactHeaders({ Cookie: 'sid=secret', Range: 'bytes=0-15' }))
  .toEqual({ Cookie: '[REDACTED]', Range: 'bytes=0-15' });
```

Cover case-insensitive names: cookie, authorization, token, signature, policy, credential, key, and session.

- [ ] **Step 2: Run redaction tests and verify failure**

Run: `npm run test:unit -- tests/unit/redact.test.ts`

Expected: FAIL because the redaction module is missing.

- [ ] **Step 3: Implement redaction before persistence**

Make persistence accept only a `SanitizedCapturedRequest` type that has no raw URL or raw header field. Keep raw request data in a run-scoped `Map<string, EphemeralRequest>` owned by the orchestrator and clear it on completion/cancellation.

- [ ] **Step 4: Write repository ordering tests**

```ts
const first = repo.append(runId, eventInput('browser', 'navigate'));
const second = repo.append(runId, eventInput('capture', 'response'));
expect([first.sequence, second.sequence]).toEqual([1, 2]);
expect(repo.list(runId).map(e => e.action)).toEqual(['navigate', 'response']);
```

- [ ] **Step 5: Implement SQLite repository and orchestrator**

Use transactions to allocate strictly increasing sequence numbers. Emit the stored event to the renderer only after the transaction succeeds. Define `AbortController` ownership in `RunOrchestrator`; cancellation emits `running → cancelled` events and clears ephemeral requests.

- [ ] **Step 6: Verify and commit**

Run: `npm run test:unit -- tests/unit/redact.test.ts tests/unit/event-repository.test.ts`

Expected: PASS.

```bash
git add src/main/security src/main/runs tests/unit
git commit -m "feat: persist visible sanitized run events"
```

### Task 3: Deterministic local target lab

**Files:**
- Create: `lab/media.ts`
- Create: `lab/scenarios.ts`
- Create: `lab/server.ts`
- Create: `src/main/security/signature.ts`
- Test: `tests/integration/lab-server.test.ts`

**Interfaces:**
- Produces: `startLabServer(): Promise<LabServer>`, `LabServer.baseUrl`, `LabServer.close()`, and `signMediaRequest(input, secret): string`.

- [ ] **Step 1: Write integration tests for open and protected Range endpoints**

```ts
const open = await fetch(`${lab.baseUrl}/open-range/video.mp4`, {
  headers: { Range: 'bytes=10-19' }
});
expect(open.status).toBe(206);
expect(open.headers.get('content-range')).toMatch(/^bytes 10-19\/\d+$/);
expect((await open.arrayBuffer()).byteLength).toBe(10);

const denied = await fetch(`${lab.baseUrl}/signed-url/video.mp4?expires=1&sig=bad`);
expect(denied.status).toBe(403);
```

Add expected cases for referer-only, valid/expired signature, session mismatch, capped Range, and segment-window rejection.

- [ ] **Step 2: Run lab integration tests and verify failure**

Run: `npm run test:integration -- tests/integration/lab-server.test.ts`

Expected: FAIL because the lab server is missing.

- [ ] **Step 3: Generate deterministic media fixtures**

At test setup, generate a 6-second 320×180 H.264 test pattern and AAC tone with FFmpeg. Create combined MP4, video-only MP4, audio-only MP4, HLS, and DASH outputs in a temporary directory. Use fixed frame rate, duration, GOP, and metadata for repeatable sizes.

- [ ] **Step 4: Implement scenario policies**

Use Node `http` without external web frameworks. Parse one Range per request, return exact 206/416 headers, and implement:

```ts
export type LabScenario =
  | 'open-range' | 'referer-only' | 'signed-url'
  | 'session-bound' | 'range-capped'
  | 'segment-token' | 'encrypted-placeholder';
```

HMAC input is `mediaId|expires|sessionId|segmentId`. Compare signatures using `timingSafeEqual`. Bind the server only to `127.0.0.1` on an ephemeral port.

- [ ] **Step 5: Add visible player pages**

Each scenario exposes `/watch` with a small player that uses direct MP4, separate MSE audio/video, HLS, or DASH. The page prints its scenario and expected protection so the Electron preview can be tested deterministically.

- [ ] **Step 6: Verify and commit**

Run: `npm run test:integration -- tests/integration/lab-server.test.ts`

Expected: PASS for every scenario.

```bash
git add lab src/main/security/signature.ts tests/integration/lab-server.test.ts
git commit -m "feat: add deterministic media security target lab"
```

### Task 4: CDP page, frame, worker, network, and MSE capture

**Files:**
- Create: `src/main/browser/debugger-port.ts`
- Create: `src/main/browser/mse-instrumentation.ts`
- Create: `src/main/browser/cdp-capture.ts`
- Create: `src/main/browser/browser-controller.ts`
- Test: `tests/unit/cdp-capture.test.ts`
- Test: `tests/unit/mse-instrumentation.test.ts`
- Test: `tests/integration/browser-capture.test.ts`

**Interfaces:**
- Produces: `DebuggerPort`, `CdpCapture.start(target)`, `CdpCapture.stop()`, `BrowserController.open(run)`, `BrowserController.close(runId)`, and normalized `CaptureObservation` events.

- [ ] **Step 1: Write normalized CDP event tests**

Feed a fake debugger port with `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFinished`, `Target.attachedToTarget`, and `Runtime.bindingCalled`. Assert that observations preserve `requestId`, `frameId`, `sessionId`, initiator, status, MIME, lengths, Range, and target type while URLs/headers sent to persistence are redacted.

- [ ] **Step 2: Run capture tests and verify failure**

Run: `npm run test:unit -- tests/unit/cdp-capture.test.ts tests/unit/mse-instrumentation.test.ts`

Expected: FAIL because capture modules are missing.

- [ ] **Step 3: Implement target auto-attachment and network capture**

On attach, send:

```ts
await port.send('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true
});
await port.send('Network.enable', {});
await port.send('Runtime.enable', {});
await port.send('Page.enable', {});
await port.send('Media.enable', {});
```

Enable Network and Runtime for every attached worker session. Normalize events through a pure reducer so tests do not depend on Electron.

- [ ] **Step 4: Implement best-effort MSE instrumentation**

Register a CDP Runtime binding named `__mslEmit` and inject before document scripts. Wrap `URL.createObjectURL`, `MediaSource.addSourceBuffer`, and `SourceBuffer.appendBuffer` while preserving original descriptors and return values. Emit only object IDs, MIME/codecs, appended byte count, timestamp, and buffered ranges; never emit payload bytes.

- [ ] **Step 5: Build isolated browser lifecycle**

Create a per-run in-memory partition, deny permission requests, block navigation to unsupported schemes, and show the target in a dedicated child BrowserWindow. Emit visible events for window creation, debugger attachment, navigation, target attachment, first media candidate, and closure.

- [ ] **Step 6: Verify against the local lab**

Run: `npm run test:integration -- tests/integration/browser-capture.test.ts`

Expected: PASS while observing a page target, an iframe target, a worker request, a blob URL, two SourceBuffers, and the lab media responses.

- [ ] **Step 7: Commit**

```bash
git add src/main/browser tests/unit tests/integration/browser-capture.test.ts
git commit -m "feat: capture browser and MSE media evidence"
```

### Task 5: Media correlation and playlist parsing

**Files:**
- Create: `src/main/media/media-correlator.ts`
- Create: `src/main/media/playlist-parser.ts`
- Test: `tests/unit/media-correlator.test.ts`
- Test: `tests/unit/playlist-parser.test.ts`

**Interfaces:**
- Consumes: `CaptureObservation`.
- Produces: `MediaCorrelator.ingest(observation): MediaAsset[]`, `parseHls(text, baseUrl)`, and `parseDash(xml, baseUrl)`.

- [ ] **Step 1: Write tests for the Douyin-like split-track pattern**

```ts
const assets = correlate([
  response('https://cdn.test/media-video-hvc1/', 'video/mp4', 62_409_109, 206),
  response('https://cdn.test/media-audio-und-mp4a/', 'audio/mp4', 9_478_113, 206),
  mseBuffer('video/mp4; codecs="hvc1.1.6.L120"'),
  mseBuffer('audio/mp4; codecs="mp4a.40.2"')
]);
expect(assets[0].tracks.map(t => t.kind)).toEqual(['video', 'audio']);
expect(assets[0].confidence).toBeGreaterThanOrEqual(0.8);
```

Cover direct MP4, unrelated large assets, duplicate Range requests, bitrate variants, HLS alternate audio, and DASH adaptation sets.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run test:unit -- tests/unit/media-correlator.test.ts tests/unit/playlist-parser.test.ts`

Expected: FAIL because the media modules are missing.

- [ ] **Step 3: Implement classification and deduplication**

Deduplicate by canonical URL plus representation identity, not by individual Range. Score MIME, status, size, URL codec markers, playlist relationships, MSE MIME, temporal correlation, and ffprobe hints. Store every reason in `MediaTrack.detectionReasons` for display.

- [ ] **Step 4: Implement HLS and DASH parsing**

Resolve relative URLs against the manifest URL. Return variants, codecs, bandwidth, resolution, audio groups, initialization segments, and media segment URLs. Mark AES/CENC/KEYFORMAT encryption without attempting decryption.

- [ ] **Step 5: Verify and commit**

Run: `npm run test:unit -- tests/unit/media-correlator.test.ts tests/unit/playlist-parser.test.ts`

Expected: PASS.

```bash
git add src/main/media tests/unit
git commit -m "feat: correlate media tracks and streaming manifests"
```

### Task 6: Bounded access-control probe engine

**Files:**
- Create: `src/main/probes/http-transport.ts`
- Create: `src/main/probes/probe-planner.ts`
- Create: `src/main/probes/probe-runner.ts`
- Test: `tests/unit/probe-planner.test.ts`
- Test: `tests/integration/probe-runner.test.ts`

**Interfaces:**
- Produces: `planProbes(track, mode): ProbePlan[]`, `HttpTransport.execute(plan, signal): Promise<HttpEvidence>`, and `ProbeRunner.run(track, plans, signal): AsyncIterable<ProbeResult>`.

- [ ] **Step 1: Write mutation-plan tests**

Assert exact ordered probe IDs: `baseline`, `without-cookie`, `without-query`, `without-referer`, `without-origin`, `range-head`, `range-middle`, `range-tail`, `range-full`, and `range-concurrent`. In `observe` mode expect no network replays; in `standard` mode expect only short ranges; in `full-download` mode expect `range-full` after successful short probes.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run test:unit -- tests/unit/probe-planner.test.ts`

Expected: FAIL because the planner is missing.

- [ ] **Step 3: Implement HTTP transport and explicit header diffs**

Stream responses and stop after the configured short-probe byte cap. Follow at most five redirects. Record TLS/DNS/timeout separately from HTTP status. Permit controlled omission or replacement of Cookie, Referer, Origin, and query data. Preserve only sanitized evidence outside the active run.

- [ ] **Step 4: Emit a visible event for every probe transition**

For each probe emit `queued`, `running`, then exactly one terminal event. Include purpose, redacted input diff, status code, Content-Range, bytes read, elapsed time, and a conclusion generated from evidence.

- [ ] **Step 5: Verify against every lab scenario**

Run: `npm run test:integration -- tests/integration/probe-runner.test.ts`

Expected: open-range permits all probes; referer-only denies missing Referer but remains weak; signed-url denies removed/expired signatures; capped Range reports reduced response size without claiming prevention.

- [ ] **Step 6: Commit**

```bash
git add src/main/probes tests/unit/probe-planner.test.ts tests/integration/probe-runner.test.ts
git commit -m "feat: add explainable media access probes"
```

### Task 7: Streaming range downloader with integrity checks

**Files:**
- Create: `src/main/download/range-plan.ts`
- Create: `src/main/download/downloader.ts`
- Test: `tests/unit/range-plan.test.ts`
- Test: `tests/integration/downloader.test.ts`

**Interfaces:**
- Produces: `createRangePlan(totalBytes, maxChunkBytes): ByteRange[]` and `Downloader.download(input, signal): Promise<DownloadArtifact>`.

- [ ] **Step 1: Write exact range-planning tests**

```ts
expect(createRangePlan(10, 4)).toEqual([
  { start: 0, end: 3 },
  { start: 4, end: 7 },
  { start: 8, end: 9 }
]);
expect(() => createRangePlan(0, 4)).toThrow();
```

Cover inclusive endpoints, integer overflow, one-byte files, unknown total, and a server returning less than requested.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run test:unit -- tests/unit/range-plan.test.ts`

Expected: FAIL because range planning is missing.

- [ ] **Step 3: Implement safe streaming and atomic completion**

Write to `<name>.part`, validate every `Content-Range`, keep a coverage map, require stable ETag/Last-Modified, and rename only after coverage equals `[0,total-1]`. Compute SHA-256 while writing. Enforce free-space and configured byte limits before a full request.

- [ ] **Step 4: Add bounded concurrency and cancellation**

Use at most four workers. On abort, destroy requests, close streams, emit cancellation events, and keep a resumable manifest that contains only ranges, lengths, validators, and the sanitized URL.

- [ ] **Step 5: Verify single-request and capped-server behavior**

Run: `npm run test:integration -- tests/integration/downloader.test.ts`

Expected: one full Range completes for open-range; range-capped falls back to continuous chunks; signature rejection remains a denied result; ETag changes fail without final rename.

- [ ] **Step 6: Commit**

```bash
git add src/main/download tests/unit/range-plan.test.ts tests/integration/downloader.test.ts
git commit -m "feat: stream and verify ranged media downloads"
```

### Task 8: FFmpeg remux and ffprobe verification

**Files:**
- Create: `src/main/media/ffmpeg-adapter.ts`
- Test: `tests/integration/ffmpeg-adapter.test.ts`

**Interfaces:**
- Produces: `probeMedia(path, signal): Promise<MediaProbe>`, `remuxTracks(videoPath, audioPath, outputPath, signal): Promise<RemuxResult>`, and `resolveMediaTools(): ToolPaths`.

- [ ] **Step 1: Write media verification tests**

Generate fixture tracks through `lab/media.ts`, remux them, then assert one video and one audio stream, matching six-second durations within 100 ms, expected codecs, and no re-encoding indicators.

- [ ] **Step 2: Run test and verify failure**

Run: `npm run test:integration -- tests/integration/ffmpeg-adapter.test.ts`

Expected: FAIL because the adapter is missing.

- [ ] **Step 3: Implement sidecar resolution and structured process events**

Prefer packaged paths from `process.resourcesPath`; in development use ffmpeg-static/ffprobe-static, then system binaries. Spawn without a shell. Parse progress from `-progress pipe:1`. Emit command purpose and sanitized arguments, never a shell command string.

- [ ] **Step 4: Implement stream-copy remux and final verification**

Invoke FFmpeg with explicit maps and `-c copy`. Write to a temporary output, run ffprobe JSON validation, require expected streams and compatible duration, then atomically rename. Terminate the child on abort.

- [ ] **Step 5: Verify and commit**

Run: `npm run test:integration -- tests/integration/ffmpeg-adapter.test.ts`

Expected: PASS.

```bash
git add src/main/media/ffmpeg-adapter.ts tests/integration/ffmpeg-adapter.test.ts
git commit -m "feat: remux and verify separated media tracks"
```

### Task 9: Evidence-backed findings and reports

**Files:**
- Create: `src/main/reports/finding-engine.ts`
- Create: `src/main/reports/report-generator.ts`
- Test: `tests/unit/finding-engine.test.ts`
- Test: `tests/unit/report-generator.test.ts`

**Interfaces:**
- Produces: `buildFindings(run): Finding[]` and `generateReports(run, destination): Promise<{jsonPath:string; markdownPath:string}>`.

- [ ] **Step 1: Write finding-rule tests**

Assert that query-free 206 plus arbitrary tail Range produces a high-confidence “可完整获取” finding; no-Referer 403 plus forged-Referer success produces “Referer-only 弱防护”; a transport timeout produces “测试异常” rather than “安全”; encrypted tracks produce “检测到加密，未验证许可证策略”.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run test:unit -- tests/unit/finding-engine.test.ts tests/unit/report-generator.test.ts`

Expected: FAIL because reporting modules are missing.

- [ ] **Step 3: Implement evidence-linked findings**

Every finding contains `evidenceEventIds`, confidence, severity, observed behavior, practical impact, limitations, and remediation. Do not emit a positive security conclusion unless a specific service-side denial was observed.

- [ ] **Step 4: Generate sanitized JSON and Chinese Markdown**

Include architecture, discovered tracks, chronological actions, probe matrix, download integrity, FFmpeg verification, findings, limitations, and prioritized fixes. Scan serialized output for known raw secrets before atomic write.

- [ ] **Step 5: Verify and commit**

Run: `npm run test:unit -- tests/unit/finding-engine.test.ts tests/unit/report-generator.test.ts`

Expected: PASS.

```bash
git add src/main/reports tests/unit
git commit -m "feat: generate evidence-backed security reports"
```

### Task 10: Typed IPC and complete visual workbench

**Files:**
- Create: `src/main/ipc.ts`
- Create: `src/renderer/store/run-store.ts`
- Create: `src/renderer/components/NewRunForm.tsx`
- Create: `src/renderer/components/TargetPreview.tsx`
- Create: `src/renderer/components/RunTimeline.tsx`
- Create: `src/renderer/components/EventDetails.tsx`
- Create: `src/renderer/components/MediaTracks.tsx`
- Create: `src/renderer/components/ProbeMatrix.tsx`
- Create: `src/renderer/components/DownloadProgress.tsx`
- Create: `src/renderer/components/ReportView.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`
- Modify: `src/preload/index.ts`
- Test: `tests/unit/run-store.test.ts`
- Test: `tests/unit/run-timeline.test.tsx`
- Test: `tests/unit/probe-matrix.test.tsx`

**Interfaces:**
- Consumes: all main-process services and shared contracts.
- Produces: complete user workflow through `window.mediaLab`.

- [ ] **Step 1: Write renderer projection tests**

Append out-of-order duplicate events and assert the store deduplicates by ID, sorts by sequence, derives phase status, and preserves terminal states. Verify selectors for current asset, track progress, probe matrix, findings, and report files.

- [ ] **Step 2: Write visible-process component tests**

Render events for navigation, worker attachment, MSE append, removed query, tail Range 206, download progress, FFmpeg remux, and ffprobe success. Assert the timeline shows action, purpose, result, conclusion, timestamp, and expandable redacted request diff.

- [ ] **Step 3: Run UI tests and verify failure**

Run: `npm run test:unit -- tests/unit/run-store.test.ts tests/unit/run-timeline.test.tsx tests/unit/probe-matrix.test.tsx`

Expected: FAIL because workbench components are missing.

- [ ] **Step 4: Implement typed IPC command routing**

Validate every command with Zod, route it to RunOrchestrator, and stream stored events to only the originating renderer. Reject path operations outside the user-selected output directory. Return typed error codes rather than raw stack traces.

- [ ] **Step 5: Implement the workbench layout**

Build four views: new run, live workbench, result, and history. The live workbench uses a three-column desktop layout with target preview, chronological timeline, and track/probe inspector plus a bottom progress drawer. Use clear Chinese labels and stable status colors; preserve layout when details expand.

- [ ] **Step 6: Implement explainability interactions**

Each timeline item expands to “准备做什么 / 为什么 / 修改了什么 / 服务端返回 / 如何判定”. Probe rows link to event IDs. Findings link back to their evidence. Secrets remain masked in all normal UI states.

- [ ] **Step 7: Verify UI and commit**

Run: `npm run test:unit -- tests/unit/run-store.test.ts tests/unit/run-timeline.test.tsx tests/unit/probe-matrix.test.tsx`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

```bash
git add src/main/ipc.ts src/preload src/renderer tests/unit
git commit -m "feat: add explainable media security workbench"
```

### Task 11: End-to-end flows, packaging, and final documentation

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/open-range.spec.ts`
- Create: `tests/e2e/protected-range.spec.ts`
- Create: `scripts/verify-sidecars.mjs`
- Create: `docs/implementation-principles.md`
- Create: `docs/vulnerability-response.md`
- Modify: `package.json`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: complete application.
- Produces: packaged builds, end-to-end evidence, and user-facing technical documentation.

- [ ] **Step 1: Write the open-range end-to-end test**

Launch Electron and the local lab, enter the open-range watch URL, start full-download mode, wait for report completion, and assert the UI shows page/worker/MSE discovery, query-free access, arbitrary tail access, a complete video/audio download, successful remux, and a linked high-confidence finding.

- [ ] **Step 2: Write the protected scenario end-to-end test**

Run signed-url and segment-token scenarios. Assert invalid or expired signatures receive 403, no final media file is produced from denied probes, and the report describes the observed server control without claiming absolute protection.

- [ ] **Step 3: Run end-to-end tests and fix integration boundaries**

Run: `npm run test:e2e`

Expected: both flows PASS without manual interaction.

- [ ] **Step 4: Configure cross-platform packaging**

Configure electron-builder targets for Windows NSIS and macOS DMG/ZIP on x64 and arm64. Place FFmpeg/ffprobe outside ASAR, verify executable permissions at startup, and run native dependency rebuild for Electron. Add CI-ready scripts that build on each target OS rather than cross-compiling native SQLite or media binaries.

- [ ] **Step 5: Write implementation principles**

Document the real data flow from CDP capture through correlation, probes, download, remux, verification, event projection, and reports. Include the difference between blob URL, MediaSource, SourceBuffer, transport tracks, decoding, remuxing, CORS, Referer, signed URLs, and DRM.

- [ ] **Step 6: Write the vulnerability response guide**

For each finding, describe the affected trust boundary, reproduction evidence, false-positive checks, recommended server/CDN change, expected tool result after remediation, and residual limits. Include HMAC input examples, expiry/revocation, session and segment binding, Range rate controls, DRM, watermarking, logging, and key rotation.

- [ ] **Step 7: Run final verification**

Run: `npm test`

Expected: all unit, integration, and end-to-end tests PASS.

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run build`

Expected: Electron main, preload, and renderer builds complete.

Run: `npm run package -- --mac --arm64`

Expected: macOS arm64 artifact is created and startup self-check passes on the current host. Windows x64 and macOS x64 build commands are documented and exercised by their native CI runners.

- [ ] **Step 8: Commit**

```bash
git add playwright.config.ts tests/e2e scripts package.json src/main/index.ts docs/implementation-principles.md docs/vulnerability-response.md
git commit -m "feat: complete cross-platform media security lab"
```
