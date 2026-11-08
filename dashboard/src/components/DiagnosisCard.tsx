import { parseDiagnosis } from "../lib/parse";
import type { AgentEvent } from "../types";

// Splits an evidence line so numbers (with units) can be highlighted.
const NUMBER = /(-?\d+(?:\.\d+)?(?:\s?(?:m\/s|A|V|°|%|m)(?![a-zA-Z]))?)/g;

function Evidence({ text }: { text: string }) {
  const parts = text.split(NUMBER); // odd positions are the numbers
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className="num">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export default function DiagnosisCard({ event }: { event: AgentEvent }) {
  const d = parseDiagnosis(event.detail, event.title);
  const pct = d.confidence === null ? null : Math.round(d.confidence * 100);

  return (
    <div className="diagnosis">
      <div className="diagnosis-label">AI DIAGNOSIS</div>
      <div className="diagnosis-top">
        <h2 className="diagnosis-title">{d.rootCause}</h2>
        {pct !== null && (
          <div className="confidence">
            <div className="confidence-num">{pct}%</div>
            <div className="confidence-label">confidence</div>
          </div>
        )}
      </div>
      {pct !== null && (
        <div className="confidence-bar">
          <div className="confidence-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
      <ul className="evidence">
        {d.evidence.map((line, i) => (
          <li key={i}>
            <Evidence text={line} />
          </li>
        ))}
      </ul>
    </div>
  );
}