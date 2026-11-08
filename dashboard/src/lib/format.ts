import type { IncidentStatus, RobotState } from "../types";

// One color per state, used by the cards AND the map.
export const STATE_COLOR: Record<RobotState, string> = {
  NOMINAL: "var(--state-nominal)",
  INVESTIGATING: "var(--state-investigating)",
  STOPPED: "var(--state-stopped)",
  QUARANTINED: "var(--state-quarantined)",
};

export const INCIDENT_COLOR: Record<IncidentStatus, string> = {
  PENDING: "var(--state-investigating)",
  TRIAGING: "var(--state-investigating)",
  RESOLVED: "var(--state-nominal)",
  ESCALATED: "var(--state-stopped)",
};

export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}