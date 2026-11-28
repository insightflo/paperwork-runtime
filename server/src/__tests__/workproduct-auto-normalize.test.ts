import { describe, expect, it } from "vitest";
import {
  createIssueWorkProductSchema,
  updateIssueWorkProductSchema,
} from "@paperclipai/shared";

const base = { provider: "local", title: "A work product" };

describe("work product creation auto-normalization", () => {
  const contentInputs = [
    { title: "content.json" },
    { externalId: "content.json" },
    { externalId: "/workspace/output/content.json" },
    { externalId: "C:\\workspace\\content.json" },
    { metadata: { path: "content.json" } },
    { metadata: { path: "/workspace/output/content.json" } },
    { metadata: { path: "C:\\workspace\\content.json" } },
  ];

  it.each(contentInputs)("defaults content.json fields for %j", (input) => {
    expect(createIssueWorkProductSchema.parse({ ...base, ...input })).toMatchObject({
      type: "document",
      isPrimary: true,
    });
  });

  it.each([
    { type: "artifact", expectedType: "artifact", expectedPrimary: true },
    { isPrimary: false, expectedType: "document", expectedPrimary: false },
    { type: "artifact", isPrimary: false, expectedType: "artifact", expectedPrimary: false },
  ])("preserves explicit content.json values for %j", ({ expectedType, expectedPrimary, ...input }) => {
    expect(createIssueWorkProductSchema.parse({
      ...base, title: "content.json", ...input,
    })).toMatchObject({ type: expectedType, isPrimary: expectedPrimary });
  });

  const artifactInputs = [
    { title: "assets/infographic.png" },
    { externalId: "assets/infographic.png" },
    { externalId: "/workspace/assets/infographic.png" },
    { externalId: "C:\\workspace\\assets\\infographic.png" },
    { metadata: { path: "assets/infographic.png" } },
    { metadata: { path: "/workspace/assets/nested/infographic.png" } },
    { title: "security-precheck.json" },
    { externalId: "/workspace/security-precheck.json" },
    { metadata: { path: "/workspace/security-precheck.json" } },
  ];

  it.each(artifactInputs)("defaults artifact fields for %j", (input) => {
    expect(createIssueWorkProductSchema.parse({ ...base, ...input })).toMatchObject({
      type: "artifact",
      isPrimary: false,
    });
  });

  it.each(artifactInputs)("preserves explicit artifact values for %j", (input) => {
    expect(createIssueWorkProductSchema.parse({
      ...base, ...input, type: "document", isPrimary: true,
    })).toMatchObject({ type: "document", isPrimary: true });
  });

  it("prioritizes content.json over an assets directory", () => {
    expect(createIssueWorkProductSchema.parse({
      ...base, metadata: { path: "/workspace/assets/content.json" },
    })).toMatchObject({ type: "document", isPrimary: true });
  });

  it.each([
    {},
    { title: "notes.md" },
    { title: "output/content.json" },
    { externalId: "/workspace/not-content.json" },
    { metadata: { path: "/workspace/content.json.bak" } },
    { externalId: "/workspace/myassets/infographic.png" },
    { metadata: { path: "/workspace/assets" } },
    { externalId: null, metadata: null },
    { metadata: { path: 42 } },
  ])("still requires type for an unmatched work product: %j", (input) => {
    const result = createIssueWorkProductSchema.safeParse({ ...base, ...input });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["type"] }),
      ]));
    }
  });

  it("keeps existing defaults for an ordinary work product with a type", () => {
    expect(createIssueWorkProductSchema.parse({ ...base, type: "document" }))
      .toMatchObject({ type: "document", isPrimary: false });
  });

  it.each([
    { type: null }, { type: "invalid" }, { isPrimary: null }, { isPrimary: "false" },
  ])("does not replace invalid explicit values: %j", (input) => {
    expect(createIssueWorkProductSchema.safeParse({
      ...base, title: "content.json", ...input,
    }).success).toBe(false);
  });

  it.each([null, undefined, "content.json", [], 42])("rejects malformed input %j", (input) => {
    expect(createIssueWorkProductSchema.safeParse(input).success).toBe(false);
  });

  it("preserves context aliases without mutating the original input", () => {
    const workContextId = "00000000-0000-4000-8000-000000000001";
    const executionContextId = "00000000-0000-4000-8000-000000000002";
    const input = Object.freeze({
      ...base, title: "content.json", workContextId, executionContextId,
    });
    expect(createIssueWorkProductSchema.parse(input)).toMatchObject({
      projectId: workContextId,
      executionWorkspaceId: executionContextId,
      type: "document",
      isPrimary: true,
    });
    expect(input).not.toHaveProperty("type");
    expect(input).not.toHaveProperty("isPrimary");
    expect(input).not.toHaveProperty("projectId");
  });
});

describe("work product partial update", () => {
  it.each([
    {},
    { title: "content.json" },
    { externalId: "/workspace/content.json" },
    { metadata: { path: "/workspace/content.json" } },
    { title: "assets/infographic.png" },
    { title: "security-precheck.json" },
    { title: "content.json", type: "artifact", isPrimary: false },
  ])("does not inject defaults into %j", (input) => {
    expect(updateIssueWorkProductSchema.parse(input)).toEqual(input);
  });
});
