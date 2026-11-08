import 'dotenv/config';
import OpenAI from 'openai';
import { DbConnection, tables } from './module_bindings/index.js';

// ---------------- Config ----------------
const HOST = 'ws://localhost:3000';
const DB_NAME = 'fleet-commander';
const MODEL = process.env.NEMOTRON_MODEL ?? 'nvidia/nemotron-3.5-super-vl-120b-a12b';

const CLAIM_DELAY_MS = 6000;    // let all tripped channels show up before the AI starts
const SETTLE_FIX_MS = 9000;     // after a fix, wait so fresh telemetry exists to verify it
const SETTLE_STOP_MS = 3000;
const ACK_TIMEOUT_MS = 8000;    // how long to wait for the simulator to acknowledge a command
const MAX_TURNS = 16;           // model calls per incident
const MAX_ACTIONS = 6;          // robot commands per incident
const MAX_SESSIONS = 3;         // attempts before giving up on the AI and escalating to a human
const WATCHDOG_MS = 30_000;
const STUCK_AFTER_MS = 180_000; // a TRIAGING incident with no new events for this long is requeued
const WHEELBASE = 0.4;

if (!process.env.NVIDIA_API_KEY) {
  console.error('NVIDIA_API_KEY is missing. Put it in your .env file.');
  process.exit(1);
}

const client = new OpenAI({
  baseURL: 'https://integrate.api.nvidia.com/v1',
  apiKey: process.env.NVIDIA_API_KEY,
  timeout: 120_000,
});

// ---------------- Small helpers ----------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const mean = (a: number[]) => (a.length ? a.reduce((s, n) => s + n, 0) / a.length : 0);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const clip = (s: string, n = 500) => (s.length > n ? s.slice(0, n) + ' …' : s);

// ---------------- Types ----------------
interface S {
  tMs: number; t: number;
  vbatt: number; iL: number; iR: number;
  cmdL: number; cmdR: number; wL: number; wR: number;
  x: number; y: number; hdg: number; speed: number;
  roll: number; pitch: number;
}
interface Ctx {
  id: number;
  robotId: string;
  createdMs: number;
  actions: { tMs: number; name: string; args: any; result: string }[];
  diagnosed: boolean;
  escalated: boolean;
  closed: boolean;
  actionCount: number;
}

// ---------------- Database access (reads come from the local cache) ----------------
let conn!: DbConnection;
const getRobot = (id: string) => [...conn.db.robot.iter()].find((r) => r.robotId === id);
const getGate = (id: string) => [...conn.db.gateState.iter()].find((g) => g.robotId === id);
const getIncident = (id: number) => [...conn.db.incident.iter()].find((i) => i.incidentId === id);

function samplesFor(robotId: string, createdMs: number): S[] {
  return [...conn.db.telemetrySample.iter()]
    .filter((r) => r.robotId === robotId)
    .sort((a, b) => a.tMs - b.tMs)
    .map((r) => ({
      tMs: r.tMs,
      t: rnd((r.tMs - createdMs) / 1000, 1),
      vbatt: r.vbatt, iL: r.iLeft, iR: r.iRight,
      cmdL: r.cmdLeft, cmdR: r.cmdRight, wL: r.wLeft, wR: r.wRight,
      x: r.x, y: r.y, hdg: r.headingDeg, speed: r.speed,
      roll: r.rollDeg, pitch: r.pitchDeg,
    }));
}

const rel = (ctx: Ctx, tMs: number) => rnd((tMs - ctx.createdMs) / 1000, 1);

async function logEvent(incidentId: number, robotId: string, kind: string, title: string, detail: unknown) {
  try {
    await conn.reducers.logAgentEvent({
      incidentId, robotId, tsMs: Date.now(), kind, title, detail: JSON.stringify(detail),
    });
  } catch (e) {
    console.error('Could not log event:', e);
  }
}

// ---------------- Analysis tools (they do the math; the model interprets) ----------------
function consistency(w: S[]) {
  if (w.length < 3) return { samples: w.length, note: 'too few samples to analyze' };
  let enc = 0, rep = 0, encYaw = 0, repYaw = 0, rx = 0, ry = 0, resid = 0;
  let incX = 0, incY = 0, sumUx = 0, sumUy = 0, big = 0, totalDt = 0;
  let firstBad: number | null = null;
  for (let i = 1; i < w.length; i++) {
    const dt = clamp((w[i].tMs - w[i - 1].tMs) / 1000, 0.2, 3);
    totalDt += dt;
    const v = (w[i].wL + w[i].wR) / 2;
    const h = (w[i].hdg * Math.PI) / 180;
    const sx = v * dt * Math.cos(h);
    const sy = v * dt * Math.sin(h);
    const px = w[i].x - w[i - 1].x;
    const py = w[i].y - w[i - 1].y;
    enc += Math.abs(v) * dt;
    rep += Math.hypot(px, py);
    encYaw += ((w[i].wR - w[i].wL) / WHEELBASE) * dt * (180 / Math.PI);
    let dh = w[i].hdg - w[i - 1].hdg;
    dh = ((dh + 540) % 360) - 180;
    repYaw += dh;
    rx += sx; ry += sy;
    resid = Math.hypot(w[i].x - w[0].x - rx, w[i].y - w[0].y - ry);
    if (firstBad === null && resid > 0.5) firstBad = w[i].t;
    const ex = px - sx;
    const ey = py - sy;
    incX += ex; incY += ey;
    const m = Math.hypot(ex, ey);
    if (m > 0.05) { sumUx += ex / m; sumUy += ey / m; big++; }
  }
  return {
    samples: w.length,
    window_s: rnd(totalDt, 0),
    distance_implied_by_wheel_encoders_m: rnd(enc),
    distance_implied_by_reported_position_m: rnd(rep),
    dead_reckoning_endpoint_error_m: rnd(resid),
    heading_change_implied_by_encoders_deg: rnd(encYaw, 1),
    reported_heading_change_deg: rnd(repYaw, 1),
    position_residual_first_exceeds_0_5m_at_t: firstBad,
    mean_position_error_rate_m_per_s: rnd(Math.hypot(incX, incY) / Math.max(1, totalDt)),
    position_error_direction_deg: rnd((Math.atan2(incY, incX) * 180) / Math.PI, 0),
    position_error_direction_consistency_0_to_1: big >= 3 ? rnd(Math.hypot(sumUx, sumUy) / big) : null,
  };
}

function telemetryWindow(ctx: Ctx, seconds: number): string {
  const n = clamp(Math.floor(seconds), 5, 60);
  const rows = samplesFor(ctx.robotId, ctx.createdMs).slice(-n);
  const stride = n > 30 ? 2 : 1;
  const header = 't_s,vbatt_V,iL_A,iR_A,cmdL,cmdR,wL,wR,x,y,hdg_deg,speed,roll_deg,pitch_deg';
  const lines = rows
    .filter((_, i) => i % stride === 0)
    .map((s) => [s.t, s.vbatt, s.iL, s.iR, s.cmdL, s.cmdR, s.wL, s.wR, s.x, s.y, s.hdg, s.speed, s.roll, s.pitch].join(','));
  const log = ctx.actions.map(
    (a) => `# action at t=${rel(ctx, a.tMs)}: ${a.name} (rows before this t do not reflect it)`
  );
  return [header, ...lines, ...log].join('\n');
}

function motionConsistency(ctx: Ctx, seconds: number): string {
  const n = clamp(Math.floor(seconds), 5, 60);
  const w = samplesFor(ctx.robotId, ctx.createdMs).slice(-n);
  const result: Record<string, unknown> = { whole_window: consistency(w) };
  const last = ctx.actions[ctx.actions.length - 1];
  if (last) {
    const since = w.filter((s) => s.tMs >= last.tMs);
    result.last_action = { t: rel(ctx, last.tMs), name: last.name };
    result.since_last_action =
      since.length >= 5 ? consistency(since) : `only ${since.length} samples since the last action; too few to judge`;
    result.note = 'whole_window includes rows from before the last action. Judge the action using since_last_action.';
  }
  return JSON.stringify(result);
}

function baselineComparison(ctx: Ctx): string {
  const all = samplesFor(ctx.robotId, ctx.createdMs);
  const base = all.filter((s) => s.t < -8).slice(-30); // healthy period before the incident opened
  const recent = all.slice(-8);
  if (base.length < 5) {
    return JSON.stringify({ note: 'Not enough healthy history before the incident to build a baseline.', samples_available: all.length });
  }
  const keys: (keyof S)[] = ['vbatt', 'iL', 'iR', 'cmdL', 'cmdR', 'wL', 'wR', 'speed', 'roll', 'pitch'];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const b = mean(base.map((s) => s[k] as number));
    const r = mean(recent.map((s) => s[k] as number));
    out[k] = {
      baseline_mean: rnd(b),
      recent_mean: rnd(r),
      change_pct: Math.abs(b) > 0.05 ? rnd(((r - b) / Math.abs(b)) * 100, 0) : null,
    };
  }
  return JSON.stringify(out);
}

function fleetContext(ctx: Ctx): string {
  const now = Date.now();
  const others = [...conn.db.robot.iter()]
    .filter((r) => r.robotId !== ctx.robotId)
    .map((r) => {
      const g = getGate(r.robotId);
      return {
        robot_id: r.robotId,
        state: r.state,
        channels_tripped_now: g && g.trippedNow ? g.trippedNow : 'none',
        last_seen_s_ago: rnd((now - r.lastSeenMs) / 1000, 0),
        battery_pct: r.batteryPct,
        speed: r.speed,
        roll_deg: r.rollDeg,
      };
    });
  return JSON.stringify({ other_robots: others });
}

// The fleet's standard self-test: the anomaly gate is the single definition of "healthy"
function healthVerdict(ctx: Ctx): any {
  const gate = getGate(ctx.robotId);
  const tripped = gate && gate.trippedNow ? gate.trippedNow.split(',').filter(Boolean) : [];
  const last = ctx.actions[ctx.actions.length - 1];
  const since = samplesFor(ctx.robotId, ctx.createdMs).filter((s) => !last || s.tMs >= last.tMs);
  if (since.length < 5) {
    return { result: 'INSUFFICIENT_DATA', samples_since_last_action: since.length, note: 'Need at least 5 samples since the last action. Wait and check again.' };
  }
  if (tripped.length > 0) {
    return { result: 'FAIL', anomaly_channels_tripped: tripped, samples_since_last_action: since.length };
  }
  const recent = since.slice(-8);
  const driving = mean(recent.map((s) => (Math.abs(s.cmdL) + Math.abs(s.cmdR)) / 2)) > 0.1;
  const clean = gate ? gate.cleanStreak : 0;
  if (!driving) {
    return {
      result: 'INCONCLUSIVE_ROBOT_NOT_DRIVING',
      note: 'The robot is stopped or docked, so no anomaly shows, but drive-related faults cannot be ruled out. Let it drive again to verify, or escalate.',
    };
  }
  if (clean < 5) {
    return { result: 'INSUFFICIENT_DATA', note: `The gate has been clean for only ${clean} samples; need 5. Wait and check again.` };
  }
  return { result: 'PASS', samples_checked: since.length, consecutive_clean_samples: clean };
}

// ---------------- Tool definitions ----------------
const ROBOT = { robot_id: { type: 'string' } };
function fn(name: string, description: string, properties: Record<string, any>, required: string[]) {
  return {
    type: 'function' as const,
    function: { name, description, parameters: { type: 'object', properties, required } },
  };
}

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  fn('get_telemetry_window', 'Get recent raw telemetry rows (about one per second) for the robot. t_s is seconds relative to when the incident opened (negative = before). Columns: battery voltage, left/right motor current, commanded and measured left/right wheel velocity (m/s), reported x/y position (m), heading, speed, IMU roll and pitch (degrees). Corrective actions are listed at the end.',
    { ...ROBOT, seconds: { type: 'number', description: 'seconds of history, 5 to 60' } }, ['robot_id', 'seconds']),
  fn('check_motion_consistency', 'Dead-reckon from the measured wheel velocities and compare against the reported position and heading over a window. Returns distances implied by each source, endpoint error, when the divergence began, and whether the position error has a steady direction. If a corrective action was taken, also returns the same analysis using only data since that action.',
    { ...ROBOT, seconds: { type: 'number' } }, ['robot_id', 'seconds']),
  fn('compare_to_baseline', "Compare each telemetry channel's recent average with its average during the robot's earlier normal operation, with percent change.", ROBOT, ['robot_id']),
  fn('get_fleet_context', 'Get the state and anomaly status of the other robots in the fleet, to check whether the problem is isolated.', {}, []),
  fn('run_health_check', "Run the fleet's standard automated self-test using only telemetry recorded since the last corrective action. Returns PASS, FAIL, or why it is inconclusive. Use it to verify that a fix worked.", ROBOT, ['robot_id']),
  fn('stop_motors', 'Immediately stop driving the motors and hold the robot. Cheap and safe.', ROBOT, ['robot_id']),
  fn('set_speed_limit', "Cap the robot's maximum speed.", { ...ROBOT, max_speed_mps: { type: 'number' } }, ['robot_id', 'max_speed_mps']),
  fn('reverse_and_retry', 'Back the robot up about a meter, then resume normal driving. Cheap and low risk.', ROBOT, ['robot_id']),
  fn('reboot_subsystem', 'Restart a software or firmware subsystem. Causes a brief interruption.',
    { ...ROBOT, subsystem: { type: 'string', enum: ['motor_controller', 'localization', 'imu'] } }, ['robot_id', 'subsystem']),
  fn('recalibrate_odometry', 'Reset the odometry and localization estimate against the map.', ROBOT, ['robot_id']),
  fn('return_to_base', 'Command the robot to drive itself to the charging dock. Requires working drive and localization.', ROBOT, ['robot_id']),
  fn('quarantine_robot', 'Remove the robot from the active fleet so no new tasks are assigned to it and it stays stopped.',
    { ...ROBOT, reason: { type: 'string' } }, ['robot_id', 'reason']),
  fn('escalate_to_human', 'Alert human engineers with a message they can act on.',
    {
      message: { type: 'string' },
      department: { type: 'string', enum: ['maintenance', 'safety', 'software'] },
      priority: { type: 'string', enum: ['low', 'medium', 'high'] },
    }, ['message', 'department', 'priority']),
  fn('report_diagnosis', 'Record your diagnosis. Evidence must be an array of strings, each a specific measurement or observation taken from tool outputs.',
    {
      root_cause: { type: 'string' },
      confidence: { type: 'number', description: '0 to 1' },
      evidence: { type: 'array', items: { type: 'string' } },
    }, ['root_cause', 'confidence', 'evidence']),
  fn('finish_incident', 'Close the incident. Call report_diagnosis first. Closing as resolved requires a passing health check after your last action.',
    { outcome: { type: 'string', enum: ['resolved', 'escalated', 'unresolved'] }, summary: { type: 'string' } },
    ['outcome', 'summary']),
];

const DATA_TOOLS = new Set(['get_telemetry_window', 'check_motion_consistency', 'compare_to_baseline', 'get_fleet_context', 'run_health_check']);
const ACTION_TOOLS = new Set(['stop_motors', 'set_speed_limit', 'reverse_and_retry', 'reboot_subsystem', 'recalibrate_odometry', 'return_to_base', 'quarantine_robot']);

const FULL_PRINT = new Set(['report_diagnosis', 'escalate_to_human', 'finish_incident', 'quarantine_robot']);
const VERBOSE = !!process.env.VERBOSE;

const SYSTEM_PROMPT = `You are an autonomous RoboOps engineer for a warehouse robot fleet.
You do not talk to a user. An automated anomaly gate flagged a robot; you must diagnose the cause from raw sensor data and fix it or escalate.

Gate definitions (the tripped channels say THAT something is off, never WHY):
- wheel_velocity_error: a measured wheel speed differs from its commanded speed by more than 0.15 m/s
- motor_current: either motor current is above 4 A
- imu_attitude: roll or pitch is beyond 30 degrees
- battery_voltage: battery voltage is below 21.5 V
- pose_vs_encoder: the reported position step disagrees with wheel-encoder dead reckoning by more than 0.12 m
- speed_vs_command: the robot is commanded to drive but its reported speed is near zero

Robot specs: differential-drive wheeled robot, wheelbase 0.4 m, cruise speed about 0.5 m/s, in a 20 m x 20 m warehouse with a charging dock near (1.5, 1.5). Normal battery voltage is 22 to 25.2 V. Normal motor current while cruising is about 1 to 2.5 A. IMU roll and pitch are normally within about 5 degrees. Robots drive to the dock when their battery is low and are stationary while docked. Failures can be mechanical, electrical, sensor, software, or environmental, and may be ones you have not seen before.

Physics notes: motor current rises with mechanical load. A wheel spinning at its commanded speed while drawing unusually LOW current is spinning unloaded (no traction or contact). IMU roll and pitch describe the physical orientation of the chassis, so consider what physical state the robot is in before concluding that a sensor is faulty. Prefer the single explanation that accounts for ALL anomalous channels over several independent sensor faults. If the position error accumulates in one fixed direction at a steady rate regardless of the robot's heading (consistency near 1), suspect a bias in the position estimate rather than wheel slip, which follows the direction of travel.

Process:
1. Investigate with the data tools before taking any action. Reason physically about which combination of readings points to which cause.
2. Before acting, state at least two competing explanations and name the measurement that tells them apart. Physical hypotheses are allowed as long as you label them as hypotheses and point to the readings that support them.
3. Safety first: if the readings suggest an unsafe physical state that no software action can make safe, call stop_motors BEFORE trying any software fix. For a fault that has a cheap, low-risk remote remedy, you do not need to stop first. Choose the least drastic action that could work.
4. After acting, call run_health_check to verify the fix. Judge an action only from telemetry with t at or after the action's effective time: a sudden jump in reported position right when a recalibration or localization restart takes effect is the correction being applied, not a new fault. Never repeat an action that already failed.
5. After a fix works, check your root cause against it: the cause you report must explain why that specific fix worked. If it does not, revise the diagnosis before reporting. Do not describe environmental details (surfaces, obstacles) that no sensor reports; if you suspect one, label it as a hypothesis and lower your confidence.
6. 6. Attempt a cheap, low-risk remote remedy ONCE before escalating. Escalate when the remedy fails verification, when there is a safety or hardware risk that the robot cannot be made safe from remotely, or when the problem cannot be fixed remotely at all. When you escalate, protect the robot (stop it, quarantine it), call escalate_to_human with a message that says what physically needs to happen, and only then close the incident.
7. Cite as evidence only measurements that appear in tool outputs. Do not claim something is physically impossible or abnormal unless a tool result shows it. Lower your confidence when part of your explanation is interpretation rather than measurement.
8. Call report_diagnosis with specific numeric evidence (an array of strings), then call finish_incident.
Only use the tools provided and only the robot_id of this incident.`;

// ---------------- Model call with retries (retries the request only, never tool execution) ----------------
async function callModel(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (process.env.SIMULATE_NET_FAIL && attempt <= 2) throw new Error('simulated network failure');
      return await client.chat.completions.create({
        model: MODEL, messages, tools, tool_choice: 'auto', temperature: 0.2,
      });
    } catch (err: any) {
      const status = err?.status as number | undefined;
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable || attempt === maxAttempts) throw err;
      const waitMs = Math.min(1000 * 2 ** (attempt - 1), 15000);
      console.log(`    (model call failed: ${err?.code ?? err?.message ?? status}; retrying in ${waitMs / 1000}s, attempt ${attempt + 1}/${maxAttempts})`);
      await sleep(waitMs);
    }
  }
  throw new Error('unreachable');
}

// ---------------- Acting on robots ----------------
async function sendCommand(ctx: Ctx, command: string, args: any): Promise<string> {
  if (ctx.actionCount >= MAX_ACTIONS) {
    return 'Error: the action limit for this incident has been reached. Escalate to a human.';
  }
  ctx.actionCount++;
  const tsMs = Date.now();
  await conn.reducers.issueCommand({
    robotId: ctx.robotId, incidentId: ctx.id, command, args: JSON.stringify(args), tsMs,
  });

  // Wait for the simulator to apply it and acknowledge
  const deadline = Date.now() + ACK_TIMEOUT_MS;
  let row: any = null;
  while (Date.now() < deadline) {
    row = [...conn.db.robotCommand.iter()].find(
      (c) => c.robotId === ctx.robotId && c.incidentId === ctx.id && c.command === command && c.tsMs === tsMs
    );
    if (row && row.status !== 'PENDING') break;
    await sleep(300);
  }
  if (!row || row.status === 'PENDING') {
    await logEvent(ctx.id, ctx.robotId, 'action', command, { args, accepted: false, result: 'no acknowledgment from the robot' });
    return 'Error: the robot did not acknowledge the command. It may be offline.';
  }
  if (row.status === 'REJECTED') {
    await logEvent(ctx.id, ctx.robotId, 'action', command, { args, accepted: false, result: row.result });
    return `Command rejected: ${row.result}`;
  }

  const effectiveMs = Date.now();
  ctx.actions.push({ tMs: effectiveMs, name: command, args, result: row.result });
  await logEvent(ctx.id, ctx.robotId, 'action', command, { args, accepted: true, result: row.result });

  const settle = command === 'stop_motors' || command === 'quarantine_robot' ? SETTLE_STOP_MS : SETTLE_FIX_MS;
  await sleep(settle);
  const t0 = rel(ctx, effectiveMs);
  return `Robot acknowledged: "${row.result}" Effective from t=${t0}. Waited ${settle / 1000} s so fresh telemetry exists; only rows with t >= ${t0} reflect this action.`;
}

function normalizeEvidence(ev: unknown): string[] | null {
  let e: unknown = ev;
  if (typeof e === 'string') {
    try { e = JSON.parse(e); }
    catch {
      try { e = (JSON.parse(`[${e}]`) as unknown[]).flat(); }
      catch { e = [e]; }
    }
  }
  if (!Array.isArray(e) || e.length === 0 || e.some((x) => typeof x !== 'string' || !x.trim())) return null;
  return e as string[];
}

async function executeTool(ctx: Ctx, name: string, args: any): Promise<string> {
  if (ctx.closed) return 'Error: this incident is already closed.';
  if (args.robot_id !== undefined && args.robot_id !== ctx.robotId) {
    return `Error: unknown robot_id '${args.robot_id}'. This incident concerns ${ctx.robotId}.`;
  }
  const full = VERBOSE || FULL_PRINT.has(name);
  console.log(`    [#${ctx.id}] ${name} ${full ? JSON.stringify(args, null, 2) : clip(JSON.stringify(args), 160)}`);

  if (DATA_TOOLS.has(name)) {
    await logEvent(ctx.id, ctx.robotId, 'tool_call', name, args);
    let result: string;
    switch (name) {
      case 'get_telemetry_window': result = telemetryWindow(ctx, Number(args.seconds) || 30); break;
      case 'check_motion_consistency': result = motionConsistency(ctx, Number(args.seconds) || 30); break;
      case 'compare_to_baseline': result = baselineComparison(ctx); break;
      case 'get_fleet_context': result = fleetContext(ctx); break;
      default: result = JSON.stringify(healthVerdict(ctx));
    }
    await logEvent(ctx.id, ctx.robotId, 'tool_result', name, { result: clip(result) });
    return result;
  }

  if (ACTION_TOOLS.has(name)) {
    let cmdArgs: any = {};
    if (name === 'set_speed_limit') {
      const v = Number(args.max_speed_mps);
      if (!Number.isFinite(v)) return 'Error: max_speed_mps must be a number.';
      cmdArgs = { max_speed_mps: clamp(v, 0.05, 0.5) };
    } else if (name === 'reboot_subsystem') {
      if (!['motor_controller', 'localization', 'imu'].includes(args.subsystem)) {
        return "Error: subsystem must be one of 'motor_controller', 'localization', 'imu'.";
      }
      cmdArgs = { subsystem: args.subsystem };
    } else if (name === 'quarantine_robot') {
      cmdArgs = { reason: String(args.reason ?? '') };
    }
    await logEvent(ctx.id, ctx.robotId, 'tool_call', name, cmdArgs);
    return sendCommand(ctx, name, cmdArgs);
  }

  switch (name) {
    case 'escalate_to_human': {
      const { message, department, priority } = args;
      if (typeof message !== 'string' || !message.trim()) return 'Error: message must be a non-empty string.';
      if (!['maintenance', 'safety', 'software'].includes(department)) return "Error: department must be 'maintenance', 'safety', or 'software'.";
      if (!['low', 'medium', 'high'].includes(priority)) return "Error: priority must be 'low', 'medium', or 'high'.";
      await conn.reducers.recordEscalation({
        incidentId: ctx.id, robotId: ctx.robotId, tsMs: Date.now(), department, priority, message,
      });
      await logEvent(ctx.id, ctx.robotId, 'escalation', `Escalated to ${department}`, { department, priority, message });
      ctx.escalated = true;
      return 'Alert sent to human engineers.';
    }
    case 'report_diagnosis': {
      const evidence = normalizeEvidence(args.evidence);
      if (!evidence) return 'Error: evidence must be a non-empty array of strings, one measurement or observation per item. Call report_diagnosis again.';
      if (typeof args.root_cause !== 'string' || !args.root_cause.trim()) return 'Error: root_cause must be a non-empty string.';
      const confidence = clamp(Number(args.confidence) || 0, 0, 1);
      await conn.reducers.recordDiagnosis({ incidentId: ctx.id, rootCause: args.root_cause, confidence });
      await logEvent(ctx.id, ctx.robotId, 'diagnosis', 'Diagnosis', { root_cause: args.root_cause, confidence, evidence });
      ctx.diagnosed = true;
      return 'Diagnosis recorded.';
    }
    case 'finish_incident': {
      const { outcome, summary } = args;
      if (!['resolved', 'escalated', 'unresolved'].includes(outcome)) return "Error: outcome must be 'resolved', 'escalated', or 'unresolved'.";
      if (typeof summary !== 'string' || !summary.trim()) return 'Error: summary must be a non-empty string.';
      if (!ctx.diagnosed) return 'Error: call report_diagnosis before finish_incident.';
      if (outcome === 'escalated' && !ctx.escalated) {
        return 'Error: you cannot close as escalated without alerting a human. Call escalate_to_human first with a message that says what physically needs to happen, then call finish_incident.';
      }
      if (outcome === 'resolved') {
        const v = healthVerdict(ctx);
        if (v.result !== 'PASS') {
          return `Error: cannot close as resolved. The automated health check says ${v.result}: ${JSON.stringify(v)}. Verify the fix, try something different, or escalate.`;
        }
      }
      await conn.reducers.closeIncident({ incidentId: ctx.id, outcome, summary, tsMs: Date.now() });
      await logEvent(ctx.id, ctx.robotId, 'outcome', outcome, { outcome, summary });
      ctx.closed = true;
      return 'Incident closed.';
    }
    default:
      return `Error: unknown tool '${name}'.`;
  }
}

// ---------------- Fallback: hand the incident to a human ----------------
async function fallbackClose(ctx: Ctx, reason: string, department: string, priority: string) {
  const message = `${reason}. Robot ${ctx.robotId} needs human attention.`;
  await conn.reducers.recordEscalation({
    incidentId: ctx.id, robotId: ctx.robotId, tsMs: Date.now(), department, priority, message,
  });
  await logEvent(ctx.id, ctx.robotId, 'escalation', 'Automated escalation', { department, priority, message });
  await conn.reducers.closeIncident({ incidentId: ctx.id, outcome: 'escalated', summary: reason, tsMs: Date.now() });
  await logEvent(ctx.id, ctx.robotId, 'outcome', 'escalated', { outcome: 'escalated', summary: reason });
  ctx.closed = true;
  console.log(`  [#${ctx.id}] escalated automatically: ${reason}`);
}

// ---------------- Handling one incident ----------------
const sessions = new Map<number, number>();

async function handleIncident(incId: number) {
  const inc = getIncident(incId);
  if (!inc || inc.status !== 'PENDING') return;

  const ctx: Ctx = {
    id: inc.incidentId, robotId: inc.robotId, createdMs: inc.createdMs,
    actions: [], diagnosed: false, escalated: false, closed: false, actionCount: 0,
  };

  // Actions from an earlier session on this same incident (after a requeue)
  const prior = [...conn.db.robotCommand.iter()]
    .filter((c) => c.incidentId === ctx.id && c.status === 'APPLIED')
    .sort((a, b) => a.tsMs - b.tsMs);
  for (const c of prior) {
    let a: any = {};
    try { a = JSON.parse(c.args); } catch { /* args may be plain text */ }
    ctx.actions.push({ tMs: c.tsMs, name: c.command, args: a, result: c.result });
  }
  ctx.actionCount = prior.length;

  console.log(`\n=== Incident #${ctx.id} on ${ctx.robotId} (channels: ${inc.trippedChannels}) ===`);
  await conn.reducers.claimIncident({ incidentId: ctx.id });
  await logEvent(ctx.id, ctx.robotId, 'system', 'Investigation started', {
    message: 'AI triage claimed the incident.', tripped_channels: inc.trippedChannels,
  });

  let opening =
    `Incident #${ctx.id}: the anomaly gate tripped on ${ctx.robotId}. Channels tripped so far: ${inc.trippedChannels}.\n` +
    `Time convention: t=0 is when the incident opened; telemetry rows use seconds relative to that (negative = before).`;
  if (prior.length > 0) {
    opening +=
      `\nActions already taken earlier on this incident (they did not close it):\n` +
      prior.map((c) => `- t=${rel(ctx, c.tsMs)}: ${c.command} ${c.args} -> ${c.result}`).join('\n') +
      `\nDo not repeat an action that already failed.`;
  }
  opening += '\nInvestigate, diagnose, and resolve or escalate.';

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: opening },
  ];

  try {
    let nudges = 0;
    for (let turn = 1; turn <= MAX_TURNS && !ctx.closed; turn++) {
      console.log(`  [#${ctx.id}] model call ${turn}`);
      const response = await callModel(messages);
      const msg = response.choices[0].message;

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        messages.push({ role: 'assistant', content: msg.content ?? '' });
        messages.push({ role: 'user', content: 'Continue using the tools. When you are done, call report_diagnosis and then finish_incident.' });
        if (++nudges > 2) break;
        continue;
      }

      messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        if (call.type !== 'function') continue;
        let args: any = {};
        try { args = JSON.parse(call.function.arguments); } catch { /* leave empty */ }
        const result = await executeTool(ctx, call.function.name, args);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
  } catch (e: any) {
    const n = (sessions.get(ctx.id) ?? 0) + 1;
    sessions.set(ctx.id, n);
    const why = e?.cause?.cause?.code ?? e?.cause?.code ?? e?.message ?? String(e);
    console.error(`  [#${ctx.id}] AI session failed (${why}). Attempt ${n}/${MAX_SESSIONS}.`);
    if (n >= MAX_SESSIONS) {
      await fallbackClose(ctx, 'Automated triage was unavailable after repeated attempts', 'software', 'high');
    } else {
      await logEvent(ctx.id, ctx.robotId, 'system', 'AI unavailable: incident requeued', { message: String(why) });
      await conn.reducers.requeueIncident({ incidentId: ctx.id });
    }
    return;
  }

  if (!ctx.closed) {
    await fallbackClose(ctx, 'Automated triage reached its limit without a conclusion', 'maintenance', 'medium');
  }
}

// ---------------- Queue: one incident at a time ----------------
const scheduled = new Set<number>();
const queue: number[] = [];
let current: number | null = null;
let working = false;

function schedule(id: number, delay = CLAIM_DELAY_MS) {
  if (scheduled.has(id) || id === current) return;
  scheduled.add(id);
  setTimeout(() => { queue.push(id); void pump(); }, delay);
}

async function pump() {
  if (working) return;
  working = true;
  try {
    while (queue.length > 0) {
      const id = queue.shift()!;
      scheduled.delete(id);
      const inc = getIncident(id);
      if (!inc || inc.status !== 'PENDING') continue;
      current = id;
      try { await handleIncident(id); }
      catch (e) { console.error('Incident handler crashed:', e); }
      current = null;
      const again = getIncident(id);
      if (again && again.status === 'PENDING') schedule(id, 20_000); // requeued after a failure
    }
  } finally {
    working = false;
  }
}

function watchdog() {
  const now = Date.now();
  for (const inc of [...conn.db.incident.iter()]) {
    if (inc.status === 'PENDING') {
      schedule(inc.incidentId);
    } else if (inc.status === 'TRIAGING' && inc.incidentId !== current) {
      const evs = [...conn.db.agentEvent.iter()].filter((e) => e.incidentId === inc.incidentId);
      const lastTs = evs.length > 0 ? Math.max(...evs.map((e) => e.tsMs)) : inc.createdMs;
      if (now - lastTs > STUCK_AFTER_MS) {
        console.log(`[watchdog] incident #${inc.incidentId} looks stuck; requeueing`);
        void logEvent(inc.incidentId, inc.robotId, 'system', 'Watchdog requeued a stuck incident', { message: 'No activity for several minutes.' });
        conn.reducers.requeueIncident({ incidentId: inc.incidentId }).catch(console.error);
      }
    }
  }
}

// ---------------- Connect ----------------
DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .onConnectError((...args) => console.error('Connection failed:', args))
  .onDisconnect(() => console.log('Disconnected from SpacetimeDB.'))
  .onConnect((c) => {
    conn = c;

    c.db.incident.onInsert((_ctx, row) => {
      if (row.status === 'PENDING') schedule(row.incidentId);
    });
    c.db.incident.onUpdate((_ctx, oldRow, row) => {
      if (row.status === 'PENDING' && oldRow.status !== 'PENDING') schedule(row.incidentId);
    });

    c.subscriptionBuilder()
      .onApplied(() => {
        console.log(`Bridge connected. Model: ${MODEL}. Watching for incidents.`);
        for (const inc of [...conn.db.incident.iter()]) {
          if (inc.status === 'PENDING') schedule(inc.incidentId);
          else if (inc.status === 'TRIAGING') {
            // a previous bridge process died mid-incident
            conn.reducers.requeueIncident({ incidentId: inc.incidentId }).catch(console.error);
          }
        }
      })
      .subscribe([tables.robot, tables.telemetrySample, tables.gateState, tables.incident, tables.agentEvent, tables.robotCommand]);

    setInterval(watchdog, WATCHDOG_MS);
  })
  .build();