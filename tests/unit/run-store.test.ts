import { describe, expect, it } from 'vitest';
import { createRunStore, selectors } from '../../src/renderer/store/run-store';
import type { RunEvent, WorkbenchSnapshot } from '../../src/shared/contracts';
const event = (sequence: number, status: RunEvent['status'] = 'running'): RunEvent => ({ id: `event-${sequence}`, runId: 'run', sequence, timestamp: '2026-09-15T10:00:00Z', phase: 'download', action: 'download:progress', purpose: '下载轨道', status, relatedIds: ['download-1'], evidence: { completedBytes: sequence * 100 } });
describe('run projection', () => {
  it('deduplicates IDs, sorts sequence, and prevents late progress from undoing terminal state', () => {
    const store = createRunStore(); store.getState().append([event(3, 'succeeded'), event(1), event(2), event(2), event(4)]);
    expect(store.getState().events.map(e => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(selectors.phases(store.getState()).download).toBe('succeeded');
    expect(selectors.downloads(store.getState())[0].status).toBe('succeeded');
  });
  it('exposes assets, tracks, probes, findings, report and persisted history selectors', () => {
    const store = createRunStore(); const snapshot = { runId: 'run', status: 'completed', mode: 'standard', targetLabel: 'example.test', startedAt: '2026-09-15T10:00:00Z', events: [], assets: [{ id: 'asset-1', trackIds: ['track-1'], selectedTrackIds: ['track-1'], confidence: .8 }], tracks: [{ id: 'track-1', assetId: 'asset-1', kind: 'video', eligible: true }], probes: [{ id: 'p-1', trackId: 'track-1', name: 'range-tail', outcome: 'accessible', eventIds: ['e-1'] }], findings: [{ id: 'f-1', runId: 'run', severity: 'high', title: '媒体可访问', summary: 'summary', observedBehavior: 'bytes returned', practicalImpact: 'downloadable', recommendation: 'enforce auth', limitations: [], confidence: 'high', evidenceEventIds: ['e-1'] }], artifacts: [], report: { status: 'verified', markdown: '# 报告', json: '{}', files: ['report.md', 'evidence.json'] } } as WorkbenchSnapshot;
    store.getState().setSnapshot(snapshot); store.getState().setHistory([snapshot]);
    expect(selectors.currentAsset(store.getState())?.id).toBe('asset-1'); expect(selectors.tracks(store.getState())[0].id).toBe('track-1'); expect(selectors.probes(store.getState())[0].id).toBe('p-1'); expect(selectors.findings(store.getState())[0].id).toBe('f-1'); expect(selectors.report(store.getState())?.files).toHaveLength(2); expect(selectors.history(store.getState())).toHaveLength(1);
  });
});
