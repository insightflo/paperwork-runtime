import { describe, expect, it } from "vitest";
import {
  classifyUserError,
  extractErrorReference,
  referenceCarrierName,
  userErrorDetails,
  userErrorMessage,
} from "./user-errors";

describe("user-errors", () => {
  it("extracts Error[ref:...] carriers cleanly and builds safe references", () => {
    const refName = referenceCarrierName("http/403/session_inactive");
    const err = new Error(`${refName}: request denied`);
    expect(extractErrorReference(err)).toBe("http/403/session_inactive");
    expect(extractErrorReference("ECONNREFUSED 127.0.0.1:5432")).toBe("errno/ECONNREFUSED");
    expect(extractErrorReference("some failure", "provider_overloaded")).toBe("code/provider_overloaded");
  });

  it("classifies 401/429/ECONNREFUSED/ENOSPC/ETIMEDOUT across categories", () => {
    expect(classifyUserError("HTTP 401: expired", null)).toBe("auth");
    expect(classifyUserError("exceeded retry limit, last status: 429 Too Many Requests", null)).toBe("rate-limit");
    expect(classifyUserError("ECONNREFUSED connect error", null)).toBe("network");
    expect(classifyUserError("ENOSPC: no space left on device", null)).toBe("storage");
    expect(classifyUserError("ETIMEDOUT waiting for upstream", null)).toBe("timeout");
  });

  it("suppresses filesystem paths, stack traces, SQLite dumps, and redacts secrets in product validation copy", () => {
    const fallback = "Action failed safely.";
    expect(userErrorMessage("SQLITE_FULL: database or disk is full", fallback)).toBe(fallback);
    expect(userErrorMessage("TypeError: Cannot read /Users/alice/.secret/key.json\n    at foo.ts:12", fallback)).toBe(
      fallback,
    );
    expect(userErrorMessage("Failed reading /srv/papercompany/secrets/prod.env", fallback)).toBe(fallback);

    const safeValidation = userErrorMessage("Invalid config: apiKey=sk-secret-value-12345 is not allowed", fallback);
    expect(safeValidation).not.toContain("sk-secret-value-12345");
    expect(safeValidation).toContain("[redacted]");

    const details = userErrorDetails("Error[ref:code/provider_overloaded]: No capacity", fallback, "provider_overloaded");
    expect(details.reference).toBe("code/provider_overloaded");
  });
});
