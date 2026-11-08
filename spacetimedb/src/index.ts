import { schema, table, t } from 'spacetimedb/server';

// Raw sensor fields, shared by several tables and reducers.
// A function, so every use gets fresh column definitions.
const raw = () => ({
  vbatt: t.f64(),
  battery_pct: t.f64(),
  i_left: t.f64(),
  i_right: t.f64(),
  cmd_left: t.f64(),
  cmd_right: t.f64(),
  w_left: t.f64(),
  w_right: t.f64(),
  x: t.f64(),
  y: t.f64(),
  heading_deg: t.f64(),
  speed: t.f64(),
  roll_deg: t.f64(),
  pitch_deg: t.f64(),
});

const spacetimedb = schema({
  robot: table(
    { public: true },
    {
      robot_id: t.string().primaryKey(),
      state: t.string(), // NOMINAL | INVESTIGATING | STOPPED | QUARANTINED
      last_seen_ms: t.f64(),
      ...raw(),
    }
  ),
  telemetry_sample: table(
    { public: true },
    {
      sample_id: t.u32().primaryKey().autoInc(),
      robot_id: t.string(),
      t_ms: t.f64(),
      ...raw(),
    }
  ),
  // Per-robot memory for the anomaly gate
  gate_state: table(
    { public: true },
    {
      robot_id: t.string().primaryKey(),
      streaks: t.string(),      // consecutive-violation counts, in CHANNELS order
      clean_streak: t.u32(),    // consecutive samples with no violations at all
      tripped_now: t.string(),  // channels currently tripped, comma separated
    }
  ),
  incident: table(
    { public: true },
    {
      incident_id: t.u32().primaryKey().autoInc(),
      robot_id: t.string(),
      status: t.string(),       // PENDING | TRIAGING | RESOLVED | ESCALATED
      tripped_channels: t.string(),
      created_ms: t.f64(),
      closed_ms: t.f64(),
      diagnosis: t.string(),
      confidence: t.f64(),
      outcome: t.string(),
      summary: t.string(),
    }
  ),
  agent_event: table(
    { public: true },
    {
      event_id: t.u32().primaryKey().autoInc(),
      incident_id: t.u32(),
      robot_id: t.string(),
      ts_ms: t.f64(),
      kind: t.string(),         // tool_call | tool_result | action | diagnosis | escalation | outcome
      title: t.string(),
      detail: t.string(),       // JSON text
    }
  ),
  escalation: table(
    { public: true },
    {
      escalation_id: t.u32().primaryKey().autoInc(),
      incident_id: t.u32(),
      robot_id: t.string(),
      ts_ms: t.f64(),
      department: t.string(),
      priority: t.string(),
      message: t.string(),
    }
  ),
  // The AI (or a human) asks; the simulator applies the command and acknowledges.
  robot_command: table(
    { public: true },
    {
      command_id: t.u32().primaryKey().autoInc(),
      robot_id: t.string(),
      incident_id: t.u32(),
      command: t.string(),
      args: t.string(),
      ts_ms: t.f64(),
      status: t.string(),       // PENDING | APPLIED | REJECTED
      result: t.string(),
    }
  ),
  // Demo buttons: "make this robot fail"
  fault_request: table(
    { public: true },
    {
      request_id: t.u32().primaryKey().autoInc(),
      robot_id: t.string(),
      fault: t.string(),        // stall | drift | flipped
      ts_ms: t.f64(),
      status: t.string(),       // PENDING | APPLIED
    }
  ),
});

export default spacetimedb;

// ---------------------------------------------------------------
// Anomaly gate: deliberately crude. It says THAT something is off and
// WHICH channels tripped. It never says why; that's the AI's job.
// ---------------------------------------------------------------
const CHANNELS = [
  'wheel_velocity_error',  // measured wheel speed differs from commanded
  'motor_current',         // either motor current very high
  'imu_attitude',          // roll or pitch far from level
  'battery_voltage',       // voltage too low
  'pose_vs_encoder',       // reported position step disagrees with wheel encoders
  'speed_vs_command',      // told to drive, but reported speed is near zero
];
const NEED = [3, 3, 2, 3, 3, 3]; // consecutive violating samples before a channel trips
const SAMPLE_KEEP_MS = 150_000;  // keep about 2.5 minutes of samples per robot

const rawOf = (a: any) => ({
  vbatt: a.vbatt,
  battery_pct: a.battery_pct,
  i_left: a.i_left,
  i_right: a.i_right,
  cmd_left: a.cmd_left,
  cmd_right: a.cmd_right,
  w_left: a.w_left,
  w_right: a.w_right,
  x: a.x,
  y: a.y,
  heading_deg: a.heading_deg,
  speed: a.speed,
  roll_deg: a.roll_deg,
  pitch_deg: a.pitch_deg,
});

export const process_telemetry = spacetimedb.reducer(
  { robot_id: t.string(), t_ms: t.f64(), ...raw() },
  (ctx, a) => {
    const prev = ctx.db.robot.robot_id.find(a.robot_id);

    // --- 1. Run the gate on this sample ---
    let residual = 0;
    if (prev) {
      const dt = (a.t_ms - prev.last_seen_ms) / 1000;
      if (dt > 0 && dt < 3) {
        const v = (a.w_left + a.w_right) / 2;
        const h = (a.heading_deg * Math.PI) / 180;
        residual = Math.hypot(
          a.x - prev.x - v * dt * Math.cos(h),
          a.y - prev.y - v * dt * Math.sin(h)
        );
      }
    }
    const cmdAvg = (Math.abs(a.cmd_left) + Math.abs(a.cmd_right)) / 2;
    const viol: Record<string, boolean> = {
      wheel_velocity_error:
        Math.max(Math.abs(a.cmd_left - a.w_left), Math.abs(a.cmd_right - a.w_right)) > 0.15,
      motor_current: Math.max(a.i_left, a.i_right) > 4.0,
      imu_attitude: Math.abs(a.roll_deg) > 30 || Math.abs(a.pitch_deg) > 30,
      battery_voltage: a.vbatt < 21.5,
      pose_vs_encoder: residual > 0.12,
      speed_vs_command: cmdAvg > 0.2 && a.speed < 0.1,
    };

    const gs = ctx.db.gate_state.robot_id.find(a.robot_id);
    const old = gs ? gs.streaks.split(',').map(Number) : CHANNELS.map(() => 0);
    const streaks = CHANNELS.map((c, i) => (viol[c] ? (old[i] || 0) + 1 : 0));
    const tripped = CHANNELS.filter((_c, i) => streaks[i] >= NEED[i]);
    const anyViolation = CHANNELS.some((c) => viol[c]);
    const cleanStreak = anyViolation ? 0 : gs ? gs.clean_streak + 1 : 1;

    const gateRow = {
      robot_id: a.robot_id,
      streaks: streaks.join(','),
      clean_streak: cleanStreak,
      tripped_now: tripped.join(','),
    };
    if (gs) ctx.db.gate_state.robot_id.update(gateRow);
    else ctx.db.gate_state.insert(gateRow);

    // --- 2. Open an incident if needed (never for a quarantined robot) ---
    let state = prev ? prev.state : 'NOMINAL';
    if (tripped.length > 0 && state !== 'QUARANTINED') {
      let open = false;
      for (const inc of ctx.db.incident.iter()) {
        if (inc.robot_id === a.robot_id && (inc.status === 'PENDING' || inc.status === 'TRIAGING')) {
          open = true;
          break;
        }
      }
      if (!open) {
        ctx.db.incident.insert({
          incident_id: 0,
          robot_id: a.robot_id,
          status: 'PENDING',
          tripped_channels: tripped.join(','),
          created_ms: a.t_ms,
          closed_ms: 0,
          diagnosis: '',
          confidence: 0,
          outcome: '',
          summary: '',
        });
        if (state === 'NOMINAL') state = 'INVESTIGATING';
      }
    }

    // --- 3. Store the robot's current state and the sample ---
    const robotRow = { robot_id: a.robot_id, state, last_seen_ms: a.t_ms, ...rawOf(a) };
    if (prev) ctx.db.robot.robot_id.update(robotRow);
    else ctx.db.robot.insert(robotRow);

    ctx.db.telemetry_sample.insert({
      sample_id: 0,
      robot_id: a.robot_id,
      t_ms: a.t_ms,
      ...rawOf(a),
    });

    // --- 4. Prune old samples for this robot ---
    const cutoff = a.t_ms - SAMPLE_KEEP_MS;
    const stale: number[] = [];
    for (const s of ctx.db.telemetry_sample.iter()) {
      if (s.robot_id === a.robot_id && s.t_ms < cutoff) stale.push(s.sample_id);
    }
    for (const id of stale) ctx.db.telemetry_sample.sample_id.delete(id);
  }
);

// ---------------------------------------------------------------
// Incident lifecycle (called by the Nemotron bridge)
// ---------------------------------------------------------------
export const claim_incident = spacetimedb.reducer(
  { incident_id: t.u32() },
  (ctx, a) => {
    const inc = ctx.db.incident.incident_id.find(a.incident_id);
    if (inc && inc.status === 'PENDING') {
      ctx.db.incident.incident_id.update({ ...inc, status: 'TRIAGING' });
    }
  }
);

// Watchdog: put a stuck incident back in the queue
export const requeue_incident = spacetimedb.reducer(
  { incident_id: t.u32() },
  (ctx, a) => {
    const inc = ctx.db.incident.incident_id.find(a.incident_id);
    if (inc && inc.status === 'TRIAGING') {
      ctx.db.incident.incident_id.update({ ...inc, status: 'PENDING' });
    }
  }
);

export const log_agent_event = spacetimedb.reducer(
  {
    incident_id: t.u32(),
    robot_id: t.string(),
    ts_ms: t.f64(),
    kind: t.string(),
    title: t.string(),
    detail: t.string(),
  },
  (ctx, a) => {
    ctx.db.agent_event.insert({ event_id: 0, ...a });
  }
);

export const record_diagnosis = spacetimedb.reducer(
  { incident_id: t.u32(), root_cause: t.string(), confidence: t.f64() },
  (ctx, a) => {
    const inc = ctx.db.incident.incident_id.find(a.incident_id);
    if (inc) {
      ctx.db.incident.incident_id.update({
        ...inc,
        diagnosis: a.root_cause,
        confidence: a.confidence,
      });
    }
  }
);

export const record_escalation = spacetimedb.reducer(
  {
    incident_id: t.u32(),
    robot_id: t.string(),
    ts_ms: t.f64(),
    department: t.string(),
    priority: t.string(),
    message: t.string(),
  },
  (ctx, a) => {
    ctx.db.escalation.insert({ escalation_id: 0, ...a });
  }
);

export const close_incident = spacetimedb.reducer(
  { incident_id: t.u32(), outcome: t.string(), summary: t.string(), ts_ms: t.f64() },
  (ctx, a) => {
    const inc = ctx.db.incident.incident_id.find(a.incident_id);
    if (!inc) return;
    const status = a.outcome === 'resolved' ? 'RESOLVED' : 'ESCALATED';
    ctx.db.incident.incident_id.update({
      ...inc,
      status,
      outcome: a.outcome,
      summary: a.summary,
      closed_ms: a.ts_ms,
    });
    const r = ctx.db.robot.robot_id.find(inc.robot_id);
    if (r && status === 'RESOLVED' && r.state !== 'QUARANTINED') {
      ctx.db.robot.robot_id.update({ ...r, state: 'NOMINAL' });
    }
  }
);

// ---------------------------------------------------------------
// Commands to robots
// ---------------------------------------------------------------
const RESUME_COMMANDS = [
  'reverse_and_retry', 'reboot_subsystem', 'recalibrate_odometry',
  'return_to_base', 'set_speed_limit',
];

function queueCommand(
  ctx: any,
  robot_id: string,
  incident_id: number,
  command: string,
  args: string,
  ts_ms: number
) {
  ctx.db.robot_command.insert({
    command_id: 0, robot_id, incident_id, command, args, ts_ms, status: 'PENDING', result: '',
  });
  const r = ctx.db.robot.robot_id.find(robot_id);
  if (!r) return;
  let state = r.state;
  if (command === 'stop_motors' && state !== 'QUARANTINED') state = 'STOPPED';
  if (command === 'quarantine_robot') state = 'QUARANTINED';
  if (command === 'human_repair') state = 'NOMINAL';
  if (RESUME_COMMANDS.includes(command) && state === 'STOPPED') state = 'INVESTIGATING';
  if (state !== r.state) ctx.db.robot.robot_id.update({ ...r, state });
}

export const issue_command = spacetimedb.reducer(
  {
    robot_id: t.string(),
    incident_id: t.u32(),
    command: t.string(),
    args: t.string(),
    ts_ms: t.f64(),
  },
  (ctx, a) => {
    queueCommand(ctx, a.robot_id, a.incident_id, a.command, a.args, a.ts_ms);
  }
);

// A human fixes the robot (for the demo: after an escalation)
export const repair_robot = spacetimedb.reducer(
  { robot_id: t.string(), ts_ms: t.f64() },
  (ctx, a) => {
    queueCommand(ctx, a.robot_id, 0, 'human_repair', 'none', a.ts_ms);
  }
);

export const ack_command = spacetimedb.reducer(
  { command_id: t.u32(), status: t.string(), result: t.string() },
  (ctx, a) => {
    const c = ctx.db.robot_command.command_id.find(a.command_id);
    if (c) ctx.db.robot_command.command_id.update({ ...c, status: a.status, result: a.result });
  }
);

// ---------------------------------------------------------------
// Demo fault injection (the dashboard buttons call this)
// ---------------------------------------------------------------
export const inject_fault = spacetimedb.reducer(
  { robot_id: t.string(), fault: t.string(), ts_ms: t.f64() },
  (ctx, a) => {
    if (!['stall', 'drift', 'flipped'].includes(a.fault)) return;
    ctx.db.fault_request.insert({
      request_id: 0, robot_id: a.robot_id, fault: a.fault, ts_ms: a.ts_ms, status: 'PENDING',
    });
  }
);

export const ack_fault = spacetimedb.reducer(
  { request_id: t.u32() },
  (ctx, a) => {
    const f = ctx.db.fault_request.request_id.find(a.request_id);
    if (f) ctx.db.fault_request.request_id.update({ ...f, status: 'APPLIED' });
  }
);