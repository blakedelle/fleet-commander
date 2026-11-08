import type { AgentEvent, Incident } from "../types";
import { INCIDENT_COLOR, timeAgo } from "../lib/format";
import { parseChannels } from "../lib/parse";
import DiagnosisCard from "./DiagnosisCard";
import EventCard from "./EventCard";

interface Props {
  incidents: Incident[];
  events: AgentEvent[];
  activeId: number | null;
  onPick: (id: number) => void;
}

export default function IncidentPanel({ incidents, events, activeId, onPick }: Props) {
  const sorted = [...incidents].sort((a, b) => b.createdMs - a.createdMs);
  const active = incidents.find((i) => i.incidentId === activeId) ?? null;

  return (
    <div className="incident-panel">
      <div className="incident-list">
        <h3 className="panel-title">INCIDENTS</h3>
        {sorted.length === 0 && <div className="empty">No incidents. Fleet healthy.</div>}
        {sorted.map((i) => (
          <div
            key={i.incidentId}
            className={i.incidentId === activeId ? "incident-item active" : "incident-item"}
            onClick={() => onPick(i.incidentId)}
          >
            <div className="card-top">
              <strong>
                #{i.incidentId} · {i.robotId}
              </strong>
              <span className="badge" style={{ background: INCIDENT_COLOR[i.status] }}>
                {i.status}
              </span>
            </div>
            <div className="incident-sub">{i.diagnosis ?? "Investigating…"}</div>
            <div className="incident-sub">{timeAgo(i.createdMs)}</div>
          </div>
        ))}
      </div>

      <div className="incident-detail">
        {active ? <Detail incident={active} events={events} /> : <div className="empty">Select an incident.</div>}
      </div>
    </div>
  );
}

function Detail({ incident, events }: { incident: Incident; events: AgentEvent[] }) {
  const mine = events
    .filter((e) => e.incidentId === incident.incidentId)
    .sort((a, b) => a.tsMs - b.tsMs);
  const diagnosis = mine.find((e) => e.kind === "diagnosis");
  const timeline = mine.filter((e) => e.kind !== "diagnosis");
  const investigating = incident.status === "PENDING" || incident.status === "TRIAGING";

  return (
    <>
      <div className="detail-head">
        <h3 className="panel-title">
          INCIDENT #{incident.incidentId} · {incident.robotId.toUpperCase()}
        </h3>
        <span className="badge" style={{ background: INCIDENT_COLOR[incident.status] }}>
          {incident.status}
        </span>
      </div>
      <div className="channels">
        Tripped:{" "}
        {parseChannels(incident.trippedChannels).map((c) => (
          <span key={c} className="tool-chip">
            {c}
          </span>
        ))}
      </div>

      {diagnosis && <DiagnosisCard event={diagnosis} />}

      {investigating && (
        <div className="investigating">
          <span className="dots">
            <i />
            <i />
            <i />
          </span>
          AI investigating…
        </div>
      )}

      <div className="timeline">
        {timeline.map((e) => (
          <EventCard key={e.eventId} event={e} startMs={incident.createdMs} />
        ))}
      </div>
    </>
  );
}