import type { Robot } from "../types";
import { STATE_COLOR } from "../lib/format";

const SCALE = 20; // pixels per meter. Warehouse is 20 m x 20 m = 400 x 400.
const SIZE = 20 * SCALE;

interface Props {
  robots: Robot[];
  incidentRobotIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function WarehouseMap({ robots, incidentRobotIds, selectedId, onSelect }: Props) {
  return (
    <svg className="map" viewBox={`-15 -15 ${SIZE + 30} ${SIZE + 30}`}>
      <rect x={0} y={0} width={SIZE} height={SIZE} className="map-floor" />
      {[5, 10, 15].map((m) => (
        <g key={m}>
          <line x1={m * SCALE} y1={0} x2={m * SCALE} y2={SIZE} className="map-grid" />
          <line x1={0} y1={m * SCALE} x2={SIZE} y2={m * SCALE} className="map-grid" />
        </g>
      ))}

      {robots.map((r) => {
        const incident = incidentRobotIds.has(r.robotId);
        // open incident => red. Otherwise the normal state color.
        const color = incident ? "var(--state-stopped)" : STATE_COLOR[r.state];
        return (
          <g
            key={r.robotId}
            transform={`translate(${Math.min(20, Math.max(0, r.x)) * SCALE}, ${(20 - Math.min(20, Math.max(0, r.y))) * SCALE})`}            onClick={() => onSelect(r.robotId)}
            style={{ cursor: "pointer" }}
          >
            {incident && (
              <circle r={12} style={{ fill: color }} opacity={0.35}>
                <animate attributeName="r" values="12;26;12" dur="1.2s" repeatCount="indefinite" />
              </circle>
            )}
            {selectedId === r.robotId && (
              <circle r={17} fill="none" stroke="white" strokeWidth={2} />
            )}
            {/* arrow pointing along the heading */}
            <g transform={`rotate(${-r.headingDeg})`}>
              <polygon points="13,0 -9,-8 -9,8" style={{ fill: color }} />
            </g>
            <text y={30} textAnchor="middle" className="map-label">
              {r.robotId}
            </text>
          </g>
        );
      })}
    </svg>
  );
}