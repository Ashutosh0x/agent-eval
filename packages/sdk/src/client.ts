import fetch from 'node-fetch';
import type { Environment, Run, EvidenceBundle, AuditEvent, Approval } from './types';

export class AgentEvalClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  private async request(path: string, options: any = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`API error: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  environments = {
    list: (): Promise<Environment[]> => this.request('/environments'),
    get: (id: string): Promise<Environment> => this.request(`/environments/${id}`),
    import: (source: string): Promise<Environment> => this.request('/environments/import', { method: 'POST', body: JSON.stringify({ source }) }),
  };

  runs = {
    start: (config: any): Promise<Run> => this.request('/runs', { method: 'POST', body: JSON.stringify(config) }),
    get: (id: string): Promise<Run> => this.request(`/runs/${id}`),
    stop: (id: string): Promise<void> => this.request(`/runs/${id}/stop`, { method: 'POST' }),
    list: (): Promise<Run[]> => this.request('/runs'),
  };

  evidence = {
    generate: (runId: string): Promise<EvidenceBundle> => this.request('/evidence', { method: 'POST', body: JSON.stringify({ runId }) }),
    get: (id: string): Promise<EvidenceBundle> => this.request(`/evidence/${id}`),
    verify: (id: string): Promise<boolean> => this.request(`/evidence/${id}/verify`, { method: 'POST' }).then((res: any) => res.valid),
  };

  audit = {
    query: (filters: any): Promise<AuditEvent[]> => this.request('/audit', { method: 'POST', body: JSON.stringify(filters) }),
    verifyChain: (): Promise<boolean> => this.request('/audit/verify-chain', { method: 'POST' }).then((res: any) => res.valid),
    getProof: (eventId: string): Promise<any> => this.request(`/audit/proof/${eventId}`),
  };

  approvals = {
    list: (): Promise<Approval[]> => this.request('/approvals'),
    approve: (id: string, justification: string): Promise<Approval> => this.request(`/approvals/${id}/approve`, { method: 'POST', body: JSON.stringify({ justification }) }),
    deny: (id: string, justification: string): Promise<Approval> => this.request(`/approvals/${id}/deny`, { method: 'POST', body: JSON.stringify({ justification }) }),
  };
}
