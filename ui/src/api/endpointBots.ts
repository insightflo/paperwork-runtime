import { api } from "./client";

/** Folder access granted to an endpoint bot; `ro` allows reads only, `rw` allows writes. */
export interface EndpointFolderGrant {
  path: string;
  mode: "ro" | "rw";
}

/** CLI detected on the endpoint machine, as a plain id or a detailed entry. */
export type EndpointDetectedCli =
  | string
  | { id: string; binary: string; path: string | null; available: boolean };

/** Public endpoint-bot view returned by `GET /companies/:companyId/endpoints` (no token hash). */
export interface EndpointBotRecord {
  companyId: string;
  deviceId: string;
  botName: string;
  os: string;
  arch: string;
  detectedClis: EndpointDetectedCli[];
  allowedFolders: EndpointFolderGrant[];
  tokenPreview: string;
  lastSeenMs: number;
  pendingOutboxCount: number;
  online: boolean;
}

/** Body of `POST /companies/:companyId/endpoints/pairing-codes`. */
export interface IssuePairingCodeInput {
  botName: string;
  requestedFolders: EndpointFolderGrant[];
  ttlMs?: number;
}

/** Response of `POST /companies/:companyId/endpoints/pairing-codes`. */
export interface PairingCodeResponse {
  code: string;
  expiresAtMs: number;
}

export type EnqueueLocalTaskKind =
  | "read_file"
  | "write_file"
  | "list_dir"
  | "shell_exec";

/** Body of `POST /companies/:companyId/endpoints/:deviceId/tasks`. */
export interface EnqueueLocalTaskInput {
  kind: EnqueueLocalTaskKind;
  targetPath: string;
  command?: string;
  args?: string[];
}

/** Local task record queued for an endpoint bot. */
export interface LocalTaskRecord {
  companyId: string;
  deviceId: string;
  taskId: string;
  kind: EnqueueLocalTaskKind;
  targetPath: string;
  command?: string;
  args?: string[];
  status: "pending" | "completed" | "failed";
  createdAtMs: number;
  completedAtMs?: number;
  ok?: boolean;
  output?: string;
  error?: string;
}

export const endpointBotsApi = {
  list: (companyId: string) =>
    api.get<EndpointBotRecord[]>(`/companies/${encodeURIComponent(companyId)}/endpoints`),
  issuePairingCode: (companyId: string, body: IssuePairingCodeInput) =>
    api.post<PairingCodeResponse>(
      `/companies/${encodeURIComponent(companyId)}/endpoints/pairing-codes`,
      body,
    ),
  enqueueTask: (companyId: string, deviceId: string, body: EnqueueLocalTaskInput) =>
    api.post<LocalTaskRecord>(
      `/companies/${encodeURIComponent(companyId)}/endpoints/${encodeURIComponent(deviceId)}/tasks`,
      body,
    ),
};
