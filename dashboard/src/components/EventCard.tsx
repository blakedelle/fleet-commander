import { callArgs, displayTitle, flatRows, prettyKey, resultRows, safeParse, toolOf } from "../lib/parse";
import type { AgentEvent } from "../types";

const ICON: Record<string, string> = {
  tool_call: "🔧",
  tool_result: "📥",
  action: "⚡",
  escalation: "📣",
  outcome: "🏁",
  diagnosis: "🧠",
  system: "🤖",
};

const MAX_ROWS = 12;

interface Props {
  event: AgentEvent;
  startMs: number; // incident start, to show "+4s"
}

export default function EventCard({ event, startMs }: Props) {
  const d = safeParse(event.detail);
  const offset = Math.max(0, Math.round((event.tsMs - startMs) / 1000));

  let rows: [string, string][] = [];
  let note: string | null = null;
  const tool = toolOf(event, d);

  switch (event.kind) {
    case "tool_call":
      rows = callArgs(d);
      break;
    case "tool_result": {
      const r = resultRows(d.result);
      rows = r.rows;
      note = r.note;
      break;
    }
    case "action":
      rows = flatRows(d.args).filter(([k]) => k !== "robot id");
      note =
        typeof d.result === "string" ? d.result : typeof d.reason === "string" ? d.reason : null;
      break;
    case "escalation":
      rows = [
        ["department", String(d.department ?? "")],
        ["priority", String(d.priority ?? "")],
      ];
      note = typeof d.message === "string" ? d.message : null;
      break;
    case "outcome":
      rows = [["outcome", String(d.outcome ?? "")]];
      note = typeof d.summary === "string" ? d.summary : null;
      break;
    case "system":
      if (typeof d.tripped_channels === "string") {
        rows = [["tripped channels", d.tripped_channels.replace(/,/g, ", ")]];
      }
      note = typeof d.message === "string" ? d.message : null;
      break;
    default:
      note = event.title;
  }

  const shown = rows.slice(0, MAX_ROWS);

  return (
    <div className={`event kind-${event.kind}`}>
      <div className="event-icon">{ICON[event.kind] ?? "•"}</div>
      <div className="event-body">
        <div className="event-head">
          <strong>{displayTitle(event, d)}</strong>
          <span className="event-time">+{offset}s</span>
        </div>
        {tool && <span className="tool-chip">{prettyKey(tool)}</span>}
        {shown.length > 0 && (
          <div className="event-rows">
            {shown.map(([k, v]) => (
              <div key={k} className="event-row">
                <span>{k}</span>
                <span className="num">{v}</span>
              </div>
            ))}
            {rows.length > MAX_ROWS && (
              <div className="event-row">
                <span>+ {rows.length - MAX_ROWS} more values</span>
              </div>
            )}
          </div>
        )}
        {note && <div className="event-note">{note}</div>}
      </div>
    </div>
  );
}