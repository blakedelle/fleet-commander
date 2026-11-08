import { injectMockFault, injectMockRepair } from "./useMockData";
import { getConnection, isConnected } from "./connection";

export type Fault = "stall" | "drift" | "flipped";

const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";

// Buttons are enabled in mock mode, or in live mode once connected.
export const faultsWired = () => USE_MOCK || isConnected();

export function injectFault(robotId: string, fault: Fault) {
  if (USE_MOCK) {
    injectMockFault(robotId, fault);
    return;
  }
  const conn = getConnection();
  if (!conn || !isConnected()) {
    console.warn("Not connected: inject_fault ignored", robotId, fault);
    return;
  }
  // Same call style the simulator uses for its reducers.
  conn.reducers.injectFault({ robotId, fault, tsMs: Date.now() }).catch(console.error);
}

export function repairRobot(robotId: string) {
  if (USE_MOCK) {
    injectMockRepair(robotId);
    return;
  }
  const conn = getConnection();
  if (!conn || !isConnected()) {
    console.warn("Not connected: repair_robot ignored", robotId);
    return;
  }
  conn.reducers.repairRobot({ robotId, tsMs: Date.now() }).catch(console.error);
}