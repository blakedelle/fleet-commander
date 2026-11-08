import 'dotenv/config';
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://integrate.api.nvidia.com/v1',
  apiKey: process.env.NVIDIA_API_KEY,
  timeout: 120_000, // give up on a single call after 2 minutes
});
const MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';

// ---------------------------------------------------------------
// A tiny differential-drive robot with a HIDDEN fault.
// The model never sees `fault`; it only sees raw sensor numbers.
// ---------------------------------------------------------------

/** HIDDEN fault type */
type Fault = 'none' | 'stall' | 'drift' | 'flipped';

/** 
 * The structure of a sensor sample.
 * 
 * Inlcudes:
 * - `t`: timestamp
 * - `vbatt`: battery voltage
 * - `iL`: left motor current
 * - `iR`: right motor current
 * - `cmdL`: left motor command
 * - `cmdR`: right motor command
 * - `wL`: left wheel speed
 * - `wR`: right wheel speed
 * - `x`: reported x position
 * - `y`: reported y position
 * - `hdg`: reported heading (degrees)
 * - `speed`: reported speed
 * - `roll`: IMU roll (degrees)
 * - `pitch`: IMU pitch (degrees)
 */
interface Sample {
  t: number; vbatt: number; iL: number; iR: number;
  cmdL: number; cmdR: number; wL: number; wR: number;
  x: number; y: number; hdg: number; speed: number;
  roll: number; pitch: number;
}

/** The distance between the two wheels (meters) */
const WHEELBASE = 0.4;
const noise = (s: number) => (Math.random() - 0.5) * 2 * s;
const rnd = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const mean = (a: number[]) => a.reduce((s, n) => s + n, 0) / a.length;

class RobotSim {
  samples: Sample[] = [];
  t = 0;
  fault: Fault = 'none';
  x = 10; y = 10; hdg = 0;          // true pose (radians for hdg)
  driftX = 0; driftY = 0;           // error added to the REPORTED position
  stopped = false;
  speedLimit = 0.5;
  reverseSteps = 0;
  actions: { t: number; name: string }[] = [];

  step() {
    this.t += 1;
    let v = this.stopped ? 0 : Math.min(0.5, this.speedLimit);
    let omega = this.stopped ? 0 : 0.15 * Math.sin(this.t / 10);
    if (this.reverseSteps > 0) { v = -0.3; omega = 0; }
    const cmdL = v - (omega * WHEELBASE) / 2;
    const cmdR = v + (omega * WHEELBASE) / 2;

    // Healthy behavior
    let wL = cmdL + noise(0.02);
    let wR = cmdR + noise(0.02);
    let iL = 0.25 + 3.0 * Math.abs(cmdL) + noise(0.1);
    let iR = 0.25 + 3.0 * Math.abs(cmdR) + noise(0.1);
    let roll = noise(1.5);
    let pitch = noise(1.5);
    let vTrue = (wL + wR) / 2;
    let omegaTrue = (wR - wL) / WHEELBASE;

    if (this.fault === 'stall' && this.reverseSteps === 0) {
      if (this.stopped) {
        wL = 0; wR = 0; iL = 0.25 + noise(0.05); iR = 0.25 + noise(0.05);
      } else {
        wL = noise(0.01); iL = 8 + noise(0.5);
        wR = 0.08 + noise(0.02); iR = 2.6 + noise(0.2);
      }
      vTrue = this.stopped ? 0 : 0.02; omegaTrue = 0;
    }

    if (this.fault === 'flipped') {
      roll = 178 + noise(2); pitch = 2 + noise(2);
      if (this.stopped) {
        wL = 0; wR = 0; iL = 0.2 + noise(0.05); iR = 0.2 + noise(0.05);
      } else {
        wL = cmdL * 1.15 + noise(0.03); wR = cmdR * 1.15 + noise(0.03);
        iL = 0.4 + 0.5 * Math.abs(cmdL) + noise(0.05);
        iR = 0.4 + 0.5 * Math.abs(cmdR) + noise(0.05);
      }
      vTrue = 0; omegaTrue = 0;
    }

    if (this.fault === 'drift') {
      this.driftX += 0.2 + noise(0.03);
      this.driftY += -0.12 + noise(0.03);
    }

    this.hdg += omegaTrue;
    this.x += vTrue * Math.cos(this.hdg);
    this.y += vTrue * Math.sin(this.hdg);

    const rx = this.x + this.driftX;
    const ry = this.y + this.driftY;
    const prev = this.samples[this.samples.length - 1];
    const speed = prev ? Math.hypot(rx - prev.x, ry - prev.y) : 0;
    const vbatt = 25.0 - this.t * 0.003 - 0.04 * (iL + iR) + noise(0.02);

    this.samples.push({
      t: this.t, vbatt: rnd(vbatt), iL: rnd(iL), iR: rnd(iR),
      cmdL: rnd(cmdL), cmdR: rnd(cmdR), wL: rnd(wL), wR: rnd(wR),
      x: rnd(rx), y: rnd(ry), hdg: rnd((this.hdg * 180) / Math.PI, 1),
      speed: rnd(speed), roll: rnd(roll, 1), pitch: rnd(pitch, 1),
    });

    if (this.reverseSteps > 0) {
      this.reverseSteps--;
      // Backing up frees a jammed drive
      if (this.reverseSteps === 0 && this.fault === 'stall') this.fault = 'none';
    }
  }

  advance(n: number) { for (let i = 0; i < n; i++) this.step(); }

  // Actions change the robot, then 8 simulated seconds pass.
  act(name: string, args: any): string {
    const effectiveT = this.t + 1;
    this.actions.push({ t: effectiveT, name });
    switch (name) {
      case 'stop_motors': this.stopped = true; break;
      case 'quarantine_robot': this.stopped = true; break;
      case 'set_speed_limit':
        this.speedLimit = Math.max(0.05, Math.min(0.5, Number(args.max_speed_mps) || 0.5)); break;
      case 'reverse_and_retry': this.stopped = false; this.reverseSteps = 4; break;
      case 'reboot_subsystem':
        this.stopped = false;
        if (args.subsystem === 'localization' && this.fault === 'drift') {
          this.fault = 'none'; this.driftX = 0; this.driftY = 0;
        }
        break; // rebooting the motor controller does NOT free a mechanical jam
      case 'recalibrate_odometry':
        this.stopped = false;
        if (this.fault === 'drift') { this.fault = 'none'; this.driftX = 0; this.driftY = 0; }
        break;
      case 'return_to_base': this.stopped = false; break;
    }
    this.advance(8);
    return `Action '${name}' executed, effective from t=${effectiveT}. 8 seconds have passed (now t=${this.t}). Only telemetry rows with t >= ${effectiveT} reflect this action; earlier rows are from before it.`;  }
}

function makeScenario(kind: Fault): RobotSim {
  const sim = new RobotSim();
  sim.advance(40);      // 40 seconds of healthy driving
  sim.fault = kind;     // fault begins
  sim.advance(15);      // 15 seconds of the fault
  return sim;
}

// ---------------------------------------------------------------
// Investigation tools (they do the math; the model interprets)
// ---------------------------------------------------------------
function telemetryWindow(sim: RobotSim, seconds: number): string {
  const n = Math.max(5, Math.min(60, Math.floor(seconds)));
  const rows = sim.samples.slice(-n);
  const stride = n > 30 ? 2 : 1;
  const header = 't,vbatt_V,iL_A,iR_A,cmdL,cmdR,wL,wR,x,y,hdg_deg,speed,roll_deg,pitch_deg';
  const lines = rows
    .filter((_, i) => i % stride === 0)
    .map((s) => [s.t, s.vbatt, s.iL, s.iR, s.cmdL, s.cmdR, s.wL, s.wR, s.x, s.y, s.hdg, s.speed, s.roll, s.pitch].join(','));
  const log = sim.actions.map((a) => `# action at t=${a.t}: ${a.name} (rows before this t do not reflect it)`);
  return [header, ...lines, ...log].join('\n');
}

function consistency(w: Sample[]) {
  let dx = 0, dy = 0, encDist = 0, reportedPath = 0;
  for (let i = 1; i < w.length; i++) {
    const v = (w[i].wL + w[i].wR) / 2;
    const h = (w[i].hdg * Math.PI) / 180;
    dx += v * Math.cos(h); dy += v * Math.sin(h);
    encDist += Math.abs(v);
    reportedPath += Math.hypot(w[i].x - w[i - 1].x, w[i].y - w[i - 1].y);
  }
  const first = w[0], last = w[w.length - 1];
  return {
    samples: w.length,
    distance_implied_by_wheel_encoders_m: rnd(encDist),
    distance_implied_by_reported_position_m: rnd(reportedPath),
    dead_reckoning_endpoint_error_m: rnd(Math.hypot(first.x + dx - last.x, first.y + dy - last.y)),
  };
}

function motionConsistency(sim: RobotSim, seconds: number): string {
  const n = Math.max(5, Math.min(60, Math.floor(seconds)));
  const w = sim.samples.slice(-n);
  const lastAction = sim.actions[sim.actions.length - 1];
  const result: Record<string, unknown> = { whole_window: consistency(w) };
  if (lastAction) {
    const since = w.filter((s) => s.t >= lastAction.t);
    result.last_action = lastAction;
    result.since_last_action =
      since.length >= 5 ? consistency(since) : `only ${since.length} samples since the last action; too few to judge`;
    result.note = 'whole_window includes rows from before the last action. Judge the action using since_last_action.';
  }
  return JSON.stringify(result);
}

function baselineComparison(sim: RobotSim): string {
  const base = sim.samples.slice(5, 35);
  const recent = sim.samples.slice(-8);
  const keys: (keyof Sample)[] = ['vbatt', 'iL', 'iR', 'cmdL', 'cmdR', 'wL', 'wR', 'speed', 'roll', 'pitch'];
  const out: Record<string, { baseline_mean: number; recent_mean: number }> = {};
  for (const k of keys) {
    out[k] = {
      baseline_mean: rnd(mean(base.map((s) => s[k] as number))),
      recent_mean: rnd(mean(recent.map((s) => s[k] as number))),
    };
  }
  return JSON.stringify(out);
}

function healthCheck(sim: RobotSim): string {
  const lastT = sim.actions.length ? sim.actions[sim.actions.length - 1].t : 0;
  const w = sim.samples.filter((s) => s.t >= lastT).slice(-30);
  if (w.length < 5) {
    return JSON.stringify({ result: 'INSUFFICIENT_DATA', samples_since_last_action: w.length, note: 'need at least 5 samples since the last action' });
  }
  const c = consistency(w);
  const checks = {
    battery_voltage_ok: w.every((s) => s.vbatt >= 22),
    motor_current_ok: w.every((s) => s.iL < 4 && s.iR < 4),
    wheels_follow_commands: w.every((s) => Math.abs(s.cmdL - s.wL) < 0.15 && Math.abs(s.cmdR - s.wR) < 0.15),
    imu_upright: w.every((s) => Math.abs(s.roll) < 30 && Math.abs(s.pitch) < 30),
    position_matches_encoders: c.dead_reckoning_endpoint_error_m < 1.0,
  };
  const drivingCommanded = w.some((s) => Math.abs(s.cmdL) > 0.05 || Math.abs(s.cmdR) > 0.05);
  return JSON.stringify({
    result: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    samples_checked: w.length,
    checks,
    note: drivingCommanded ? 'robot is being commanded to drive' : 'robot is stopped, so motion-based checks are not very informative',
  });
}

const FLEET_CONTEXT = JSON.stringify({
  note: 'Latest readings from other robots in the fleet',
  'robot-1': 'all channels within normal ranges',
  'robot-3': 'all channels within normal ranges',
  'robot-4': 'all channels within normal ranges',
});

// ---------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------
const S = { type: 'string' };
const ROBOT = { robot_id: S };

function fn(name: string, description: string, properties: Record<string, any>, required: string[]) {
  return {
    type: 'function' as const,
    function: { name, description, parameters: { type: 'object', properties, required } },
  };
}

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  fn('get_telemetry_window', 'Get recent raw telemetry rows (one per second) for a robot. Columns: t, battery voltage, left/right motor current, commanded and measured left/right wheel velocity (m/s), reported x/y position (m), heading, speed, IMU roll and pitch (degrees).',
    { ...ROBOT, seconds: { type: 'number', description: 'seconds of history, 5 to 60' } }, ['robot_id', 'seconds']),
  fn('check_motion_consistency', 'Dead-reckon from the measured wheel velocities and compare against the reported position over a time window. Returns distances implied by each source and the endpoint error.',
    { ...ROBOT, seconds: { type: 'number' } }, ['robot_id', 'seconds']),
  fn('compare_to_baseline', 'Compare each telemetry channel in the last few seconds with its average from the robot\'s earlier normal operation.', ROBOT, ['robot_id']),
  fn('get_fleet_context', 'Get a summary of the other robots in the fleet, to check whether the problem is isolated.', {}, []),
  fn('run_health_check', 'Run the fleet\'s standard automated self-test using only telemetry recorded since the last corrective action. Returns PASS/FAIL per channel. Use it to verify that a fix worked.', ROBOT, ['robot_id']),  
  fn('stop_motors', 'Immediately stop driving the motors and hold the robot. Cheap and safe.', ROBOT, ['robot_id']),
  fn('set_speed_limit', 'Cap the robot\'s maximum speed.', { ...ROBOT, max_speed_mps: { type: 'number' } }, ['robot_id', 'max_speed_mps']),
  fn('reverse_and_retry', 'Back the robot up about a meter, then resume normal driving. Cheap and low risk.', ROBOT, ['robot_id']),
  fn('reboot_subsystem', 'Restart a software or firmware subsystem. Causes a brief interruption.',
    { ...ROBOT, subsystem: { type: 'string', enum: ['motor_controller', 'localization', 'imu'] } }, ['robot_id', 'subsystem']),
  fn('recalibrate_odometry', 'Reset the odometry and localization estimate against the map.', ROBOT, ['robot_id']),
  fn('return_to_base', 'Command the robot to drive itself to the charging dock. Requires working drive and localization.', ROBOT, ['robot_id']),
  fn('quarantine_robot', 'Remove the robot from the active fleet so no new tasks are assigned to it.',
    { ...ROBOT, reason: S }, ['robot_id', 'reason']),
  fn('escalate_to_human', 'Alert human engineers with a message they can act on.',
    { message: S, department: { type: 'string', enum: ['maintenance', 'safety', 'software'] }, priority: { type: 'string', enum: ['low', 'medium', 'high'] } },
    ['message', 'department', 'priority']),
  fn('report_diagnosis', 'Record your diagnosis. Cite specific numbers from the telemetry as evidence.',
    { root_cause: S, confidence: { type: 'number', description: '0 to 1' }, evidence: { type: 'array', items: S } },
    ['root_cause', 'confidence', 'evidence']),
  fn('finish_incident', 'Close the incident. Call this last.',
    { outcome: { type: 'string', enum: ['resolved', 'escalated', 'unresolved'] }, summary: S }, ['outcome', 'summary']),
];

const SYSTEM_PROMPT = `You are an autonomous RoboOps engineer for a warehouse robot fleet.
You do not talk to a user. An automated anomaly gate flagged a robot; you must diagnose the cause from raw sensor data and fix it or escalate.

Robot specs: differential-drive wheeled robot, wheelbase 0.4 m, cruise speed about 0.5 m/s. Normal battery voltage is 22 to 25.2 V. Normal motor current while cruising is about 1 to 2.5 A. The IMU roll and pitch are normally within about 5 degrees. Failures can be mechanical, electrical, sensor, software, or environmental, and may be ones you have not seen before.

Process:
1. Investigate with the data tools before taking any action. Reason physically about what combination of readings points to which cause.
2. Choose the least drastic action that could work, and avoid actions that could damage the robot.
3. After acting, call run_health_check to verify the fix. Judge an action only from telemetry with t at or after the action's effective time: a sudden jump in reported position right when a recalibration or localization restart takes effect is the correction being applied, not a new fault. Never repeat an action that already failed.
4. If the problem cannot be fixed remotely or there is a safety or hardware risk, protect the robot and escalate with a message a human can act on.
5. Call report_diagnosis with specific numeric evidence, then call finish_incident.
Only use the tools provided and only the robot_id given in the incident.`;

const TRIPPED: Record<string, string> = {
  stall: 'wheel_velocity_error, motor_current',
  drift: 'pose_vs_encoder_consistency',
  flipped: 'speed_vs_command, imu_attitude',
};

function runTool(sim: RobotSim, name: string, args: any): string {
  if (args.robot_id !== undefined && args.robot_id !== 'robot-2') {
    return `Error: unknown robot_id '${args.robot_id}'.`;
  }
  switch (name) {
    case 'get_telemetry_window': return telemetryWindow(sim, Number(args.seconds) || 30);
    case 'check_motion_consistency': return motionConsistency(sim, Number(args.seconds) || 30);
    case 'compare_to_baseline': return baselineComparison(sim);
    case 'get_fleet_context': return FLEET_CONTEXT;
    case 'run_health_check': return healthCheck(sim);        
    case 'escalate_to_human':
      console.log(`   >> ESCALATION [${args.priority}] to ${args.department}: ${args.message}`);
      return 'Alert sent to human engineers.';
    case 'report_diagnosis':
      console.log(`   >> DIAGNOSIS (${args.confidence}): ${args.root_cause}`);
      console.log(`      Evidence: ${JSON.stringify(args.evidence)}`);
      return 'Diagnosis recorded.';
    case 'finish_incident':
      console.log(`   >> OUTCOME: ${args.outcome}. ${args.summary}`);
      return 'Incident closed.';
    default:
      return sim.act(name, args);
  }
}

async function callModel(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await client.chat.completions.create({
        model: MODEL, messages, tools, tool_choice: 'auto', temperature: 0.2,
      });
    } catch (err: any) {
      const status = err?.status as number | undefined;
      // Retry network drops (no status), rate limits (429), and server errors (5xx).
      // Don't retry bad requests or bad keys, because retrying can't fix those.
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable || attempt === maxAttempts) throw err;
      const waitMs = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s
      console.log(
        `   (model call failed: ${err?.code ?? err?.message ?? status}; retrying in ${waitMs / 1000}s, attempt ${attempt + 1}/${maxAttempts})`
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error('unreachable');
}

async function main() {
  const kind = (process.argv[2] ?? 'stall') as Fault;
  if (!['stall', 'drift', 'flipped'].includes(kind)) {
    console.log('Usage: tsx src/nemotron-diagnose.ts stall|drift|flipped');
    return;
  }
  const sim = makeScenario(kind);

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Incident #1: anomaly gate tripped on robot-2. Tripped channels: ${TRIPPED[kind]}. Investigate, diagnose, and resolve or escalate.` },
  ];

  for (let turn = 1; turn <= 14; turn++) {
    console.log(`\n--- Model call ${turn} ---`);
    const response = await callModel(messages);
    const msg = response.choices[0].message;
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log('Model says:', msg.content);
      break;
    }
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });

    let finished = false;
    for (const call of msg.tool_calls) {
      if (call.type !== 'function') continue;
      let args: any = {};
      try { args = JSON.parse(call.function.arguments); } catch { /* leave empty */ }
      console.log(`Tool call: ${call.function.name}`, JSON.stringify(args));
      const result = runTool(sim, call.function.name, args);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      if (call.function.name === 'finish_incident') finished = true;
    }
    if (finished) break;
  }

  console.log('\n=== GROUND TRUTH (the model never saw this) ===');
  console.log(`Injected fault: ${kind}`);
  console.log(`Fault still active at the end? ${sim.fault !== 'none'}`);
}

main().catch(console.error);