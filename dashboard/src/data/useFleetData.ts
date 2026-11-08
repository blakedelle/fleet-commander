import { useMockData } from "./useMockData";
import { useLiveData } from "./useLiveData";

// The ONLY hook the UI calls. It picks mock or live once, from the .env file.
// (Restart `npm run dev` after changing .env.)
const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";

export const useFleetData = USE_MOCK ? useMockData : useLiveData;