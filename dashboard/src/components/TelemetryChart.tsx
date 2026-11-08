import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AgentEvent, Incident, TelemetrySample } from "../types";

const WINDOW_MS = 60_000;

interface Props {
  robotId: string | null;
  samples: TelemetrySample[];
  incidents: Incident[];
  events: AgentEvent[];
}

interface Marker {
  x: number;
  label: string;
  color: string;
  position: "insideTopLeft" | "insideTopRight";
}

export default function TelemetryChart({ robotId, samples, incidents, events }: Props) {
  if (!robotId) return <div className="empty">Select a robot to see its telemetry.</div>;

  const mine = samples
    .filter((s) => s.robotId === robotId)
    .sort((a, b) => a.tMs - b.tMs);
  const end = mine.length ? mine[mine.length - 1].tMs : Date.now();
  const start = end - WINDOW_MS;

  const data = mine
    .filter((s) => s.tMs >= start)
    .map((s) => ({
      t: s.tMs,
      iLeft: s.iLeft,
      iRight: s.iRight,
      errLeft: s.cmdLeft - s.wLeft,
      errRight: s.cmdRight - s.wRight,
    }));

  // Vertical markers for every incident of this robot that falls in the window.
  // NOTE: "fault began" uses incident.createdMs, the closest proxy we have.
  const markers: Marker[] = [];
  for (const inc of incidents.filter((i) => i.robotId === robotId)) {
    markers.push({ x: inc.createdMs, label: "FAULT", color: "#ef4444", position: "insideTopRight" });
    const firstAction = events
      .filter((e) => e.incidentId === inc.incidentId && e.kind === "action")
      .sort((a, b) => a.tsMs - b.tsMs)[0];
    if (firstAction) {
      markers.push({ x: firstAction.tsMs, label: "AI ACTS", color: "#f59e0b", position: "insideTopLeft" });
    }
    if (inc.closedMs && inc.status === "RESOLVED") {
      markers.push({ x: inc.closedMs, label: "RECOVERED", color: "#22c55e", position: "insideTopRight" });
    }
    if (inc.closedMs && inc.status === "ESCALATED") {
      markers.push({ x: inc.closedMs, label: "ESCALATED", color: "#ef4444", position: "insideTopRight" });
    }
  }
  const visible = markers.filter((m) => m.x >= start && m.x <= end);

  const ticks: number[] = [];
  for (let t = start; t <= end; t += 10_000) ticks.push(t);
  const tick = (v: number) => `${Math.round((v - end) / 1000)}s`;

  const xAxis = (
    <XAxis
      dataKey="t"
      type="number"
      domain={[start, end]}
      allowDataOverflow
      ticks={ticks}
      tickFormatter={tick}
      stroke="#8a96ad"
      fontSize={11}
    />
  );
  const tooltip = (
    <Tooltip
      contentStyle={{ background: "#141a26", border: "1px solid #243049" }}
      labelFormatter={(l) => tick(Number(l))}
      formatter={(v) => Number(v).toFixed(2)}
    />
  );
  const lines = visible.map((m, i) => (
    <ReferenceLine
      key={i}
      x={m.x}
      stroke={m.color}
      strokeWidth={2}
      strokeDasharray="5 3"
      label={{ value: m.label, position: m.position, fill: m.color, fontSize: 11, fontWeight: 700 }}
    />
  ));

  return (
    <div className="telemetry">
      <h3 className="panel-title">TELEMETRY · {robotId.toUpperCase()} · last 60 s</h3>

      <div className="chart-title">Motor current (A)</div>
      <ResponsiveContainer width="100%" height={190}>
        <LineChart data={data} syncId="telemetry" margin={{ top: 18, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#243049" strokeDasharray="3 3" />
          {xAxis}
          <YAxis stroke="#8a96ad" fontSize={11} domain={[0, 10]} width={32} />
          {tooltip}
          <Legend />
          <Line name="Left motor" dataKey="iLeft" stroke="#38bdf8" dot={false} strokeWidth={2} isAnimationActive={false} />
          <Line name="Right motor" dataKey="iRight" stroke="#a78bfa" dot={false} strokeWidth={2} isAnimationActive={false} />
          {lines}
        </LineChart>
      </ResponsiveContainer>

      <div className="chart-title">Wheel velocity error: commanded minus actual (m/s)</div>
      <ResponsiveContainer width="100%" height={170}>
        <LineChart data={data} syncId="telemetry" margin={{ top: 18, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#243049" strokeDasharray="3 3" />
          {xAxis}
          <YAxis stroke="#8a96ad" fontSize={11} domain={[-1, 1]} width={32} />
          {tooltip}
          <Legend />
          <Line name="Left wheel" dataKey="errLeft" stroke="#fde047" dot={false} strokeWidth={2} isAnimationActive={false} />
          <Line name="Right wheel" dataKey="errRight" stroke="#34d399" dot={false} strokeWidth={2} isAnimationActive={false} />
          {lines}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}