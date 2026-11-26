import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactEventPayload, sanitizeRecord } from "../redaction.js";

describe("redaction", () => {
  it("redacts sensitive keys and nested secret values", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        PAPERCLIP_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      PAPERCLIP_API_URL: "http://localhost:3100",
    });
  });

  it("redacts genuine JWT values even when key name is not sensitive", () => {
    // Realistic compact-serialized tokens: HS256, RS256 (JWS, 3 segments) and a JWE (5 segments).
    const jwtValues = {
      hs256:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      hs256Long:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFkYSJ9.NjPfXz90z7dRMW2qEGrPArEg2fOpCRw28vBP9jzkr5k",
      rs256:
        "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImsxIn0.eyJzdWIiOiIxMjM0NTY3ODkwIiwiaXNzIjoiaHR0cHM6Ly9leGFtcGxlLnRlc3QiLCJleHAiOjE4OTM0NTYwMDB9.sLz2B769c2-GckbfeqEHt2vhLj5hVLaYW5WySZA0VU84stx0ZKz_azFCUdsae19YMF5QBWSWlt-vlDpbH3iY-bzHZenqowjXP-i3ASlw4m6SbGp1JokHQ91CSyhury0A7yHrDlb36bvSVZ6ABrAMTUqzSyiarj5g7fJNcuUVvnApp-cCf5YirTnm7mga2Ig1JwY7T-RISNT-XBXmBjhcvNVBsmH6JiXECSKmDu_qnKFUxsxgvihb01K9w8fHMIDakvQDRkK8usEJSM1XKYdpzr_hegQSlZTWpC4v3dMEfD_fptxlvpZF4wHXGVYfKBkQMSJ62kwJbS83PqAJHvu22w",
      jwe: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..yuOpLS0yXsQyOr7P.xWw9fTXNKeVN_UXm9VskDN8u2umjBVlFfOZea40CIzeb7CPfctf_MJxE_PZlING7.zxPgnoRoT0oSDLB71N2Vpg",
    };

    const result = sanitizeRecord({ ...jwtValues, normal: "plain" });

    for (const [key, token] of Object.entries(jwtValues)) {
      expect(result[key], key).toBe(REDACTED_EVENT_VALUE);
    }
    expect(result.normal).toBe("plain");
  });

  it("redacts JWT values in nested records, keeps file names beside them", () => {
    const token =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = sanitizeRecord({
      artifact: { fileName: "research-ai-news.raw.json", session: token },
      items: [{ artifactFileName: "community-ai-news.raw.json" }, { session: token }],
    });

    expect(result.artifact).toEqual({ fileName: "research-ai-news.raw.json", session: REDACTED_EVENT_VALUE });
    expect(result.items).toEqual([{ artifactFileName: "community-ai-news.raw.json" }, { session: REDACTED_EVENT_VALUE }]);
  });

  it("does not redact ordinary dotted file names and version strings", () => {
    const fileNames = [
      "research-ai-news.raw.json",
      "community-ai-news.raw.json",
      "youtube-publish.v1.json",
      "foo.bar.baz",
      "v1.2.3",
      "report.final.draft.2026.pdf",
      "notes.2026-01-02.md",
    ];

    for (const fileName of fileNames) {
      const result = sanitizeRecord({ artifactFileName: fileName, nested: { artifactFileName: fileName } });
      expect(result.artifactFileName, fileName).toBe(fileName);
      expect(result.nested, fileName).toEqual({ artifactFileName: fileName });
    }
  });

  it("does not treat eyJ-prefixed lookalikes with non-JWT headers as JWTs", () => {
    const lookalikes = [
      // header is not base64url JSON
      "eyJzb21lb24g.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      // header decodes to a JSON object without alg/typ/enc
      "eyJub3RoaW5nIjoxfQ.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      // header decodes to a JSON array
      "eyJhbGciIl19.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      // signature too short
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2hvcnQ",
      // payload too short
      "eyJhbGciOiJIUzI1NiJ9.eyJhfQ.dozjgNryP4J3jVmNHl0w5N_XG",
      // 4 segments is neither JWS nor JWE
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XG.extra",
      // wrong segment count for JWE (5) but too-short tag
      "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.tag",
    ];

    for (const value of lookalikes) {
      expect(sanitizeRecord({ artifactFileName: value }).artifactFileName, value).toBe(value);
    }
  });

  it("still redacts dotted values under sensitive keys regardless of shape", () => {
    const result = sanitizeRecord({
      authorization: "Bearer research-ai-news.raw.json",
      accessToken: "v1.2.3",
      jwt: "aaa.bbb.ccc",
      secret: { type: "plain", value: "foo.bar.baz" },
      fileName: "youtube-publish.v1.json",
    });

    expect(result).toEqual({
      authorization: REDACTED_EVENT_VALUE,
      accessToken: REDACTED_EVENT_VALUE,
      jwt: REDACTED_EVENT_VALUE,
      secret: { type: "plain", value: REDACTED_EVENT_VALUE },
      fileName: "youtube-publish.v1.json",
    });
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });
});
