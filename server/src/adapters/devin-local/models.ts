import type { AdapterModel } from "../types.js";

export const DEVIN_LOCAL_DEFAULT_MODEL = "swe-2-flash-medium";

export const DEVIN_LOCAL_MODELS: AdapterModel[] = [
  { id: "swe-2-flash-medium", label: "Devin SWE-2 Flash (Medium · 262K Free)" },
  { id: "swe-2-flash-high", label: "Devin SWE-2 Flash (High · 262K Free)" },
  { id: "swe-2-flash-max", label: "Devin SWE-2 Flash (Max · 262K Free)" },
  { id: "swe-2-1-low", label: "Devin SWE-2.1 (Low)" },
  { id: "swe-2-1-medium", label: "Devin SWE-2.1 (Medium)" },
  { id: "swe-2-1-high", label: "Devin SWE-2.1 (High)" },
  { id: "swe-2-1-max", label: "Devin SWE-2.1 (Max)" },
];

export const listDevinLocalModels = async (): Promise<AdapterModel[]> => DEVIN_LOCAL_MODELS;
