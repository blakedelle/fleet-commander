import { schema, table, t } from 'spacetimedb/server';

const spacetimedb = schema({
  robot: table(
    { public: true },
    {
      robot_id: t.string().primaryKey(),
      status: t.string(),      // "ONLINE", "WARN", or "ERROR"
      battery: t.f64(),
      location_x: t.f64(),
      location_y: t.f64(),
    }
  ),
  telemetry_log: table(
    { public: true },
    {
      log_id: t.u32().primaryKey().autoInc(),
      robot_id: t.string(),
      timestamp_ms: t.f64(),
      message: t.string(),
      error_code: t.string(),  // "NONE" when there's no error
    }
  ),
  incident: table(
    { public: true },
    {
      incident_id: t.u32().primaryKey().autoInc(),
      robot_id: t.string(),
      status: t.string(),      // "PENDING", "TRIAGING", or "RESOLVED"
      assigned_agent: t.string(),
      created_ms: t.f64(),
    }
  ),
});

export default spacetimedb;

export const process_telemetry = spacetimedb.reducer(
  {
    robot_id: t.string(),
    status: t.string(),
    battery: t.f64(),
    location_x: t.f64(),
    location_y: t.f64(),
    timestamp_ms: t.f64(),
    message: t.string(),
    error_code: t.string(),
  },
  (ctx, a) => {
    // 1. Update (or create) the robot's current state
    const robotRow = {
      robot_id: a.robot_id,
      status: a.status,
      battery: a.battery,
      location_x: a.location_x,
      location_y: a.location_y,
    };
    if (ctx.db.robot.robot_id.find(a.robot_id)) {
      ctx.db.robot.robot_id.update(robotRow);
    } else {
      ctx.db.robot.insert(robotRow);
    }

    // 2. Record the log line (id 0 means "auto-assign")
    ctx.db.telemetry_log.insert({
      log_id: 0,
      robot_id: a.robot_id,
      timestamp_ms: a.timestamp_ms,
      message: a.message,
      error_code: a.error_code,
    });

    // 3. If the robot is in ERROR, open an incident, unless one is already open
    if (a.status === 'ERROR') {
      let alreadyOpen = false;
      for (const inc of ctx.db.incident.iter()) {
        if (inc.robot_id === a.robot_id && inc.status !== 'RESOLVED') {
          alreadyOpen = true;
          break;
        }
      }
      if (!alreadyOpen) {
        ctx.db.incident.insert({
          incident_id: 0,
          robot_id: a.robot_id,
          status: 'PENDING',
          assigned_agent: 'NONE',
          created_ms: a.timestamp_ms,
        });
      }
    }
  }
);

// The AI agent calls this first, so two agents can't grab the same incident
export const claim_incident = spacetimedb.reducer(
  { incident_id: t.u32(), agent: t.string() },
  (ctx, a) => {
    const inc = ctx.db.incident.incident_id.find(a.incident_id);
    if (inc && inc.status === 'PENDING') {
      ctx.db.incident.incident_id.update({
        ...inc,
        status: 'TRIAGING',
        assigned_agent: a.agent,
      });
    }
  }
);

export const resolve_incident = spacetimedb.reducer(
  { incident_id: t.u32() },
  (ctx, a) => {
    const inc = ctx.db.incident.incident_id.find(a.incident_id);
    if (inc) {
      ctx.db.incident.incident_id.update({ ...inc, status: 'RESOLVED' });
    }
  }
);