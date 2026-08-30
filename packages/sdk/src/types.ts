export interface Environment {
  id: string;
  name: string;
}

export interface Run {
  id: string;
  status: string;
}

export interface EvidenceBundle {
  id: string;
  runId: string;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  type: string;
}

export interface Approval {
  id: string;
  status: string;
}
