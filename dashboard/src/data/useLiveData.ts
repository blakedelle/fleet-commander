import { useEffect, useState } from "react";
import type {
  AgentEvent,
  Department,
  Escalation,
  EventKind,
  FleetData,
  Incident,
  IncidentStatus,
  Priority,
  Robot,
  RobotState,
  TelemetrySample,
} from "../types";
import { getConnection, isConnected, startConnection } from "./connection";

const POLL_MS = 500;
const MAX_SAMPLES = 120; // per robot

const DISCONNECTED: FleetData = {
  robots: [], incidents: [], events: [], escalations: [], samples: [], connected: false,
};

// The database uses 0 and "" for "not set yet". The UI uses null.
const textOrNull = (s: string) => (s ? s : null);
const numOrNull = (n: number) => (n ? n : null);

function readSnapshot(): FleetData | null {
  const conn = getConnection();
  if (!conn) return null;

  const robots: Robot[] = [...conn.db.robot.iter()]
    .map((r) => ({
      robotId: r.robotId,
      state: r.state as RobotState,
      lastSeenMs: r.lastSeenMs,
      vbatt: r.vbatt,
      batteryPct: r.batteryPct,
      iLeft: r.iLeft,
      iRight: r.iRight,
      cmdLeft: r.cmdLeft,
      cmdRight: r.cmdRight,
      wLeft: r.wLeft,
      wRight: r.wRight,
      x: r.x,
      y: r.y,
      headingDeg: r.headingDeg,
      speed: r.speed,
      rollDeg: r.rollDeg,
      pitchDeg: r.pitchDeg,
    }))
    .sort((a, b) => a.robotId.localeCompare(b.robotId));

  const incidents: Incident[] = [...conn.db.incident.iter()].map((i) => ({
    incidentId: i.incidentId,
    robotId: i.robotId,
    status: i.status as IncidentStatus,
    trippedChannels: i.trippedChannels,
    createdMs: i.createdMs,
    closedMs: numOrNull(i.closedMs),
    diagnosis: textOrNull(i.diagnosis),
    confidence: numOrNull(i.confidence),
    outcome: textOrNull(i.outcome),
    summary: textOrNull(i.summary),
  }));

  const events: AgentEvent[] = [...conn.db.agentEvent.iter()].map((e) => ({
    eventId: e.eventId,
    incidentId: e.incidentId,
    robotId: e.robotId,
    tsMs: e.tsMs,
    kind: e.kind as EventKind,
    title: e.title,
    detail: e.detail,
  }));

  const escalations: Escalation[] = [...conn.db.escalation.iter()].map((e) => ({
    escalationId: e.escalationId,
    incidentId: e.incidentId,
    robotId: e.robotId,
    tsMs: e.tsMs,
    department: e.department as Department,
    priority: e.priority as Priority,
    message: e.message,
  }));

  // keep only the newest MAX_SAMPLES per robot
  const byRobot = new Map<string, TelemetrySample[]>();
  for (const s of conn.db.telemetrySample.iter()) {
    const list = byRobot.get(s.robotId) ?? [];
    list.push({
      sampleId: s.sampleId,
      robotId: s.robotId,
      tMs: s.tMs,
      vbatt: s.vbatt,
      batteryPct: s.batteryPct,
      iLeft: s.iLeft,
      iRight: s.iRight,
      cmdLeft: s.cmdLeft,
      cmdRight: s.cmdRight,
      wLeft: s.wLeft,
      wRight: s.wRight,
      x: s.x,
      y: s.y,
      headingDeg: s.headingDeg,
      speed: s.speed,
      rollDeg: s.rollDeg,
      pitchDeg: s.pitchDeg,
    });
    byRobot.set(s.robotId, list);
  }
  const samples: TelemetrySample[] = [];
  for (const list of byRobot.values()) {
    list.sort((a, b) => a.tMs - b.tMs);
    samples.push(...list.slice(-MAX_SAMPLES));
  }

  return { robots, incidents, events, escalations, samples, connected: true };
}

export function useLiveData(): FleetData {
  const [data, setData] = useState<FleetData>(DISCONNECTED);

  useEffect(() => {
    startConnection();
    const tick = () => {
      let snap: FleetData | null = null;
      try {
        snap = readSnapshot();
      } catch (e) {
        console.error("Could not read the local cache:", e);
      }
      setData((prev) => ({ ...(snap ?? prev), connected: isConnected() }));
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  return data;
}