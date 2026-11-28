import type { AdapterModel } from "../types.js";

export const DEFAULT_DEVIN_LOCAL_MODEL = "swe-2-flash-medium";
export const DEVIN_LOCAL_DEFAULT_MODEL = DEFAULT_DEVIN_LOCAL_MODEL;

export const DEVIN_LOCAL_MODELS: AdapterModel[] = [
  { id: "swe-2-flash-medium", label: "Devin SWE-2 Flash (Medium · 262K Free)" },
  { id: "swe-2-flash-high", label: "Devin SWE-2 Flash (High · 262K Free)" },
  { id: "swe-2-flash-max", label: "Devin SWE-2 Flash (Max · 262K Free)" },
  { id: "swe-2-1-low", label: "Devin SWE-2.1 (Low)" },
  { id: "swe-2-1-medium", label: "Devin SWE-2.1 (Medium)" },
  { id: "swe-2-1-high", label: "Devin SWE-2.1 (High)" },
  { id: "swe-2-1-max", label: "Devin SWE-2.1 (Max)" },
];

export function isDevinFreeTierModel(model: string | null | undefined): boolean {
  return typeof model === "string" && model.trim().toLowerCase().startsWith("swe-2-flash");
}

export function resolveDevinLocalModel(model: string | null | undefined): string {
  const trimmed = typeof model === "string" ? model.trim() : "";
  return trimmed.length > 0 ? trimmed : DEFAULT_DEVIN_LOCAL_MODEL;
}

export const listDevinLocalModels = async (): Promise<AdapterModel[]> => DEVIN_LOCAL_MODELS;
