import type { Incident, Robot, RobotState } from "../types";
import { STATE_COLOR } from "../lib/format";

const ORDER: RobotState[] = ["NOMINAL", "INVESTIGATING", "STOPPED", "QUARANTINED"];

interface Props {
  robots: Robot[];
  incidents: Incident[];
}

export default function HealthBar({ robots, incidents }: Props) {
  const total = robots.length;
  const counts = ORDER.map((s) => ({ state: s, n: robots.filter((r) => r.state === s).length }));
  const healthy = counts[0].n;
  const open = incidents.filter((i) => i.status === "PENDING" || i.status === "TRIAGING").length;
  const resolved = incidents.filter((i) => i.status === "RESOLVED").length;
  const escalated = incidents.filter((i) => i.status === "ESCALATED").length;

  return (
    <div className="health">
      <div className="health-main">
        <div className="health-big">
          {healthy}/{total}
        </div>
        <div className="health-label">robots healthy</div>
      </div>

      <div className="health-mid">
        <div className="health-seg">
          {total > 0 &&
            counts.map(
              (c) =>
                c.n > 0 && (
                  <div
                    key={c.state}
                    style={{ width: `${(c.n / total) * 100}%`, background: STATE_COLOR[c.state] }}
                  />
                ),
            )}
        </div>
        <div className="health-legend">
          {counts.map((c) => (
            <span key={c.state}>
              <i style={{ background: STATE_COLOR[c.state] }} />
              {c.n} {c.state.toLowerCase()}
            </span>
          ))}
        </div>
      </div>

      <div className="health-stats">
        <div>
          <b style={{ color: open > 0 ? "var(--state-investigating)" : undefined }}>{open}</b>
          open
        </div>
        <div>
          <b style={{ color: "var(--state-nominal)" }}>{resolved}</b>
          resolved
        </div>
        <div>
          <b style={{ color: escalated > 0 ? "var(--state-stopped)" : undefined }}>{escalated}</b>
          escalated
        </div>
      </div>
    </div>
  );
}