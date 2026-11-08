import { DbConnection, tables } from './module_bindings/index.js';

// ---------------- Demo knobs ----------------
const HOST = 'ws://localhost:3000';
const DB_NAME = 'fleet-commander';
const TICK_MS = 1000;
const AUTO_FAULTS = true;                    // false = faults only from the dashboard / command line
const FAULT_CHANCE_PER_ROBOT_PER_SEC = 0.004; // about one fleet-wide fault per minute
const AUTO_TECHNICIAN_SECONDS = 30;          // 0 = a human must trigger repair_robot

// ---------------- Physics constants ----------------
const WHEELBASE = 0.4;
const CRUISE = 0.5;
const ARENA = 20;
const DOCK = { x: 1.5, y: 1.5 };
const ROBOT_IDS = ['robot-1', 'robot-2', 'robot-3', 'robot-4'];

type Fault = 'none' | 'stall' | 'drift' | 'flipped';

const noise = (s: number) => (Math.random() - 0.5) * 2 * s;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const rnd = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const normAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

class SimRobot {
  id: string;
  x: number;
  y: number;
  hdg: number;                 // radians (true heading)
  driftX = 0;                  // error added to the REPORTED position
  driftY = 0;
  fault: Fault = 'none';       // HIDDEN: never sent anywhere
  stopped = false;
  quarantined = false;
  speedLimit = CRUISE;
  reverseLeft = 0;
  goalDock = false;
  docked = false;
  batteryPct: number;
  phase = Math.random() * 6.28;
  t = 0;
  prevReported: { x: number; y: number } | null = null;
  quarantinedAt = 0;
  repairRequested = false;

  constructor(id: string, x: number, y: number) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.hdg = Math.random() * 2 * Math.PI - Math.PI;
    this.batteryPct = 70 + Math.random() * 30;
  }

  injectFault(f: string): boolean {
    if (f !== 'stall' && f !== 'drift' && f !== 'flipped') return false;
    this.fault = f;
    if (f === 'drift') { this.driftX = 0; this.driftY = 0; }
    return true;
  }

  private clearDrift() {
    this.driftX = 0;
    this.driftY = 0;
    if (this.fault === 'drift') this.fault = 'none';
  }

  private resume() {
    if (!this.quarantined) this.stopped = false;
  }

  // Returns a NEUTRAL result string (never reveals whether the fix worked), or null if unknown
  apply(command: string, args: any): string | null {
    switch (command) {
      case 'stop_motors':
        this.stopped = true;
        return 'Motors stopped.';
      case 'quarantine_robot':
        this.stopped = true;
        this.quarantined = true;
        this.quarantinedAt = Date.now();
        this.repairRequested = false;
        return 'Robot quarantined and removed from active service.';
      case 'set_speed_limit':
        this.speedLimit = clamp(Number(args?.max_speed_mps) || CRUISE, 0.05, CRUISE);
        this.resume();
        return `Speed limit set to ${rnd(this.speedLimit)} m/s.`;
      case 'reverse_and_retry':
        this.resume();
        this.reverseLeft = 4;
        return 'Reversing about one meter, then resuming normal driving.';
      case 'reboot_subsystem': {
        const sub = String(args?.subsystem ?? 'unknown');
        this.resume();
        if (sub === 'localization') this.clearDrift();
        return `Subsystem '${sub}' restarted.`;
      }
      case 'recalibrate_odometry':
        this.resume();
        this.clearDrift();
        return 'Odometry recalibration completed.';
      case 'return_to_base':
        this.resume();
        this.docked = false;
        this.goalDock = true;
        return 'Navigating to the charging dock.';
      case 'human_repair':
        this.fault = 'none';
        this.driftX = 0;
        this.driftY = 0;
        this.quarantined = false;
        this.stopped = false;
        this.reverseLeft = 0;
        this.goalDock = false;
        this.docked = false;
        this.repairRequested = false;
        return 'A technician repaired the robot and returned it to service.';
      default:
        return null;
    }
  }

  step(dt: number) {
    this.t += dt;
    let v = 0;
    let omega = 0;

    if (!this.docked) {
      this.batteryPct = Math.max(0, this.batteryPct - (0.05 + Math.random() * 0.1) * dt);
    }
    if (!this.docked && this.batteryPct < 12 && !this.stopped && !this.quarantined) {
      this.goalDock = true;
    }

    if (this.docked) {
      this.batteryPct = Math.min(100, this.batteryPct + 3 * dt);
      if (this.batteryPct >= 98 && !this.stopped && !this.quarantined) this.docked = false;
    } else if (!this.stopped && !this.quarantined) {
      if (this.reverseLeft > 0) {
        v = -0.3;
      } else if (this.goalDock) {
        const dx = DOCK.x - this.x;
        const dy = DOCK.y - this.y;
        if (Math.hypot(dx, dy) < 0.6) {
          this.docked = true;
          this.goalDock = false;
        } else {
          const err = normAngle(Math.atan2(dy, dx) - this.hdg);
          omega = clamp(1.5 * err, -0.3, 0.3);
          v = Math.abs(err) < 0.8 ? 0.4 : 0.05;
        }
      } else {
        const m = 3;
        if (this.x < m || this.x > ARENA - m || this.y < m || this.y > ARENA - m) {
          const err = normAngle(Math.atan2(ARENA / 2 - this.y, ARENA / 2 - this.x) - this.hdg);
          omega = clamp(1.5 * err, -0.3, 0.3);
        } else {
          omega = 0.12 * Math.sin(this.t / 10 + this.phase);
        }
        v = CRUISE;
      }
      if (v > 0) v = Math.min(v, this.speedLimit);
    }

    // Commanded wheel speeds
    const cmdL = v - (omega * WHEELBASE) / 2;
    const cmdR = v + (omega * WHEELBASE) / 2;
    const driving = Math.abs(cmdL) + Math.abs(cmdR) > 0.05;

    // Healthy behavior
    let wL = cmdL + noise(0.02);
    let wR = cmdR + noise(0.02);
    let iL = 0.25 + 3.0 * Math.abs(cmdL) + noise(0.1);
    let iR = 0.25 + 3.0 * Math.abs(cmdR) + noise(0.1);
    let roll = noise(1.5);
    let pitch = noise(1.5);
    let vTrue = (wL + wR) / 2;
    let omegaTrue = (wR - wL) / WHEELBASE;

    // Hidden faults
    if (this.fault === 'stall' && this.reverseLeft === 0) {
      if (driving) {
        wL = noise(0.01);
        iL = 8 + noise(0.5);
        wR = cmdR * 0.16 + noise(0.02);
        iR = 2.6 + noise(0.2);
      } else {
        wL = 0; wR = 0;
        iL = 0.25 + noise(0.05);
        iR = 0.25 + noise(0.05);
      }
      vTrue = driving ? 0.02 : 0;
      omegaTrue = 0;
    }

    if (this.fault === 'flipped') {
      roll = 178 + noise(2);
      pitch = 2 + noise(2);
      if (driving) {
        wL = cmdL * 1.15 + noise(0.03);
        wR = cmdR * 1.15 + noise(0.03);
        iL = 0.4 + 0.5 * Math.abs(cmdL) + noise(0.05);
        iR = 0.4 + 0.5 * Math.abs(cmdR) + noise(0.05);
      } else {
        wL = 0; wR = 0;
        iL = 0.2 + noise(0.05);
        iR = 0.2 + noise(0.05);
      }
      vTrue = 0;
      omegaTrue = 0;
    }

    if (this.fault === 'drift') {
      this.driftX += (0.2 + noise(0.03)) * dt;
      this.driftY += (-0.12 + noise(0.03)) * dt;
    }

    // Move the robot (uses the same encoder values the gate sees, so healthy residual is ~0)
    this.hdg = normAngle(this.hdg + omegaTrue * dt);
    this.x += vTrue * dt * Math.cos(this.hdg);
    this.y += vTrue * dt * Math.sin(this.hdg);

    const rx = this.x + this.driftX;
    const ry = this.y + this.driftY;
    const speed = this.prevReported
      ? Math.hypot(rx - this.prevReported.x, ry - this.prevReported.y) / dt
      : 0;
    this.prevReported = { x: rx, y: ry };

    const vbatt = 21.8 + 3.4 * (this.batteryPct / 100) - 0.04 * (iL + iR) + noise(0.02);

    // Backing up frees a jammed drive
    if (this.reverseLeft > 0) {
      this.reverseLeft--;
      if (this.reverseLeft === 0 && this.fault === 'stall') this.fault = 'none';
    }

    return {
      vbatt: rnd(vbatt),
      batteryPct: rnd(this.batteryPct, 1),
      iLeft: rnd(iL),
      iRight: rnd(iR),
      cmdLeft: rnd(cmdL),
      cmdRight: rnd(cmdR),
      wLeft: rnd(wL),
      wRight: rnd(wR),
      x: rnd(rx),
      y: rnd(ry),
      headingDeg: rnd((this.hdg * 180) / Math.PI, 1),
      speed: rnd(speed),
      rollDeg: rnd(roll, 1),
      pitchDeg: rnd(pitch, 1),
    };
  }
}

// ---------------- Fleet ----------------
const robots = new Map<string, SimRobot>();
ROBOT_IDS.forEach((id, i) => robots.set(id, new SimRobot(id, 4 + i * 4, 5 + (i % 2) * 8)));
let lastTick = Date.now();

DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .onConnectError((...args) => console.error('Connection failed:', args))
  .onConnect((conn) => {
    console.log(`Simulator connected. Simulating ${robots.size} robots. Auto faults: ${AUTO_FAULTS}.`);

    conn.subscriptionBuilder().subscribe([tables.robotCommand, tables.faultRequest]);

    // Commands from the AI (or a human)
    conn.db.robotCommand.onInsert((_ctx, row) => {
      if (row.status !== 'PENDING') return; // skip rows that were already handled
      const reject = (why: string) =>
        conn.reducers.ackCommand({ commandId: row.commandId, status: 'REJECTED', result: why }).catch(console.error);

      const r = robots.get(row.robotId);
      if (!r) return void reject('Unknown robot.');
      if (Date.now() - row.tsMs > 120_000) return void reject('Stale command ignored.');

      let args: any = {};
      try { args = JSON.parse(row.args); } catch { /* args may be plain text */ }

      const result = r.apply(row.command, args);
      if (result === null) return void reject(`Unknown command '${row.command}'.`);
      console.log(`[command #${row.commandId}] ${row.robotId} <- ${row.command} ${row.args}`);
      conn.reducers.ackCommand({ commandId: row.commandId, status: 'APPLIED', result }).catch(console.error);
    });

    // Demo buttons: "make this robot fail"
    conn.db.faultRequest.onInsert((_ctx, row) => {
      if (row.status !== 'PENDING') return;
      const r = robots.get(row.robotId);
      if (r && Date.now() - row.tsMs < 120_000 && r.injectFault(row.fault)) {
        console.log(`[fault] ${row.fault} injected on ${row.robotId} (requested from the dashboard; hidden from the AI)`);
      }
      conn.reducers.ackFault({ requestId: row.requestId }).catch(console.error);
    });

    setInterval(() => {
      const now = Date.now();
      const dt = clamp((now - lastTick) / 1000, 0.2, 2.5);
      lastTick = now;

      // Random faults, but only when nothing is currently broken
      if (AUTO_FAULTS && ![...robots.values()].some((r) => r.fault !== 'none')) {
        for (const r of robots.values()) {
          if (Math.random() < FAULT_CHANCE_PER_ROBOT_PER_SEC * dt) {
            const roll = Math.random();
            const f = roll < 0.4 ? 'stall' : roll < 0.75 ? 'drift' : 'flipped';
            r.injectFault(f);
            console.log(`[fault] ${f} started on ${r.id} (hidden from the AI)`);
            break;
          }
        }
      }

      for (const r of robots.values()) {
        // Simulated human response to quarantined robots
        if (
          AUTO_TECHNICIAN_SECONDS > 0 &&
          r.quarantined &&
          !r.repairRequested &&
          now - r.quarantinedAt > AUTO_TECHNICIAN_SECONDS * 1000
        ) {
          r.repairRequested = true;
          r.apply('human_repair', {}); // fix the physics now, so no stale "still broken" sample goes out
          console.log(`[technician] dispatched to ${r.id}`);
          conn.reducers.repairRobot({ robotId: r.id, tsMs: now }).catch(console.error);
        }

        const s = r.step(dt);
        conn.reducers.processTelemetry({ robotId: r.id, tMs: now, ...s }).catch(console.error);
      }
    }, TICK_MS);
  })
  .build();