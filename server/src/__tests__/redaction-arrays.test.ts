import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactEventPayload, sanitizeRecord } from "../redaction.js";

// HS256 compact JWS (3 segments) and a dir/A256GCM compact JWE (5 segments).
const JWS =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const JWE =
  "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..yuOpLS0yXsQyOr7P.xWw9fTXNKeVN_UXm9VskDN8u2umjBVlFfOZea40CIzeb7CPfctf_MJxE_PZlING7.zxPgnoRoT0oSDLB71N2Vpg";
const FILE_NAMES = ["research-ai-news.raw.json", "community-ai-news.raw.json", "youtube-publish.v1.json"];

describe("redaction of JWT values inside arrays", () => {
  it("redacts genuine JWS and JWE elements of a top-level array", () => {
    const result = sanitizeRecord({ args: [JWS, "keep-me", JWE] });

    expect(result.args).toEqual([REDACTED_EVENT_VALUE, "keep-me", REDACTED_EVENT_VALUE]);
  });

  it("redacts tokens in nested arrays and preserves element order and non-string elements", () => {
    const result = sanitizeRecord({
      args: [[JWS], 42, null, true, ["a", [JWE, 0]], { note: "ok" }],
    });

    expect(result.args).toEqual([
      [REDACTED_EVENT_VALUE],
      42,
      null,
      true,
      ["a", [REDACTED_EVENT_VALUE, 0]],
      { note: "ok" },
    ]);
  });

  it("redacts tokens in objects inside arrays, including under plain bindings", () => {
    const result = sanitizeRecord({
      items: [
        { session: JWS, label: "first" },
        [{ nested: { token: JWE } }],
        { type: "plain", value: JWS },
        { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111" },
      ],
    });

    expect(result.items).toEqual([
      { session: REDACTED_EVENT_VALUE, label: "first" },
      [{ nested: { token: REDACTED_EVENT_VALUE } }],
      { type: "plain", value: REDACTED_EVENT_VALUE },
      { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111" },
    ]);
  });

  it("preserves file names and ordinary strings inside arrays", () => {
    const result = sanitizeRecord({
      artifacts: [...FILE_NAMES, "v1.2.3", "foo.bar.baz"],
      nested: [[...FILE_NAMES], { artifactFileName: FILE_NAMES[0] }],
    });

    expect(result.artifacts).toEqual([...FILE_NAMES, "v1.2.3", "foo.bar.baz"]);
    expect(result.nested).toEqual([[...FILE_NAMES], { artifactFileName: FILE_NAMES[0] }]);
  });

  it("preserves eyJ-prefixed lookalikes inside arrays", () => {
    const lookalikes = [
      // header decodes to a JSON object without alg/typ/enc
      "eyJub3RoaW5nIjoxfQ.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      // 4 segments is neither JWS nor JWE
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XG.extra",
    ];

    const result = sanitizeRecord({ values: [...lookalikes, JWS] });

    expect(result.values).toEqual([...lookalikes, REDACTED_EVENT_VALUE]);
  });

  it("still redacts the whole array under a sensitive key", () => {
    const result = sanitizeRecord({ authorization: ["Bearer", JWS], fileName: FILE_NAMES[0] });

    expect(result).toEqual({ authorization: REDACTED_EVENT_VALUE, fileName: FILE_NAMES[0] });
  });

  it("redacts array elements through the event payload entry point", () => {
    const result = redactEventPayload({
      event: "tool.call",
      data: { tool: "fetch", args: [{ url: "https://example.com", headers: ["Authorization: Bearer x", JWE] }] },
    });

    expect(result).toEqual({
      event: "tool.call",
      data: { tool: "fetch", args: [{ url: "https://example.com", headers: ["Authorization: Bearer x", REDACTED_EVENT_VALUE] }] },
    });
  });
});
