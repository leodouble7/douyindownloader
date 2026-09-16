import { createStore } from 'zustand/vanilla';
import type { RunEvent, RunHistoryItem, RunPhase, StepStatus, WorkbenchSnapshot } from '../../shared/contracts';
export interface RunState { events: RunEvent[]; snapshot?: WorkbenchSnapshot; history: RunHistoryItem[]; selectedAssetId?: string; append(events: RunEvent[]): void; setSnapshot(snapshot: WorkbenchSnapshot): void; setHistory(history: RunHistoryItem[]): void; selectAsset(id: string): void; reset(): void }
const terminal = (s: StepStatus) => !['queued', 'running'].includes(s);
function merge(events: RunEvent[], additions: RunEvent[]): RunEvent[] {
  const ids = new Map(events.map(e => [e.id, e])); for (const e of additions) { const before = ids.get(e.id); if (!before || !terminal(before.status) || terminal(e.status)) ids.set(e.id, e); }
  return [...ids.values()].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
}
export function createRunStore() { return createStore<RunState>()((set) => ({ events: [], history: [], append: events => set(s => ({ events: merge(s.events, events.filter(e => !s.snapshot || e.runId === s.snapshot.runId)) })), setSnapshot: snapshot => set(s => ({ snapshot, events: merge(s.snapshot?.runId === snapshot.runId ? s.events : [], snapshot.events), selectedAssetId: snapshot.assets.some(a => a.id === s.selectedAssetId) ? s.selectedAssetId : snapshot.assets[0]?.id })), setHistory: history => set({ history }), selectAsset: selectedAssetId => set({ selectedAssetId }), reset: () => set({ snapshot: undefined, events: [], selectedAssetId: undefined }) })); }
export const runStore = createRunStore();
export const selectors = {
  currentAsset: (s: RunState) => s.snapshot?.assets.find(a => a.id === s.selectedAssetId) ?? s.snapshot?.assets[0],
  tracks: (s: RunState) => s.snapshot?.tracks ?? [], probes: (s: RunState) => s.snapshot?.probes ?? [], findings: (s: RunState) => s.snapshot?.findings ?? [], report: (s: RunState) => s.snapshot?.report, history: (s: RunState) => s.history,
  phases: (s: RunState): Partial<Record<RunPhase, StepStatus>> => { const phases: Partial<Record<RunPhase, StepStatus>> = {}; for (const e of s.events) if (!phases[e.phase] || !terminal(phases[e.phase]!) || terminal(e.status)) phases[e.phase] = e.status; return phases; },
  downloads: (s: RunState): RunEvent[] => { const tasks = new Map<string, RunEvent>(); for (const e of s.events.filter(e => ['download', 'ffmpeg', 'verify'].includes(e.phase))) { const key = `${e.phase}:${e.relatedIds[0] ?? 'current'}`, previous = tasks.get(key); if (!previous || !terminal(previous.status) || terminal(e.status)) tasks.set(key, e); } return [...tasks.values()]; }
};
