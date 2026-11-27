import { api } from "./client";

export interface SharedTableRecord {
  id: string;
  companyId: string;
  name: string;
  columns: {
    name: string;
    type: "string" | "number" | "boolean" | "json";
    required?: boolean;
  }[];
  createdAt: string;
  updatedAt: string;
}

export type CreateSharedTableInput = Pick<SharedTableRecord, "name" | "columns">;

export interface UpsertSharedTableRowInput {
  key: string;
  values: Record<string, unknown>;
  agentId?: string | null;
}

export interface SharedTableRowRecord {
  key: string;
  values: Record<string, unknown>;
  updatedByAgentId: string | null;
  updatedAt: string;
}

export interface OpenWaitRecord {
  id: string;
  companyId: string;
  agentId: string;
  eventKey: string;
  note: string;
  requestContext: Record<string, unknown>;
  status: "waiting" | "resumed" | "expired" | "cancelled";
  expiresAtMs: number | null;
  matchedPayload: Record<string, unknown> | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CreateOpenWaitInput {
  agentId: string;
  eventKey: string;
  note: string;
  requestContext: Record<string, unknown>;
  ttlMs?: number;
}

const companyPath = (companyId: string) => `/companies/${encodeURIComponent(companyId)}`;

export const workspacePrimitivesApi = {
  listSharedTables: (companyId: string) =>
    api.get<SharedTableRecord[]>(`${companyPath(companyId)}/shared-tables`),
  createSharedTable: (companyId: string, input: CreateSharedTableInput) =>
    api.post<SharedTableRecord>(`${companyPath(companyId)}/shared-tables`, input),
  upsertSharedTableRow: (companyId: string, tableId: string, row: UpsertSharedTableRowInput) =>
    api.post<SharedTableRowRecord>(
      `${companyPath(companyId)}/shared-tables/${encodeURIComponent(tableId)}/rows`,
      row,
    ),
  listOpenWaits: (companyId: string, agentId?: string) => {
    const query = agentId === undefined ? "" : `?agentId=${encodeURIComponent(agentId)}`;
    return api.get<OpenWaitRecord[]>(`${companyPath(companyId)}/open-waits${query}`);
  },
  createOpenWait: (companyId: string, input: CreateOpenWaitInput) =>
    api.post<OpenWaitRecord>(`${companyPath(companyId)}/open-waits`, input),
  resolveOpenWait: (companyId: string, waitId: string) =>
    api.post<{ id: string; companyId: string; status: "cancelled" }>(
      `${companyPath(companyId)}/open-waits/${encodeURIComponent(waitId)}/resolve`,
      {},
    ),
};
