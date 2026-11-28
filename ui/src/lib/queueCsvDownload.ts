function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function sanitizeExportSlug(raw: string): string {
  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "company";
}

export function buildQueueCsvFilename(companySlug: string, now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = pad2(now.getUTCMonth() + 1);
  const day = pad2(now.getUTCDate());
  const hours = pad2(now.getUTCHours());
  const minutes = pad2(now.getUTCMinutes());
  return `queue-telemetry-${sanitizeExportSlug(companySlug)}-${year}${month}${day}-${hours}${minutes}.csv`;
}

export function buildQueueTelemetryExportEndpoint(
  companyId: string,
  opts?: { includeIdle?: boolean },
): string {
  const endpoint = `/api/companies/${encodeURIComponent(companyId)}/queue-telemetry/export.csv`;
  return opts?.includeIdle ? `${endpoint}?includeIdle=true` : endpoint;
}
