import { useEffect, useState } from "react";
import "./App.css";
import { useFleetData } from "./data/useFleetData";
import Header from "./components/Header";
import HealthBar from "./components/HealthBar";
import RobotCard from "./components/RobotCard";
import WarehouseMap from "./components/WarehouseMap";
import FaultControls from "./components/FaultControls";
import EscalationsPanel from "./components/EscalationsPanel";
import TelemetryChart from "./components/TelemetryChart";
import AiFeed from "./components/AiFeed";
import IncidentPanel from "./components/IncidentPanel";

export default function App() {
  const { robots, incidents, events, escalations, samples, connected } = useFleetData();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickedIncident, setPickedIncident] = useState<number | null>(null);
  const mode = import.meta.env.VITE_USE_MOCK === "true" ? "MOCK DATA" : "LIVE";

  // When a NEW incident appears, jump to it automatically.
  useEffect(() => {
    setPickedIncident(null);
  }, [incidents.length]);

  const latest = [...incidents].sort((a, b) => b.createdMs - a.createdMs)[0];
  const activeIncidentId = pickedIncident ?? latest?.incidentId ?? null;

  // Chart shows the selected robot, or the robot of the latest incident by default.
  const chartRobotId = selectedId ?? latest?.robotId ?? robots[0]?.robotId ?? null;
  const selectedRobot = robots.find((r) => r.robotId === selectedId) ?? null;

  const incidentRobotIds = new Set(
    incidents
      .filter((i) => i.status === "PENDING" || i.status === "TRIAGING")
      .map((i) => i.robotId),
  );

  return (
    <>
      <Header connected={connected} mode={mode} />
      <HealthBar robots={robots} incidents={incidents} />

      <main className="main">
        <section>
          <div className="cards">
            {robots.map((r) => (
              <RobotCard
                key={r.robotId}
                robot={r}
                hasIncident={incidentRobotIds.has(r.robotId)}
                selected={selectedId === r.robotId}
                onSelect={() => setSelectedId(r.robotId)}
              />
            ))}
          </div>
          <FaultControls robot={selectedRobot} />
        </section>

        <section>
          <WarehouseMap
            robots={robots}
            incidentRobotIds={incidentRobotIds}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </section>

        <section className="wide">
          <EscalationsPanel escalations={escalations} onPick={setPickedIncident} />
        </section>

        <section className="wide">
          <TelemetryChart
            robotId={chartRobotId}
            samples={samples}
            incidents={incidents}
            events={events}
          />
        </section>

        <section className="wide lower">
          <AiFeed events={events} onPick={setPickedIncident} />
          <IncidentPanel
            incidents={incidents}
            events={events}
            activeId={activeIncidentId}
            onPick={setPickedIncident}
          />
        </section>
      </main>
    </>
  );
}