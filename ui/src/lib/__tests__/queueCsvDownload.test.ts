import { describe, expect, it } from "vitest";
import {
  buildQueueCsvFilename,
  buildQueueTelemetryExportEndpoint,
  sanitizeExportSlug,
} from "../queueCsvDownload";

describe("sanitizeExportSlug", () => {
  it("lowercases and replaces space and symbol runs with hyphens", () => {
    expect(sanitizeExportSlug("  Acme Corp!! West  ")).toBe("acme-corp-west");
  });

  it("falls back to company for Korean or unicode-only input", () => {
    expect(sanitizeExportSlug("한글 회사")).toBe("company");
    expect(sanitizeExportSlug("株式会社")).toBe("company");
  });

  it("falls back to company for an empty string", () => {
    expect(sanitizeExportSlug("")).toBe("company");
  });
});

describe("buildQueueCsvFilename", () => {
  it("formats the timestamp deterministically in UTC", () => {
    const now = new Date(Date.UTC(2026, 0, 2, 3, 4, 56));
    expect(buildQueueCsvFilename("Acme Co", now)).toBe(
      "queue-telemetry-acme-co-20260102-0304.csv",
    );
  });
});

describe("buildQueueTelemetryExportEndpoint", () => {
  it("encodes the company id in the export path", () => {
    expect(buildQueueTelemetryExportEndpoint("company/one?")).toBe(
      "/api/companies/company%2Fone%3F/queue-telemetry/export.csv",
    );
  });

  it("adds includeIdle=true only when requested", () => {
    expect(buildQueueTelemetryExportEndpoint("company-1", { includeIdle: true })).toBe(
      "/api/companies/company-1/queue-telemetry/export.csv?includeIdle=true",
    );
    expect(buildQueueTelemetryExportEndpoint("company-1", { includeIdle: false })).toBe(
      "/api/companies/company-1/queue-telemetry/export.csv",
    );
    expect(buildQueueTelemetryExportEndpoint("company-1")).toBe(
      "/api/companies/company-1/queue-telemetry/export.csv",
    );
  });
});
