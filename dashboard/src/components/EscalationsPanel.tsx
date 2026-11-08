import type { Escalation, Priority } from "../types";
import { timeAgo } from "../lib/format";

const PRIORITY_COLOR: Record<Priority, string> = {
  high: "var(--state-stopped)",
  medium: "var(--state-investigating)",
  low: "var(--state-quarantined)",
};

interface Props {
  escalations: Escalation[];
  onPick: (incidentId: number) => void;
}

export default function EscalationsPanel({ escalations, onPick }: Props) {
  const sorted = [...escalations].sort((a, b) => b.tsMs - a.tsMs);

  return (
    <div className="escalations">
      <h3 className="panel-title">ESCALATIONS TO HUMANS · {escalations.length}</h3>
      {sorted.length === 0 && <div className="empty">No open escalations.</div>}
      <div className="ticket-list">
        {sorted.map((e) => (
          <div
            key={e.escalationId}
            className="ticket"
            style={{ borderLeftColor: PRIORITY_COLOR[e.priority] }}
            onClick={() => onPick(e.incidentId)}
          >
            <div className="ticket-top">
              <span className="ticket-id">ESC-{String(e.escalationId).padStart(4, "0")}</span>
              <span className="badge" style={{ background: PRIORITY_COLOR[e.priority] }}>
                {e.priority.toUpperCase()} PRIORITY
              </span>
            </div>
            <div className="ticket-meta">
              <span>
                To: <b>{e.department}</b>
              </span>
              <span>
                Robot: <b>{e.robotId}</b>
              </span>
              <span>Incident #{e.incidentId}</span>
              <span>{timeAgo(e.tsMs)}</span>
            </div>
            <div className="ticket-msg">{e.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}