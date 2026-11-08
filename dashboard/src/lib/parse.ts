import type { AgentEvent } from "../types";

// Turns `detail` JSON strings into readable pieces. The UI never shows raw JSON.
// Handles the REAL bridge shapes and the older mock shapes.

export type Json = Record<string, unknown>;

export function safeParse(detail: string): Json {
  try {
    const v = JSON.parse(detail);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
  } catch {
    return {};
  }
}

export function prettyKey(k: string): string {
  return k.replace(/_/g, " ");
}

// tripped_channels is a comma-separated string (a JSON array is also accepted).
export function parseChannels(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.map(String);
  } catch {
    /* not JSON, fall through */
  }
  return raw.split(/[,;\s]+/).filter(Boolean);
}

export interface Diagnosis {
  rootCause: string;
  confidence: number | null;
  evidence: string[];
}

export function parseDiagnosis(detail: string, fallbackTitle: string): Diagnosis {
  const d = safeParse(detail);
  return {
    rootCause: typeof d.root_cause === "string" ? d.root_cause : fallbackTitle,
    confidence: typeof d.confidence === "number" ? d.confidence : null,
    evidence: Array.isArray(d.evidence) ? d.evidence.map(String) : [],
  };
}

// ---- tool results arrive as text that the bridge cuts at 500 characters ----
function closersFor(s: string): string | null {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  return inStr ? null : stack.reverse().join("");
}

// Parses JSON, or JSON that was cut off mid-way (keeps everything before the cut).
export function parseLoose(text: string): unknown {
  const clean = text.replace(/\s*…\s*$/, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    /* maybe cut off */
  }
  if (!clean.startsWith("{") && !clean.startsWith("[")) return null;
  let cut = clean.length;
  for (let i = 0; i < 80; i++) {
    cut = clean.lastIndexOf(",", cut - 1);
    if (cut <= 0) break;
    const head = clean.slice(0, cut);
    const closers = closersFor(head);
    if (closers === null) continue;
    try {
      return JSON.parse(head + closers);
    } catch {
      /* keep cutting back */
    }
  }
  return null;
}

export function describeValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number" || typeof v === "string") return String(v);
  if (Array.isArray(v)) return v.map(describeValue).join(", ");
  const o = v as Json;
  if ("now" in o && "baseline" in o) {
    return `${describeValue(o.now)} (baseline ${describeValue(o.baseline)})`;
  }
  if ("baseline_mean" in o && "recent_mean" in o) {
    const pct = o.change_pct === null || o.change_pct === undefined ? "" : `, ${describeValue(o.change_pct)}%`;
    return `${describeValue(o.recent_mean)} (baseline ${describeValue(o.baseline_mean)}${pct})`;
  }
  return Object.entries(o)
    .map(([k, x]) => `${prettyKey(k)} ${describeValue(x)}`)
    .join(", ");
}

// Turns an object into label/value rows (one level of nesting is flattened).
export function flatRows(obj: unknown, prefix = "", depth = 0): [string, string][] {
  if (obj === undefined || obj === null) return [];
  if (typeof obj !== "object" || Array.isArray(obj)) return [["value", describeValue(obj)]];
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(obj as Json)) {
    const plain = v !== null && typeof v === "object" && !Array.isArray(v);
    const o = v as Json;
    const leaf =
      plain && (("now" in o && "baseline" in o) || ("baseline_mean" in o && "recent_mean" in o));
    if (plain && !leaf && depth < 1) {
      out.push(...flatRows(v, `${prefix}${prettyKey(k)} · `, depth + 1));
    } else {
      out.push([`${prefix}${prettyKey(k)}`, describeValue(v)]);
    }
  }
  return out;
}

export const rowsOf = (obj: unknown) => flatRows(obj);

// Rows for a tool_result. `result` is text (live) or an object (old mock).
export function resultRows(result: unknown): { rows: [string, string][]; note: string | null } {
  if (result !== null && typeof result === "object") return { rows: flatRows(result), note: null };
  if (typeof result === "string") {
    if (/^\s*t_s,/.test(result)) return { rows: [], note: "Raw telemetry table received." };
    const parsed = parseLoose(result);
    if (parsed && typeof parsed === "object") return { rows: flatRows(parsed), note: null };
    if (/^\s*[{[]/.test(result)) return { rows: [], note: "Detailed result received." };
    return { rows: [], note: result };
  }
  return { rows: [], note: null };
}

// ---- names ----
const TOOLISH = /^[a-z][a-z0-9_]*$/;

export function toolOf(e: AgentEvent, d: Json): string | null {
  if (e.kind !== "tool_call" && e.kind !== "tool_result" && e.kind !== "action") return null;
  if (typeof d.tool === "string") return d.tool;
  if (typeof d.action === "string") return d.action;
  return TOOLISH.test(e.title) ? e.title : null;
}

// Real titles are raw tool names ("get_telemetry_window"); make them readable.
export function displayTitle(e: AgentEvent, d: Json): string {
  if (!TOOLISH.test(e.title)) return e.title;
  const name = prettyKey(e.title);
  switch (e.kind) {
    case "tool_call":
      return `Calling ${name}`;
    case "tool_result":
      return `Result: ${name}`;
    case "action":
      return d.accepted === false ? `Action failed: ${name}` : `Action: ${name}`;
    case "outcome":
      return `Incident ${e.title}`;
    default:
      return e.title;
  }
}

// Arguments of a tool_call, without the robot_id noise.
export function callArgs(d: Json): [string, string][] {
  const args = "tool" in d ? d.args : d;
  return flatRows(args).filter(([k]) => k !== "robot id");
}