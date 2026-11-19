import { afterEach, describe, expect, it } from "vitest";
import {
  clearRegisteredRuntimeSecretsForTests,
  redactBeforeTruncate,
  redactEmbeddedJson,
  redactSensitiveText,
  registerRuntimeSecrets,
} from "./secret-redactor.js";

afterEach(() => {
  clearRegisteredRuntimeSecretsForTests();
});

describe("secret-redactor", () => {
  it("masks registered secrets across raw, JSON-escaped, and URL-encoded forms while sparing HTTPS hosts", () => {
    const raw = "x7Kq/9+secret=val";
    registerRuntimeSecrets([raw]);

    expect(redactSensitiveText(`token=${raw}`)).toBe("token=[redacted]");
    expect(redactSensitiveText(`encoded=${encodeURIComponent(raw)}`)).toBe("encoded=[redacted]");
    expect(redactSensitiveText(`escaped="${JSON.stringify(raw).slice(1, -1)}"`)).toBe('escaped="[redacted]"');

    registerRuntimeSecrets(["acme-corp.internal"]);
    const urlLine = "fetching https://acme-corp.internal/v1/items and header X-Secret: acme-corp.internal";
    const redacted = redactSensitiveText(urlLine);
    expect(redacted).toContain("https://acme-corp.internal/v1/items");
    expect(redacted).not.toContain("X-Secret: acme-corp.internal");
  });

  it("grows token match around registered substring without keeping trailing secret suffix", () => {
    registerRuntimeSecrets(["abc12345"]);
    expect(redactSensitiveText("Authorization: abc12345_extra_tail")).toBe("Authorization: [redacted]");
  });

  it("fails closed on unclosed embedded JSON objects (streamed stderr chunks)", () => {
    const line = 'ERROR request failed: {"headers":{"X-Tenant":"tenant-secret-123","Authorization":"Bearer topsecret';
    const out = redactSensitiveText(line);
    expect(out).toBe("ERROR request failed: [redacted-unscanned]");
    expect(out).not.toContain("tenant-secret-123");
    expect(out).not.toContain("topsecret");
  });

  it("masks nested headers string values in complete embedded JSON payloads while keeping keys", () => {
    const line = 'WARN upstream={"headers":{"X-Tenant":"secret-t1","X-Region":"kr-1"},"ok":true}';
    const out = redactSensitiveText(line);
    expect(out).toContain('"X-Tenant":"[redacted]"');
    expect(out).toContain('"X-Region":"[redacted]"');
    expect(out).toContain('"ok":true');
    expect(out).not.toContain("secret-t1");
  });

  it("caps embedded JSON scans at 16 and fails closed past the bound unless keepUnscanned", () => {
    const many = `${Array.from({ length: 17 }, (_, i) => `{"k${i}":"v${i}"}`).join(" ")} {"secret":"tail"}`;
    const dropped = redactEmbeddedJson(many);
    expect(dropped).toContain("[redacted-unscanned]");
    expect(dropped).not.toContain("tail");

    const kept = redactSensitiveText(many, { keepUnscanned: true });
    expect(kept).not.toContain("[redacted-unscanned]");
    expect(kept).not.toContain('"tail"');
  });

  it("masks known prefixes, JWTs, query params with digits, and redacts BEFORE truncating", () => {
    const longLine = `${"a".repeat(40)} Authorization: Bearer verysecretvalue1234567890 ${"b".repeat(40)}`;
    const truncated = redactBeforeTruncate(longLine, 68);
    expect(truncated).not.toContain("verysecretvalue");
    expect(truncated).toContain("[redacted]");
    expect(truncated.endsWith("…")).toBe(true);

    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.sig_part_abc";
    expect(redactSensitiveText(`tok=${jwt} url=https://ex.com?code=1234abcd90`)).toBe(
      "tok=[redacted] url=https://ex.com?code=[redacted]",
    );
  });

  it("does not burn embedded JSON budget on plain brackets and keeps UTF-16 surrogates intact on truncate", () => {
    const out = redactSensitiveText(`${"[x] ".repeat(16)}{"headers":{"X-Custom-Auth":"leak-secret-123"}}`, { keepUnscanned: true });
    expect(out).not.toContain("leak-secret-123");
    expect(out).toContain('"X-Custom-Auth":"[redacted]"');

    const cut = redactBeforeTruncate("abc🚀def", 4);
    expect(cut).toBe("abc…");
  });
});
