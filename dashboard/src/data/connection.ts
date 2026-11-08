import { DbConnection, tables } from "../module_bindings";

// One shared connection for the whole app. Same calls the bridge and simulator use.
const HOST = "ws://localhost:3000";
const DB_NAME = "fleet-commander";
const RETRY_MS = 3000;

let conn: DbConnection | null = null;
let connected = false;
let started = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export const getConnection = () => conn;
export const isConnected = () => connected;

function retry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, RETRY_MS);
}

function connect() {
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .onConnectError((...args) => {
      console.error("SpacetimeDB connection failed:", args);
      connected = false;
      retry();
    })
    .onDisconnect(() => {
      console.warn("Disconnected from SpacetimeDB. Retrying…");
      connected = false; // the last data stays on screen under the red banner
      retry();
    })
    .onConnect((c) => {
      conn = c;
      connected = true;
      c.subscriptionBuilder().subscribe([
        tables.robot,
        tables.telemetrySample,
        tables.gateState,
        tables.incident,
        tables.agentEvent,
        tables.escalation,
        tables.faultRequest,
      ]);
    })
    .build();
}

export function startConnection() {
  if (started) return;
  started = true;
  connect();
}