import type { RunEvent } from '../../src/shared/contracts';
import type { ReportRun, ReportProbe } from '../../src/main/reports/report-run';
export function reportRun(): ReportRun {
  return { runId: 'run', mode: 'standard', authorizationConfirmed: true, startedAt: '2026-09-15T01:00:00Z', completedAt: '2026-09-15T02:00:00Z', target: { sanitizedOrigin: 'https://media.example', sanitizedPath: '/watch' }, events: [], requests: [], assets: [], tracks: [{ id: 'video', kind: 'video', sanitizedUrl: 'https://media.example/video.mp4', sourceRequestIds: ['source'], detectionReasons: ['response'], encrypted: false }], probes: [], downloads: [], mediaVerifications: [], limitations: [] };
}
export function probe(run: ReportRun, name: string, options: Partial<ReportProbe> = {}): ReportProbe {
  const id = `p${run.probes.length + 1}`;
  const tail = name === 'range-tail';
  const beforeHeaders: Record<string, string> = { cookie: '[REDACTED]', authorization: '[REDACTED]', referer: 'https://media.example/watch', origin: 'https://media.example', accept: 'video/mp4' };
  const afterHeaders: Record<string, string> = { ...beforeHeaders, range: tail ? 'bytes=-4096' : 'bytes=0-4095', 'accept-encoding': 'identity' };
  const omitted = ['without-cookie', 'without-referer', 'without-origin'].includes(name) ? name.slice(8) : '';
  if (omitted) delete afterHeaders[omitted as keyof typeof afterHeaders];
  if (name === 'forged-referer') afterHeaders.referer = 'https://media.example/alternate';
  const p: ReportProbe = { id, trackId: 'video', requestId: 'source', name, outcome: 'accessible', status: 206, bytesReceived: 4096, durationMs: 5, contentRange: tail ? 'bytes 5904-9999/10000' : 'bytes 0-4095/10000', inputSummary: { mutation: name, byteCap: 4096 }, evidence: { responseMimeType: 'video/mp4', mediaEvidence: tail ? 'linked-range' : 'structural', outcome: 'accessible', transportOutcome: 'http', status: 206, bytesReceived: 4096, contentLength: 4096, contentRange: tail ? 'bytes 5904-9999/10000' : 'bytes 0-4095/10000', sampleSha256: 'a'.repeat(64), intentionallySampled: false, requestDiff: { beforeHeaders, afterHeaders, query: name === 'without-query' ? 'all observed query fields omitted' : 'observed query unchanged', range: tail ? 'bytes=-4096' : 'bytes=0-4095', omittedHeaderNames: omitted ? [omitted] : [], changedHeaderNames: ['range', 'accept-encoding', ...(name === 'forged-referer' ? ['referer'] : [])] }, limitations: [], redirects: [] }, evidenceEventIds: [`e${id}`], ...options };
  run.probes.push(p);
  run.events.push({ id: `e${id}`, runId: run.runId, sequence: run.events.length + 1, timestamp: '2026-09-15T01:10:00Z', phase: 'probe', action: `${name}:after`, purpose: '测试媒体访问', status: p.outcome === 'accessible' ? 'succeeded' : p.outcome === 'denied' ? 'denied' : 'warning', relatedIds: [id, p.trackId, p.requestId!], inputSummary: p.inputSummary, evidence: { ...p.evidence, outcome: p.outcome, status: p.status, bytesReceived: p.bytesReceived, contentRange: p.contentRange } });
  p.evidence = structuredClone(run.events.at(-1)!.evidence!);
  return p;
}
export function event(run: ReportRun, options: Partial<RunEvent>): RunEvent {
  const e: RunEvent = { id: `event${run.events.length + 1}`, runId: run.runId, sequence: run.events.length + 1, timestamp: '2026-09-15T01:10:00Z', phase: 'capture', action: 'track:detected', purpose: '识别媒体', status: 'succeeded', relatedIds: ['video'], ...options };
  run.events.push(e); return e;
}

export function remuxRun(): ReportRun {
  const r = reportRun();
  r.tracks[0].codecs = 'h264'; r.tracks[0].durationSeconds = 2;
  r.tracks.push({ id: 'audio', kind: 'audio', codecs: 'aac', durationSeconds: 2, sanitizedUrl: 'https://media.example/audio.m4a', sourceRequestIds: ['audio-source-v1'], detectionReasons: [] });
  const video = { kind: 'video' as const, codec: 'h264', codecTag: 'avc1', profile: 'High', timeBase: '1/12800', extradataHash: 'SHA256:' + 'a'.repeat(64), durationSeconds: 2, packetCount: 50, width: 1280, height: 720 };
  const audio = { kind: 'audio' as const, codec: 'aac', codecTag: 'mp4a', profile: 'LC', timeBase: '1/48000', extradataHash: 'SHA256:' + 'b'.repeat(64), durationSeconds: 2, packetCount: 94, sampleRate: 48000, channels: 2 };
  const v = { id: 'remux', operation: 'remux' as const, status: 'succeeded' as const, trackIds: ['video', 'audio'], evidenceEventIds: ['remux-event'], probe: { container: 'mp4' as const, durationSeconds: 2, streams: [video, audio] }, inputs: [
    { trackId: 'video', sourceRequestId: 'source', probe: { container: 'mp4' as const, durationSeconds: 2, streams: [video] } },
    { trackId: 'audio', sourceRequestId: 'audio-source-v1', probe: { container: 'mp4' as const, durationSeconds: 2, streams: [audio] } }
  ] };
  r.mediaVerifications.push(structuredClone(v));
  event(r, { id: 'remux-event', phase: 'ffmpeg', action: 'remux:result', relatedIds: ['remux', 'video', 'audio'], inputSummary: { inputs: structuredClone(v.inputs) }, evidence: { committed: true, probe: structuredClone(v.probe) } });
  return r;
}
