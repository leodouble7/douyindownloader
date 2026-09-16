import type { Debugger } from 'electron';

export interface CdpMessage {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** Main-process-only transport; target scripts never receive this interface. */
export interface DebuggerPort {
  attach(): void;
  detach(): void;
  send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  onMessage(listener: (message: CdpMessage) => void): () => void;
  onDetach?(listener: (reason: string) => void): () => void;
}

export class ElectronDebuggerPort implements DebuggerPort {
  constructor(private readonly debuggerApi: Debugger) {}
  attach(): void { this.debuggerApi.attach('1.3'); }
  detach(): void { if (this.debuggerApi.isAttached()) this.debuggerApi.detach(); }
  send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
    return this.debuggerApi.sendCommand(method, params, sessionId);
  }
  onMessage(listener: (message: CdpMessage) => void): () => void {
    const handle = (_event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => listener({ method, params, sessionId });
    this.debuggerApi.on('message', handle);
    return () => { this.debuggerApi.off('message', handle); };
  }
  onDetach(listener: (reason: string) => void): () => void {
    const handle = (_event: unknown, reason: string) => listener(reason);
    this.debuggerApi.on('detach', handle);
    return () => { this.debuggerApi.off('detach', handle); };
  }
}
