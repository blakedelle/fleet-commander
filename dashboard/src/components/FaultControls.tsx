import type { Robot } from "../types";
import { faultsWired, injectFault, repairRobot, type Fault } from "../data/actions";

const BUTTONS: { fault: Fault; label: string }[] = [
  { fault: "stall", label: "⚙ Stall" },
  { fault: "drift", label: "🧭 Drift" },
  { fault: "flipped", label: "🔄 Flip" },
];

export default function FaultControls({ robot }: { robot: Robot | null }) {
  const wired = faultsWired();
  const busy = robot !== null && robot.state !== "NOMINAL";
  const canRepair = robot !== null && (robot.state === "QUARANTINED" || robot.state === "STOPPED");

  return (
    <div className="controls">
      <h3 className="panel-title">FAULT INJECTION</h3>
      <div className="controls-target">
        {robot ? (
          <>
            Target: <b>{robot.robotId}</b>
          </>
        ) : (
          "Click a robot card or map marker to choose a target."
        )}
      </div>

      <div className="controls-buttons">
        {BUTTONS.map((b) => (
          <button
            key={b.fault}
            className="btn btn-fault"
            disabled={!robot || busy || !wired}
            onClick={() => robot && injectFault(robot.robotId, b.fault)}
          >
            {b.label}
          </button>
        ))}
        {canRepair && (
          <button
            className="btn btn-repair"
            disabled={!wired}
            onClick={() => robot && repairRobot(robot.robotId)}
          >
            🛠 Repair (human)
          </button>
        )}
      </div>

      {busy && !canRepair && <div className="controls-note">Robot is busy with an incident.</div>}
      {!wired && <div className="controls-note">Not connected to the backend.</div>}
    </div>
  );
}