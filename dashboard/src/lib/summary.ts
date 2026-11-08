import type { AgentEvent } from "../types";
import { callArgs, parseDiagnosis, resultRows, safeParse } from "./parse";

// One readable line per event, used by the live feed. Never raw JSON.
export function summarize(e: AgentEvent): string {
  const d = safeParse(e.detail);
  switch (e.kind) {
    case "tool_call":
      return callArgs(d)
        .map(([k, v]) => `${k} ${v}`)
        .join(" · ");
    case "tool_result": {
      const r = resultRows(d.result);
      if (r.rows.length > 0) {
        return r.rows
          .slice(0, 3)
          .map(([k, v]) => `${k} ${v}`)
          .join(" · ");
      }
      return r.note ?? "";
    }
    case "action":
      if (typeof d.result === "string") return d.result;
      return typeof d.reason === "string" ? d.reason : "";
    case "diagnosis": {
      const g = parseDiagnosis(e.detail, e.title);
      const pct = g.confidence === null ? "" : ` · ${Math.round(g.confidence * 100)}% confident`;
      return `${g.rootCause}${pct}`;
    }
    case "escalation":
      return `${String(d.department ?? "")} · ${String(d.priority ?? "")} priority`;
    case "outcome":
      return typeof d.summary === "string" ? d.summary : "";
    case "system":
      return typeof d.message === "string" ? d.message : "";
    default:
      return "";
  }
}