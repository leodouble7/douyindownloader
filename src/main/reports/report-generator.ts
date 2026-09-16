import fs from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { completeReportBundle, type ReportBundle } from './report-bundle';
export { verifyReportBundle, type ReportBundle } from './report-bundle';
import { reportProjection } from './report-projection';
import { ReportError, validateRun, type ReportRun } from './report-run';
export type { ReportRun } from './report-run';

const REDACTED = '[已脱敏]';
const MAX_OUTPUT_BYTES = 1024 * 1024;
const limits = [
  '结论仅适用于本次授权范围、模式、已观察请求和时间窗口；未成功获取完整媒体不能证明防护有效。',
  'CDP 非暂停自动附加可能漏掉 Worker 最早的同步请求；后到的 ExtraInfo 请求头不会补入重放模板。',
  'MSE 仅记录追加元数据，不代表完整播放；音视频关联存在不确定性，候选发现时间不用于判定凭据新鲜度。',
  '公开播放时客户端可见的明文仍可被捕获；访问控制用于减少滥用，不能使公开媒体绝对无法保存。',
  '报告使用不可预测的私有目录和独占文件句柄写入，不执行路径链接、改名或删除。路径接口仍无法防止检查之后的恶意祖先替换或报告被再次修改；检测到变化即视为无法判定。',
  '报告文件不采用原子改名；写入过程中私有目录内可见不完整文件。仅原始内存 ReportBundle 与其可信哈希验证通过的内容表示提交成功；读取前必须调用 verifyReportBundle，磁盘回执不能单独证明可信性，路径可能在返回后改变；取消或失败通过持有的句柄清空文件并保留未提交私有目录，崩溃或磁盘错误可能留下部分内容。Windows 不承诺 POSIX 目录 fsync 的持久性。'
];
const architecture = [
  'CDP 观察页面、iframe 与 Worker 的网络生命周期，保存脱敏证据；浏览器播放环境与独立 HTTP 探针分开运行。',
  'iframe 是嵌入的页面；Worker 可发起媒体请求。跨上下文关联只使用已观察证据，缺失请求不能推导防护结论。',
  'MSE 通过 MediaSource 与 SourceBuffer 接收分段数据；blob 地址是本地对象引用，媒体传输地址和音视频轨道需要独立识别。',
  '下载器检查连续字节区间与 SHA-256；FFmpeg -c copy 复制音视频流进行封装，ffprobe 检查输出参数。'
];
function secretVariants(values: string[]): string[] {
  return [...new Set(values.filter(s => s.length >= 8 && !/^\d+$/.test(s) && s !== '[REDACTED]').flatMap(s => [s, encodeURIComponent(s), encodeURIComponent(encodeURIComponent(s))]))].sort((a, b) => b.length - a.length);
}
function cleaner(secrets: string[]) {
  return (value: string): string => {
    let result = value;
    for (let i = 0; i < 2; i++) { try { result = decodeURIComponent(result); } catch { break; } }
    if (/\b(?:ffmpeg|ffprobe|curl|wget|bash|powershell|cmd\.exe|sh)\s+-/i.test(result)) return '[命令与工具日志已省略]';
    result = result.replace(/\b(?:relationKey|realmKey|sourceRequestId|sourceIdentity|sessionId|executionContextId|rawLog|stderr|stdout|arguments)\s*[=:]\s*[^;\r\n]*/gi, REDACTED);
    for (const secret of secrets) result = result.split(secret).join(REDACTED);
    return result
      .replace(/https?:\/\/[^\s<>"'`]+/gi, '[链接已脱敏]')
      .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[=:]\s*[^\r\n]*/gi, REDACTED)
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z\d+/=._~-]+/gi, REDACTED)
      .replace(/\b[\w.-]*(?:token|signature|credential|session|authorization|cookie|secret|password|api[-_]?key|policy)[\w.-]*\s*[=:]\s*[^\s&,;]+/gi, REDACTED)
      .replace(/(?:\?|&)\S+/g, '[查询已脱敏]')
      .replace(/\b[\w.-]+\s*=\s*[^\s&,;]+/g, REDACTED)
      .replace(/\b(?:sig|key)\s*=\s*[^\s&,;]+/gi, REDACTED)
      .replace(/(?:[A-Za-z]:[\\/]|\\\\|file:\/\/)[^\s<>"']+/g, '[本地路径已脱敏]')
      .replace(/\/(?:[^\s/<>"']+\/)+[^\s<>"']*/g, '[本地路径已脱敏]')
      .replace(/(^|\s)\/[^\s<>"']+/g, '$1[本地路径已脱敏]')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
      .slice(0, 1000);
  };
}
function location(value: string, clean: (s: string) => string): { origin: string; path: string } {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    // Origin/path are separate projections; credentials, search and fragment have no output field.
    const host = clean(url.host); const path = '/' + clean(decodeURIComponent(url.pathname).replace(/^\//, ''));
    return { origin: host.includes(REDACTED) ? REDACTED : `${url.protocol}//${host}`, path };
  } catch { return { origin: REDACTED, path: REDACTED }; }
}
function scan(serialized: string, secretValues: string[], fingerprints: string[]): void {
  if (Buffer.byteLength(serialized) > MAX_OUTPUT_BYTES) throw new ReportError('output-limit');
  if (secretValues.some(secret => serialized.includes(secret))) throw new ReportError('secret-detected');
  if (/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*(?:\\?"\s*)?[:=]\s*(?:\\?"\s*)?(?!\[已脱敏\]|\[REDACTED\])(?:Bearer\s+|Basic\s+|[A-Za-z\d]{8})/i.test(serialized)
    || /[?&](?:[\w.-]*(?:token|signature|credential|session|secret|password|policy)[\w.-]*|sig|key)=[^\s\]"&]+/i.test(serialized)
    || /(?:[A-Za-z]:\\\\|file:\/\/|\/(?:Users|home|private|tmp|var|Volumes)\/)/.test(serialized)) throw new ReportError('secret-detected');
  const hashes = new Set(fingerprints);
  // Fingerprints are SHA-256 of complete leaf values or delimiter-separated tokens (minimum 8 chars).
  if (hashes.size) {
    const candidates = serialized.match(/[\p{L}\p{N}_+./=:@%-]{8,}|"(?:[^"\\]|\\.)*"/gu) ?? [];
    for (const candidate of candidates) {
      const values = [candidate]; if (candidate.startsWith('"')) { try { values.push(JSON.parse(candidate)); } catch { /* Markdown text is not JSON. */ } }
      if (values.some(v => typeof v === 'string' && v.length >= 8 && hashes.has(createHash('sha256').update(v).digest('hex')))) throw new ReportError('secret-detected');
    }
  }
}
function md(value: unknown): string {
  return String(value ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n|\r/g, '<br>').replace(/([`*_\[\]#])/g, '\\$1');
}
function table(headers: string[], rows: unknown[][]): string { return `| ${headers.map(md).join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.length ? rows.map(r => `| ${r.map(md).join(' | ')} |`).join('\n') : `| ${headers.map((_, i) => i ? '—' : '无可用证据').join(' | ')} |`}`; }
function sourceReferences(run: ReportRun): string[] {
  const references = [...run.requests.map(r => r.id), ...run.tracks.flatMap(t => t.sourceRequestIds), ...run.probes.flatMap(p => p.requestId ? [p.requestId] : []), ...run.events.flatMap(e => e.relatedIds), ...run.mediaVerifications.flatMap(v => v.inputs?.map(i => i.sourceRequestId) ?? [])];
  const values: string[] = [];
  for (const ref of references) {
    if (ref.length < 8) continue;
    values.push(ref, Buffer.from(ref).toString('base64'), Buffer.from(ref).toString('base64url'));
    try { const tuple: unknown = JSON.parse(ref); if (Array.isArray(tuple)) for (const part of tuple) if (typeof part === 'string' && part.length >= 8) values.push(part, Buffer.from(part).toString('base64'), Buffer.from(part).toString('base64url')); } catch { /* Opaque references still receive exact-value suppression. */ }
  }
  return values;
}
function documents(run: ReportRun): { json: string; markdown: string } {
  const secrets = secretVariants([...(run.rawSecretValues ?? []), ...sourceReferences(run)]), clean = cleaner(secrets);
  const projected = reportProjection(run, clean, s => location(s, clean));
  const snapshot = { ...projected, architecture, limitations: [...limits, ...projected.limitations] };
  const { findings, tracks, events, probes, downloads: safeDownloads, mediaVerifications: safeVerifications, assets: safeAssets } = snapshot;
  const sections = [
    '# 媒体访问控制验证报告',
    `## 范围与授权\n\n运行：${md(snapshot.runId)}；模式：${md(run.mode)}；授权确认：${run.authorizationConfirmed ? '是' : '未确认'}。\n\n目标源：${md(snapshot.target.origin)}；路径：${md(snapshot.target.path)}。\n\n时间：${md(run.startedAt)} 至 ${md(run.completedAt)}。`,
    `## 架构与角色\n\n${architecture.map(s => `- ${s}`).join('\n')}`,
    `## 资产与音视频轨道\n\n音轨与视频轨分开列出，muxed 表示已混合轨；选择和关联不等于完整播放验证。资产数：${run.assets.length}；请求数：${run.requests.length}。\n\n${table(['资产', '标题', '候选轨道', '选定轨道', '关联置信度'], safeAssets.map(a => [a.id, a.title, a.trackIds.join(', '), a.selectedTrackIds.join(', '), a.confidence]))}\n\n${table(['轨道', '类型', '媒体类型 / 编码', '字节数', '加密', '来源路径'], tracks.map(t => [t.id, t.kind, `${t.mimeType} / ${t.codecs}`, t.byteLength, t.encrypted ? '检测到' : '未观察到', t.location.path]))}`,
    `## 可见动作时间线\n\n${table(['序号 / 事件', '时间 / 阶段', '动作 / 目的', '状态 / 观察'], events.map(e => [`${e.sequence} / ${e.id}`, `${e.timestamp} / ${e.phase}`, `${e.action} / ${e.purpose}`, `${e.status} / ${e.conclusion ?? ''}`]))}`,
    `## 探针矩阵\n\n${table(['轨道 / 探针', '结果 / HTTP', '字节 / 区间', '证据有效', '事件'], probes.map(p => [`${p.trackId} / ${p.name}`, `${p.outcome} / ${p.status ?? '—'}`, `${p.bytesReceived ?? 0} / ${p.contentRange ?? '—'}`, p.evidenceVerified ? '是' : '否，无法判定', p.evidenceEventIds.join(', ')]))}`,
    `## 下载区间与完整性\n\n${table(['下载 / 轨道', '区间', '字节数 / SHA-256', '验证'], safeDownloads.map(d => [d.id + ' / ' + d.trackIds.join(', '), d.intervals.map(i => `${i.start}-${i.end}`).join(', '), `${d.byteLength} / ${d.sha256}`, d.verified ? '连续区间和完整下载已验证' : '无法判定']))}`,
    `## FFmpeg -c copy 与 ffprobe 验证\n\n仅已关联成功事件支持无损封装结论；不执行转码或解密。\n\n${table(['验证', '操作', '轨道 / 时长', '结果'], safeVerifications.map(v => [v.id, v.operation, `${v.probe?.streams.map(s => `${s.kind}:${s.codec}`).join(', ') ?? '—'} / ${v.probe?.durationSeconds ?? '—'}`, v.verified ? '已验证' : '无法判定']))}`,
    `## 发现\n\n${findings.length ? findings.map(f => `### ${md(f.title)}\n\n严重度：${md(f.severity)}；置信度：${md(f.confidence)}。\n\n观察：${md(f.observedBehavior)}\n\n实际影响：${md(f.practicalImpact)}\n\n限制：${f.limitations.map(md).join('；')}\n\n建议：${md(f.recommendation)}\n\n证据事件：${f.evidenceEventIds.map(md).join(', ')}`).join('\n\n') : '当前证据不足以形成发现；不代表防护有效。'}`,
    `## 限制\n\n${snapshot.limitations.map(s => `- ${md(s)}`).join('\n')}`,
    `## 优先修复\n\n${findings.length ? findings.map((f, i) => `${i + 1}. [${md(f.severity)}] ${md(f.recommendation)}（${md(f.title)}）`).join('\n') : '先完成授权范围内的有效捕获与有界测试，再评估修复优先级。'}`
  ];
  const json = JSON.stringify(snapshot, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e') + '\n', markdown = sections.join('\n\n') + '\n';
  scan(json + markdown, secrets, run.rawSecretFingerprints ?? []);
  return { json, markdown };
}
export interface ReportDestination { directory: string; signal?: AbortSignal }
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
/** Each export is a private unpredictable bundle. All bytes are written through exclusive
 * final handles; no source-path linking, renaming, or pathname deletion takes place.
 * Trusted memory hashes bind the completion receipt. Failure clears owned handles, retains an
 * uncommitted private directory, and never deletes an attacker replacement. */
export async function generateReports(input: ReportRun, destination: string | ReportDestination): Promise<ReportBundle> {
  const directory = typeof destination === 'string' ? destination : destination.directory;
  const signal = typeof destination === 'string' ? undefined : destination.signal;
  const files: { path: string; handle: fs.FileHandle; identity: BigIntStats; bytes: Buffer }[] = [];
  let handlesClosed = false;
  let parent: fs.FileHandle | undefined, bundleHandle: fs.FileHandle | undefined;
  let root = '', bundle = '', rootIdentity: BigIntStats | undefined, bundleIdentity: BigIntStats | undefined;
  const abort = () => { if (signal?.aborted) throw new ReportError('cancelled'); };
  const checkDirectory = async () => {
    if (!rootIdentity || !bundleIdentity || !same(await fs.lstat(root, { bigint: true }), rootIdentity) || !same(await fs.lstat(bundle, { bigint: true }), bundleIdentity)
      || await fs.realpath(root) !== root || await fs.realpath(bundle) !== bundle
      || parent && !same(await parent.stat({ bigint: true }), rootIdentity) || bundleHandle && !same(await bundleHandle.stat({ bigint: true }), bundleIdentity)) throw new ReportError('publication-failed');
  };
  const verifyFile = async (file: typeof files[number]) => {
    const held = await file.handle.stat({ bigint: true }), leaf = await fs.lstat(file.path, { bigint: true });
    if (!same(held, file.identity) || !same(leaf, file.identity) || !leaf.isFile() || leaf.nlink !== 1n || held.size !== BigInt(file.bytes.length)) throw new ReportError('publication-failed');
    const read = Buffer.alloc(file.bytes.length); let offset = 0;
    while (offset < read.length) { const { bytesRead } = await file.handle.read(read, offset, read.length - offset, offset); if (!bytesRead) throw new ReportError('publication-failed'); offset += bytesRead; }
    if (!read.equals(file.bytes)) throw new ReportError('publication-failed');
  };
  const create = async (name: string, bytes: Buffer) => {
    abort(); await checkDirectory();
    const path = join(bundle, name), handle = await fs.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
    let identity: BigIntStats;
    try { identity = await handle.stat({ bigint: true }); } catch (error) { await handle.close().catch(() => {}); throw error; }
    const file = { path, handle, identity, bytes }; files.push(file);
    if (!identity.isFile() || identity.nlink !== 1n) throw new ReportError('publication-failed');
    await handle.writeFile(bytes); await handle.sync(); abort(); await checkDirectory(); await verifyFile(file);
    return file;
  };
  try {
    abort(); const content = documents(validateRun(input)); abort();
    if (!isAbsolute(directory) || directory.includes('\0')) throw new ReportError('publication-failed');
    root = resolve(directory);
    for (let current = root; ; current = dirname(current)) {
      const info = await fs.lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw new ReportError('publication-failed');
      if (dirname(current) === current) break;
    }
    if (await fs.realpath(root) !== root) throw new ReportError('publication-failed');
    rootIdentity = await fs.lstat(root, { bigint: true });
    if (process.platform !== 'win32') parent = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    bundle = join(root, `.report-${randomUUID()}`); await fs.mkdir(bundle, { mode: 0o700 }); bundleIdentity = await fs.lstat(bundle, { bigint: true });
    if (!bundleIdentity.isDirectory() || bundleIdentity.isSymbolicLink()) throw new ReportError('publication-failed');
    if (process.platform !== 'win32') bundleHandle = await fs.open(bundle, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const json = await create('report.json', Buffer.from(content.json)), markdown = await create('report.md', Buffer.from(content.markdown));
    const receipt = { version: 1, state: 'complete', files: Object.fromEntries([json, markdown].map(f => [f === json ? 'report.json' : 'report.md', { bytes: f.bytes.length, sha256: createHash('sha256').update(f.bytes).digest('hex') }])) };
    await create('complete.json', Buffer.from(JSON.stringify(receipt) + '\n'));
    for (const file of files) { abort(); await verifyFile(file); }
    await bundleHandle?.sync(); await parent?.sync(); abort(); await checkDirectory();
    // Re-read original owned handles after the final directory-sync await window.
    for (const file of files) { abort(); await verifyFile(file); }
    for (const file of files) await file.handle.close();
    await bundleHandle?.close(); await parent?.close(); handlesClosed = true;
    abort();
    // Synchronous nofollow reads and final OS entry checks follow every asynchronous close.
    return completeReportBundle(basename(bundle), root, bundle, rootIdentity!, bundleIdentity!, files);
  } catch (error) {
    // Clear only descriptors opened by this operation. Never check-then-unlink a pathname.
    for (const file of [...files].reverse()) { try { await file.handle.truncate(0); await file.handle.sync(); } catch { /* Storage failure may leave an incomplete private bundle. */ } }
    await bundleHandle?.sync().catch(() => {}); await parent?.sync().catch(() => {});
    throw error instanceof ReportError ? error : new ReportError('publication-failed');
  } finally {
    if (!handlesClosed) {
      for (const file of files) await file.handle.close().catch(() => {});
      await bundleHandle?.close().catch(() => {}); await parent?.close().catch(() => {});
    }
    // A crash or filesystem failure can leave partial private files; only a valid complete
    // receipt verified against trusted memory describes a committed bundle. No path was returned on failure.
  }
}
