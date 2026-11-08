import type { AgentEvent } from "../types";
import { timeAgo } from "../lib/format";
import { displayTitle, prettyKey, safeParse, toolOf } from "../lib/parse";
import { summarize } from "../lib/summary";

const ICON: Record<string, string> = {
  tool_call: "🔧",
  tool_result: "📥",
  action: "⚡",
  escalation: "📣",
  outcome: "🏁",
  diagnosis: "🧠",
  system: "🤖",
};

const MAX_ITEMS = 40;

interface Props {
  events: AgentEvent[];
  onPick: (incidentId: number) => void;
}

export default function AiFeed({ events, onPick }: Props) {
  const newest = [...events]
    .sort((a, b) => b.tsMs - a.tsMs || b.eventId - a.eventId)
    .slice(0, MAX_ITEMS);

  return (
    <div className="feed">
      <h3 className="panel-title">
        <span className="live-dot" /> LIVE AI ACTIVITY · {events.length} events
      </h3>
      {newest.length === 0 && <div className="empty">Waiting for the AI to act…</div>}
      <div className="feed-list">
        {newest.map((e) => {
          const d = safeParse(e.detail);
          const tool = toolOf(e, d);
          return (
            <div
              key={e.eventId}
              className={`feed-item kind-${e.kind}`}
              onClick={() => onPick(e.incidentId)}
            >
              <div className="feed-top">
                <span className="feed-robot">{e.robotId}</span>
                <span className="event-time">{timeAgo(e.tsMs)}</span>
              </div>
              <div className="feed-title">
                {ICON[e.kind] ?? "•"} {displayTitle(e, d)}
              </div>
              {tool && <span className="tool-chip">{prettyKey(tool)}</span>}
              <div className="feed-sum">{summarize(e)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}