import { DbConnection, tables } from './module_bindings/index.js';

const HOST = 'ws://localhost:3000';
const DB_NAME = 'fleet-commander';

type Status = 'ONLINE' | 'WARN' | 'ERROR';

interface SimRobot {
  id: string;
  status: Status;
  battery: number;
  x: number;
  y: number;
  errorCode: string;
  message: string;
}

// The kinds of failures a robot can have. The AI will learn to match
// each one with a recovery routine later.
const ERRORS = [
  { code: 'E_LOCALIZATION_LOST', message: 'Lost localization: lidar scan match failed' },
  { code: 'E_MOTOR_STALL', message: 'Drive motor stalled: current spike detected' },
  { code: 'E_ODOM_DRIFT', message: 'Odometry drift exceeds safe threshold' },
];

const robots: SimRobot[] = ['robot-1', 'robot-2', 'robot-3', 'robot-4'].map((id, i) => ({
  id,
  status: 'ONLINE',
  battery: 70 + Math.random() * 30,
  x: 3 + i * 4,
  y: 3 + Math.random() * 10,
  errorCode: 'NONE',
  message: 'Telemetry nominal',
}));

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function step(r: SimRobot) {
  if (r.status === 'ERROR') return; // stuck until an incident is resolved

  // Wander around a 20x20 warehouse and drain the battery
  r.x = clamp(r.x + (Math.random() - 0.5), 0, 20);
  r.y = clamp(r.y + (Math.random() - 0.5), 0, 20);
  r.battery -= 0.05 + Math.random() * 0.15;
  if (r.battery < 5) r.battery = 100; // pretend it docked and charged

  if (Math.random() < 0.008) {
    const err = ERRORS[Math.floor(Math.random() * ERRORS.length)];
    r.status = 'ERROR';
    r.errorCode = err.code;
    r.message = err.message;
  } else if (r.battery < 15) {
    r.status = 'WARN';
    r.errorCode = 'NONE';
    r.message = 'Battery low';
  } else {
    r.status = 'ONLINE';
    r.errorCode = 'NONE';
    r.message = 'Telemetry nominal';
  }
}

DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .onConnectError((...args) => console.error('Connection failed:', args))
  .onConnect((conn) => {
    console.log('Simulator connected. Sending telemetry for', robots.length, 'robots.');

    // Listen for incidents. When one is marked RESOLVED, that robot recovers.
    conn.subscriptionBuilder().subscribe([tables.incident]);
    conn.db.incident.onUpdate((_ctx, _oldRow, newRow) => {
      if (newRow.status === 'RESOLVED') {
        const r = robots.find((bot) => bot.id === newRow.robotId);
        if (r && r.status === 'ERROR') {
          r.status = 'ONLINE';
          r.errorCode = 'NONE';
          r.message = 'Recovered after incident resolved';
          console.log(`${r.id} recovered.`);
        }
      }
    });

    // Once a second, move every robot and send its telemetry
    setInterval(() => {
      for (const r of robots) {
        const wasError = r.status === 'ERROR';
        step(r);
        conn.reducers
          .processTelemetry({
            robotId: r.id,
            status: r.status,
            battery: r.battery,
            locationX: r.x,
            locationY: r.y,
            timestampMs: Date.now(),
            message: r.message,
            errorCode: r.errorCode,
          })
          .catch(console.error);
                if (r.status === 'ERROR' && !wasError) console.log(`${r.id} NEW ERROR: ${r.errorCode}`);
      }
    }, 1000);
  })
  .build();