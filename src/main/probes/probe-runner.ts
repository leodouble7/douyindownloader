import { randomUUID } from 'node:crypto';
import type { MediaTrack, ProbeResult } from '../../shared/contracts';
import type { RunOrchestrator } from '../runs/run-orchestrator';
import type { HttpTransport, HttpEvidence } from './http-transport';
import { planProbes, type ProbePlan } from './probe-planner';

interface RunnerOptions { context: RunOrchestrator; runId: string; transport: HttpTransport }
export class ProbeRunner {
  constructor(private readonly options: RunnerOptions) {}
  async *run(track: MediaTrack, plans: ProbePlan[], signal: AbortSignal): AsyncIterable<ProbeResult> {
    const local = new AbortController();
    const combined = AbortSignal.any([signal, local.signal, this.options.context.getAbortSignal(this.options.runId)]);
    const canonical = planProbes(track, this.options.context.getMode(this.options.runId));
    // Canonicalize the bounded unique mutation set while preserving an eligible selected source.
    const selected = canonical.flatMap(plan => {
      const requested = plans.find(item => item.id === plan.id);
      return requested && requested.trackId === track.id && track.sourceRequestIds.includes(requested.sourceRequestId)
        ? [{ ...plan, sourceRequestId: requested.sourceRequestId }] : [];
    });
    try {
      for (const plan of selected) {
        if (!this.options.context.isActive(this.options.runId)) break;
        const id = randomUUID();
        const inputSummary = { sourceRequestId: plan.sourceRequestId, mutation: plan.id, byteCap: plan.byteCap };
        const audit = (stage: 'queued' | 'before' | 'after' | 'failed' | 'cancelled', evidence?: HttpEvidence) => {
          this.options.context.emit({ runId: this.options.runId, phase: 'probe', action: `${plan.id}:${stage}`, purpose: plan.purpose,
            status: stage === 'queued' ? 'queued' : stage === 'before' ? 'running' : stage === 'cancelled' ? 'cancelled' : stage === 'failed' ? 'failed' : evidence?.outcome === 'denied' ? 'denied' : evidence?.outcome === 'accessible' ? 'succeeded' : 'warning',
            inputSummary, evidence: evidence ? { ...evidence } : undefined, conclusion: evidence?.conclusion, relatedIds: [id, track.id, plan.sourceRequestId] });
        };
        audit('queued'); audit('before');
        let terminal = false;
        const onCancel = () => {
          if (terminal) return;
          terminal = true;
          audit('cancelled', { outcome: 'inconclusive', transportOutcome: 'cancelled', bytesReceived: 0, durationMs: 0, requestDiff: {}, redirects: [], limitations: ['Cancellation interrupted the active probe'], conclusion: 'Probe cancelled; access control is inconclusive' });
        };
        combined.addEventListener('abort', onCancel, { once: true });
        let evidence: HttpEvidence;
        try { evidence = await this.options.transport.execute(plan, combined); }
        catch { evidence = { outcome: 'inconclusive', transportOutcome: combined.aborted ? 'cancelled' : 'network', bytesReceived: 0, durationMs: 0, requestDiff: {}, redirects: [], limitations: ['Probe execution failed'], conclusion: 'Probe execution failed; access control is inconclusive' }; }
        const stage = evidence.transportOutcome === 'cancelled' ? 'cancelled' : ['dns', 'tls', 'timeout', 'parser', 'network'].includes(evidence.transportOutcome) ? 'failed' : 'after';
        combined.removeEventListener('abort', onCancel);
        if (!terminal) { terminal = true; audit(stage, evidence); }
        yield { id, runId: this.options.runId, trackId: track.id, requestId: plan.sourceRequestId, name: plan.id,
          outcome: evidence.outcome, status: evidence.status, responseMimeType: evidence.responseMimeType, bytesReceived: evidence.bytesReceived,
          contentRange: evidence.contentRange, durationMs: evidence.durationMs, inputSummary, evidence: { ...evidence }, conclusion: evidence.conclusion };
      }
    } finally { local.abort(); }
  }
}
