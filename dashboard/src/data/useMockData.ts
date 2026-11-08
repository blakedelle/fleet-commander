import { useEffect, useState } from "react";
import type {
  AgentEvent,
  Escalation,
  EventKind,
  FleetData,
  Incident,
  RawFields,
  Robot,
  TelemetrySample,
} from "../types";

// ---------------------------------------------------------------------------
// MOCK DATA: fake robots + scripted stories.
//   Auto story 1: robot-2 motor stall   (starts ~10 s after page load, gets fixed)
//   Auto story 2: robot-4 flipped over  (starts ~50 s after page load, escalated)
//   Buttons can also start: stall, drift (fixed), flipped (escalated).
// The `detail` JSON shapes below are MY ASSUMPTIONS (see "Contract change
// requests"). Replace them with the real shapes when the backend owner sends them.
// ---------------------------------------------------------------------------

export type MockFault = "stall" | "drift" | "flipped";

const ROBOT_IDS = ["robot-1", "robot-2", "robot-3", "robot-4"];
const MAX_SAMPLES = 120; // per robot
const CRUISE = 0.5; // m/s

// The fault buttons call these in mock mode (see data/actions.ts).
const pendingFaults: { robotId: string; fault: MockFault }[] = [];
const pendingRepairs: string[] = [];
export function injectMockFault(robotId: string, fault: MockFault) {
  pendingFaults.push({ robotId, fault });
}
export function injectMockRepair(robotId: string) {
  pendingRepairs.push(robotId);
}

interface SimRobot {
  robot: Robot;
  target: { x: number; y: number };
  fault: MockFault | null;
}
interface Step {
  atMs: number;
  run: (nowMs: number) => void;
}
interface World {
  robots: SimRobot[];
  incidents: Incident[];
  events: AgentEvent[];
  escalations: Escalation[];
  samples: TelemetrySample[];
  steps: Step[];
  nextId: { incident: number; event: number; escalation: number; sample: number };
}

const n = (amount: number) => (Math.random() - 0.5) * 2 * amount; // +/- noise
const randomPoint = () => ({ x: 1 + Math.random() * 18, y: 1 + Math.random() * 18 });

function rawOf(r: Robot): RawFields {
  return {
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
  };
}

// ---------------------------------------------------------------- physics
function physics(w: World, now: number) {
  for (const s of w.robots) {
    const r = s.robot;
    const halted = r.state === "STOPPED" || r.state === "QUARANTINED";
    const cmd = halted ? 0 : CRUISE;
    r.cmdLeft = cmd;
    r.cmdRight = cmd;

    // healthy defaults
    let moving = !halted;
    r.wLeft = halted ? 0 : cmd + n(0.02);
    r.wRight = halted ? 0 : cmd + n(0.02);
    r.iLeft = halted ? 0.1 + n(0.02) : 1.7 + n(0.4);
    r.iRight = halted ? 0.1 + n(0.02) : 1.7 + n(0.4);
    r.rollDeg = n(2);
    r.pitchDeg = n(2);

    if (s.fault === "stall" && !halted) {
      // left motor draws huge current, left wheel does not turn, robot stuck
      r.iLeft = 8 + n(0.3);
      r.wLeft = 0;
      r.iRight = 1.6 + n(0.2);
      r.wRight = 0.45 + n(0.03);
      moving = false;
    }
    if (s.fault === "flipped") {
      r.rollDeg = 178 + n(1);
      r.pitchDeg = n(2);
      if (!halted) {
        // wheels spin freely in the air: fast, almost no current
        r.wLeft = 0.9 + n(0.05);
        r.wRight = 0.9 + n(0.05);
        r.iLeft = 0.3 + n(0.05);
        r.iRight = 0.3 + n(0.05);
      }
      moving = false;
    }

    if (moving) {
      const dx = s.target.x - r.x;
      const dy = s.target.y - r.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.6) {
        s.target = randomPoint();
      } else {
        r.headingDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
        r.x = Math.min(20, Math.max(0, r.x + (dx / dist) * CRUISE));
        r.y = Math.min(20, Math.max(0, r.y + (dy / dist) * CRUISE));
      }
    }
    if (s.fault === "drift") {
      // sensors look normal, but the REPORTED position slowly slides away
      r.x = Math.min(20, Math.max(0, r.x + 0.12));
      r.y = Math.min(20, Math.max(0, r.y - 0.08));
    }
    r.speed = moving ? CRUISE : 0;

    r.batteryPct = Math.max(5, r.batteryPct - 0.03);
    r.vbatt = 22 + (3.2 * r.batteryPct) / 100 + n(0.03);
    r.lastSeenMs = now;

    w.samples.push({
      sampleId: w.nextId.sample++,
      robotId: r.robotId,
      tMs: now,
      ...rawOf(r),
    });
  }

  // keep only the newest MAX_SAMPLES per robot
  const count: Record<string, number> = {};
  const kept: TelemetrySample[] = [];
  for (let i = w.samples.length - 1; i >= 0; i--) {
    const id = w.samples[i].robotId;
    count[id] = (count[id] ?? 0) + 1;
    if (count[id] <= MAX_SAMPLES) kept.push(w.samples[i]);
  }
  w.samples = kept.reverse();
}

// ---------------------------------------------------------------- helpers
function openIncident(w: World, robotId: string, channels: string, t: number): Incident {
  const inc: Incident = {
    incidentId: w.nextId.incident++,
    robotId,
    status: "PENDING",
    trippedChannels: channels,
    createdMs: t,
    closedMs: null,
    diagnosis: null,
    confidence: null,
    outcome: null,
    summary: null,
  };
  w.incidents.push(inc);
  return inc;
}

function addEvent(
  w: World,
  inc: Incident,
  kind: EventKind,
  title: string,
  detail: object,
  t: number,
) {
  w.events.push({
    eventId: w.nextId.event++,
    incidentId: inc.incidentId,
    robotId: inc.robotId,
    tsMs: t,
    kind,
    title,
    detail: JSON.stringify(detail),
  });
}

function makeAt(w: World, t0: number) {
  return (sec: number, run: (t: number) => void) =>
    w.steps.push({ atMs: t0 + sec * 1000, run });
}

// ---------------------------------------------------------------- story 1
function scheduleStall(w: World, s: SimRobot, t0: number) {
  const id = s.robot.robotId;
  const at = makeAt(w, t0);
  let inc!: Incident;

  at(3, (t) => {
    inc = openIncident(w, id, "i_left,w_left,speed", t);
    s.robot.state = "INVESTIGATING";
  });
  at(4, (t) => {
    inc.status = "TRIAGING";
    addEvent(w, inc, "tool_call", "Fetching last 30 s of telemetry",
      { tool: "get_telemetry_window", args: { robot_id: id, seconds: 30 } }, t);
  });
  at(6, (t) =>
    addEvent(w, inc, "tool_result", "Telemetry window received",
      { tool: "get_telemetry_window",
        result: { i_left_a: 8.1, i_right_a: 1.6, w_left_ms: 0.0, w_right_ms: 0.45, speed_ms: 0.0 } }, t));
  at(8, (t) =>
    addEvent(w, inc, "tool_call", "Checking motion consistency",
      { tool: "check_motion_consistency", args: { robot_id: id } }, t));
  at(10, (t) =>
    addEvent(w, inc, "tool_result", "Position matches wheel encoders",
      { tool: "check_motion_consistency",
        result: { mismatch_m: 0.04, consistent: true, note: "Not odometry drift" } }, t));
  at(12, (t) =>
    addEvent(w, inc, "tool_call", "Comparing against healthy baseline",
      { tool: "compare_to_baseline", args: { robot_id: id } }, t));
  at(14, (t) =>
    addEvent(w, inc, "tool_result", "Left motor far outside baseline",
      { tool: "compare_to_baseline",
        result: { i_left_a: { now: 8.1, baseline: 1.7 }, w_left_ms: { now: 0.0, baseline: 0.5 } } }, t));
  at(16, (t) => {
    inc.diagnosis = "Left motor stall (mechanical obstruction)";
    inc.confidence = 0.93;
    addEvent(w, inc, "diagnosis", "Diagnosis: left motor stall",
      { root_cause: "Left motor stall (mechanical obstruction)",
        confidence: 0.93,
        evidence: [
          "Left motor current 8.1 A (baseline 1.7 A)",
          "Left wheel velocity 0.00 m/s while 0.50 m/s commanded",
          "Right motor current 1.6 A: right side healthy",
          "Position change over last 10 s: 0.0 m",
          "IMU roll 1.2°, pitch 0.8°: robot is upright",
        ] }, t);
  });
  at(18, (t) =>
    addEvent(w, inc, "action", "Action: reverse and retry",
      { action: "reverse_and_retry", args: { robot_id: id, distance_m: 0.3 },
        reason: "Least drastic fix. A motor-controller reboot does not clear a mechanical stall." }, t));
  at(21, (t) => {
    s.fault = null; // the robot really recovers here
    addEvent(w, inc, "tool_call", "Verifying with fresh telemetry",
      { tool: "get_telemetry_window", args: { robot_id: id, seconds: 5 } }, t);
  });
  at(23, (t) =>
    addEvent(w, inc, "tool_result", "Motor currents back to normal",
      { tool: "get_telemetry_window",
        result: { i_left_a: 1.7, w_left_ms: 0.49, speed_ms: 0.5, verdict: "recovered" } }, t));
  at(25, (t) => {
    inc.status = "RESOLVED";
    inc.closedMs = t;
    inc.outcome = "resolved";
    inc.summary = "Left motor stall cleared by reverse_and_retry; telemetry verified normal.";
    s.robot.state = "NOMINAL";
    addEvent(w, inc, "outcome", "Incident resolved",
      { outcome: "resolved", summary: inc.summary }, t);
  });
}

// ---------------------------------------------------------------- story 2
function scheduleFlip(w: World, s: SimRobot, t0: number) {
  const id = s.robot.robotId;
  const at = makeAt(w, t0);
  let inc!: Incident;
  const message = `${id} is flipped over (IMU roll 178°). Motors stopped and robot quarantined. Needs physical recovery on the warehouse floor.`;

  at(3, (t) => {
    inc = openIncident(w, id, "roll_deg,w_left,w_right,speed", t);
    s.robot.state = "INVESTIGATING";
  });
  at(4, (t) => {
    inc.status = "TRIAGING";
    addEvent(w, inc, "tool_call", "Fetching last 30 s of telemetry",
      { tool: "get_telemetry_window", args: { robot_id: id, seconds: 30 } }, t);
  });
  at(6, (t) =>
    addEvent(w, inc, "tool_result", "Telemetry window received",
      { tool: "get_telemetry_window",
        result: { roll_deg: 178.2, pitch_deg: 1.4, i_left_a: 0.3, i_right_a: 0.3,
                  w_left_ms: 0.9, w_right_ms: 0.9, speed_ms: 0.0 } }, t));
  at(8, (t) =>
    addEvent(w, inc, "tool_call", "Comparing against healthy baseline",
      { tool: "compare_to_baseline", args: { robot_id: id } }, t));
  at(10, (t) =>
    addEvent(w, inc, "tool_result", "IMU and motor current far outside baseline",
      { tool: "compare_to_baseline",
        result: { roll_deg: { now: 178.2, baseline: 1.1 }, motor_current_a: { now: 0.3, baseline: 1.8 } } }, t));
  at(12, (t) => {
    inc.diagnosis = "Robot flipped over (upside down)";
    inc.confidence = 0.96;
    addEvent(w, inc, "diagnosis", "Diagnosis: robot flipped over",
      { root_cause: "Robot flipped over (upside down)",
        confidence: 0.96,
        evidence: [
          "IMU roll 178.2° (normal: within 5°)",
          "Wheels spinning at 0.90 m/s vs 0.50 m/s commanded",
          "Motor current 0.3 A vs 1.8 A baseline: no load on wheels",
          "Speed 0.00 m/s: robot is not moving",
          "No remote action can right a flipped robot",
        ] }, t);
  });
  at(14, (t) => {
    s.robot.state = "STOPPED";
    addEvent(w, inc, "action", "Action: stop motors",
      { action: "stop_motors", args: { robot_id: id },
        reason: "Wheels are spinning in the air; stop them to avoid damage." }, t);
  });
  at(16, (t) => {
    s.robot.state = "QUARANTINED";
    addEvent(w, inc, "action", "Action: quarantine robot",
      { action: "quarantine_robot", args: { robot_id: id },
        reason: "Keep the robot out of the task queue until a human recovers it." }, t);
  });
  at(18, (t) => {
    w.escalations.push({
      escalationId: w.nextId.escalation++,
      incidentId: inc.incidentId,
      robotId: id,
      tsMs: t,
      department: "maintenance",
      priority: "high",
      message,
    });
    addEvent(w, inc, "escalation", "Escalated to maintenance (high priority)",
      { department: "maintenance", priority: "high", message }, t);
  });
  at(20, (t) => {
    inc.status = "ESCALATED";
    inc.closedMs = t;
    inc.outcome = "escalated";
    inc.summary = "Robot flipped; cannot be fixed remotely. Motors stopped, robot quarantined, maintenance notified.";
    addEvent(w, inc, "outcome", "Incident escalated to a human",
      { outcome: "escalated", summary: inc.summary }, t);
  });
  // Demo convenience: a human "rights" the robot so you can run the story again.
  // (Pressing Repair does the same thing earlier.)
  at(60, () => {
    if (s.fault === "flipped") {
      s.fault = null;
      s.robot.state = "NOMINAL";
    }
  });
}

// ---------------------------------------------------------------- story 3
function scheduleDrift(w: World, s: SimRobot, t0: number) {
  const id = s.robot.robotId;
  const at = makeAt(w, t0);
  let inc!: Incident;

  at(3, (t) => {
    inc = openIncident(w, id, "x,y,heading_deg", t);
    s.robot.state = "INVESTIGATING";
  });
  at(4, (t) => {
    inc.status = "TRIAGING";
    addEvent(w, inc, "tool_call", "Fetching last 30 s of telemetry",
      { tool: "get_telemetry_window", args: { robot_id: id, seconds: 30 } }, t);
  });
  at(6, (t) =>
    addEvent(w, inc, "tool_result", "Motors, wheels and IMU look normal",
      { tool: "get_telemetry_window",
        result: { i_left_a: 1.7, i_right_a: 1.6, w_left_ms: 0.5, w_right_ms: 0.49,
                  roll_deg: 0.8, note: "No electrical or mechanical anomaly" } }, t));
  at(8, (t) =>
    addEvent(w, inc, "tool_call", "Checking motion consistency",
      { tool: "check_motion_consistency", args: { robot_id: id } }, t));
  at(10, (t) =>
    addEvent(w, inc, "tool_result", "Reported position disagrees with wheel encoders",
      { tool: "check_motion_consistency",
        result: { mismatch_m: 1.8, consistent: false, note: "Position diverging from dead-reckoning" } }, t));
  at(12, (t) =>
    addEvent(w, inc, "tool_call", "Comparing against healthy baseline",
      { tool: "compare_to_baseline", args: { robot_id: id } }, t));
  at(14, (t) =>
    addEvent(w, inc, "tool_result", "Only position is outside baseline",
      { tool: "compare_to_baseline",
        result: { i_left_a: { now: 1.7, baseline: 1.7 }, w_left_ms: { now: 0.5, baseline: 0.5 },
                  roll_deg: { now: 0.8, baseline: 1.1 } } }, t));
  at(16, (t) => {
    inc.diagnosis = "Odometry drift (localization error)";
    inc.confidence = 0.89;
    addEvent(w, inc, "diagnosis", "Diagnosis: odometry drift",
      { root_cause: "Odometry drift (localization error)",
        confidence: 0.89,
        evidence: [
          "Position mismatch vs wheel encoders 1.8 m (normal: under 0.1 m)",
          "Wheel velocities 0.50 m/s match the 0.50 m/s command",
          "Motor currents 1.7 A and 1.6 A: normal",
          "IMU roll 0.8°, pitch 0.6°: upright and stable",
          "Mismatch is growing steadily, not a sudden jump",
        ] }, t);
  });
  at(18, (t) =>
    addEvent(w, inc, "action", "Action: recalibrate odometry",
      { action: "recalibrate_odometry", args: { robot_id: id },
        reason: "Sensors are healthy, so recalibrate odometry. Rebooting localization is the fallback." }, t));
  at(21, (t) => {
    s.fault = null; // drift stops here
    addEvent(w, inc, "tool_call", "Verifying with fresh telemetry",
      { tool: "check_motion_consistency", args: { robot_id: id } }, t);
  });
  at(23, (t) =>
    addEvent(w, inc, "tool_result", "Position matches wheel encoders again",
      { tool: "check_motion_consistency",
        result: { mismatch_m: 0.03, consistent: true, verdict: "recovered" } }, t));
  at(25, (t) => {
    inc.status = "RESOLVED";
    inc.closedMs = t;
    inc.outcome = "resolved";
    inc.summary = "Odometry drift cleared by recalibrate_odometry; position verified consistent.";
    s.robot.state = "NOMINAL";
    addEvent(w, inc, "outcome", "Incident resolved",
      { outcome: "resolved", summary: inc.summary }, t);
  });
}

function startFault(w: World, robotId: string, fault: MockFault, t: number) {
  const s = w.robots.find((x) => x.robot.robotId === robotId);
  if (!s || s.fault || s.robot.state !== "NOMINAL") return; // robot is busy
  s.fault = fault;
  if (fault === "stall") scheduleStall(w, s, t);
  else if (fault === "drift") scheduleDrift(w, s, t);
  else scheduleFlip(w, s, t);
}

// ---------------------------------------------------------------- world
function createWorld(now: number): World {
  const robots: SimRobot[] = ROBOT_IDS.map((id) => {
    const p = randomPoint();
    return {
      robot: {
        robotId: id, state: "NOMINAL", lastSeenMs: now,
        vbatt: 24, batteryPct: 60 + Math.random() * 35,
        iLeft: 1.7, iRight: 1.7, cmdLeft: CRUISE, cmdRight: CRUISE,
        wLeft: CRUISE, wRight: CRUISE, x: p.x, y: p.y,
        headingDeg: 0, speed: CRUISE, rollDeg: 0, pitchDeg: 0,
      },
      target: randomPoint(),
      fault: null,
    };
  });

  const w: World = {
    robots, incidents: [], events: [], escalations: [], samples: [], steps: [],
    nextId: { incident: 1, event: 1, escalation: 1, sample: 1 },
  };

  // 60 s of healthy history so charts are not empty later
  for (let i = 60; i > 0; i--) physics(w, now - i * 1000);

  // The two automatic stories
  w.steps.push({ atMs: now + 10_000, run: (t) => startFault(w, "robot-2", "stall", t) });
  w.steps.push({ atMs: now + 50_000, run: (t) => startFault(w, "robot-4", "flipped", t) });
  return w;
}

function tick(w: World, now: number) {
  while (pendingFaults.length) {
    const p = pendingFaults.shift()!;
    startFault(w, p.robotId, p.fault, now);
  }
  while (pendingRepairs.length) {
    const id = pendingRepairs.shift()!;
    const s = w.robots.find((x) => x.robot.robotId === id);
    if (s && (s.robot.state === "QUARANTINED" || s.robot.state === "STOPPED")) {
      s.fault = null;
      s.robot.state = "NOMINAL";
    }
  }
  const due = w.steps.filter((s) => s.atMs <= now).sort((a, b) => a.atMs - b.atMs);
  w.steps = w.steps.filter((s) => s.atMs > now);
  due.forEach((s) => s.run(now));
  physics(w, now);
}

// React needs NEW objects/arrays to notice changes, so we copy on publish.
function snapshot(w: World): FleetData {
  return {
    robots: w.robots.map((s) => ({ ...s.robot })),
    incidents: w.incidents.map((i) => ({ ...i })),
    events: [...w.events],
    escalations: [...w.escalations],
    samples: [...w.samples],
    connected: true,
  };
}

const EMPTY: FleetData = {
  robots: [], incidents: [], events: [], escalations: [], samples: [], connected: true,
};

export function useMockData(): FleetData {
  const [data, setData] = useState<FleetData>(EMPTY);

  useEffect(() => {
    const world = createWorld(Date.now());
    setData(snapshot(world));
    const timer = setInterval(() => {
      tick(world, Date.now());
      setData(snapshot(world));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return data;
}