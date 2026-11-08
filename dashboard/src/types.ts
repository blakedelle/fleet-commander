// Types copied from the DRAFT data contract.
// DB names are snake_case; here they are camelCase (robot_id -> robotId).
// All timestamps are plain millisecond numbers.

export type RobotState = "NOMINAL" | "INVESTIGATING" | "STOPPED" | "QUARANTINED";
export type IncidentStatus = "PENDING" | "TRIAGING" | "RESOLVED" | "ESCALATED";
export type EventKind =
  | "tool_call"
  | "tool_result"
  | "action"
  | "diagnosis"
  | "escalation"
  | "outcome"
  | "system";
export type Department = "maintenance" | "safety" | "software";
export type Priority = "low" | "medium" | "high";

// Raw sensor fields shared by Robot and TelemetrySample
export interface RawFields {
  vbatt: number; // volts
  batteryPct: number;
  iLeft: number; // amps
  iRight: number; // amps
  cmdLeft: number; // m/s
  cmdRight: number; // m/s
  wLeft: number; // m/s
  wRight: number; // m/s
  x: number; // meters, 0..20
  y: number; // meters, 0..20
  headingDeg: number;
  speed: number; // m/s
  rollDeg: number;
  pitchDeg: number;
}

export interface Robot extends RawFields {
  robotId: string;
  state: RobotState;
  lastSeenMs: number;
}

export interface TelemetrySample extends RawFields {
  sampleId: number;
  robotId: string;
  tMs: number;
}

export interface Incident {
  incidentId: number;
  robotId: string;
  status: IncidentStatus;
  trippedChannels: string; // format unknown: we parse defensively later
  createdMs: number;
  closedMs: number | null; // null while open
  diagnosis: string | null;
  confidence: number | null; // 0..1
  outcome: string | null; // resolved | escalated | unresolved
  summary: string | null;
}

export interface AgentEvent {
  eventId: number;
  incidentId: number;
  robotId: string;
  tsMs: number;
  kind: EventKind;
  title: string;
  detail: string; // JSON string. We NEVER show it raw; we parse it.
}

export interface Escalation {
  escalationId: number;
  incidentId: number;
  robotId: string;
  tsMs: number;
  department: Department;
  priority: Priority;
  message: string;
}

// What the whole UI receives from useFleetData()
export interface FleetData {
  robots: Robot[];
  incidents: Incident[];
  events: AgentEvent[];
  escalations: Escalation[];
  samples: TelemetrySample[];
  connected: boolean;
}