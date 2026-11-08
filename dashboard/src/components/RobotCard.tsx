import type { Robot } from "../types";
import { STATE_COLOR, timeAgo } from "../lib/format";

interface Props {
  robot: Robot;
  hasIncident: boolean;
  selected: boolean;
  onSelect: () => void;
}

export default function RobotCard({ robot, hasIncident, selected, onSelect }: Props) {
  const color = STATE_COLOR[robot.state];
  return (
    <div
      className={selected ? "card selected" : "card"}
      style={{ borderLeftColor: color }}
      onClick={onSelect}
    >
      <div className="card-top">
        <strong>{robot.robotId}</strong>
        <span className="badge" style={{ background: color }}>
          {robot.state}
        </span>
      </div>

      <div className="battery">
        <div className="battery-fill" style={{ width: `${robot.batteryPct}%` }} />
      </div>
      <div className="card-row">
        <span>Battery</span>
        <span>
          {robot.batteryPct.toFixed(0)}% · {robot.vbatt.toFixed(1)} V
        </span>
      </div>
      <div className="card-row">
        <span>Speed</span>
        <span>{robot.speed.toFixed(2)} m/s</span>
      </div>
      <div className="card-row">
        <span>Last seen</span>
        <span>{timeAgo(robot.lastSeenMs)}</span>
      </div>
      {hasIncident && <div className="incident-tag">⚠ INCIDENT OPEN</div>}
    </div>
  );
}