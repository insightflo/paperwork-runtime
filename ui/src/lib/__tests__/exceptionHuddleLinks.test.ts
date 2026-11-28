import { describe, expect, it } from "vitest";
import {
  buildExceptionHuddlePath,
  parseExceptionHuddleSearch,
} from "../exceptionHuddleLinks";

describe("buildExceptionHuddlePath", () => {
  it("builds a company-prefixed huddle link", () => {
    expect(
      buildExceptionHuddlePath({
        companyPrefix: "PAP",
        channelId: "channel-1",
        threadId: "thread-1",
      }),
    ).toBe("/PAP/channels?channelId=channel-1&threadId=thread-1");
  });

  it("omits an empty or whitespace-only company prefix", () => {
    expect(
      buildExceptionHuddlePath({
        companyPrefix: null,
        channelId: "channel-1",
        threadId: "thread-1",
      }),
    ).toBe("/channels?channelId=channel-1&threadId=thread-1");
    expect(
      buildExceptionHuddlePath({
        companyPrefix: "   ",
        channelId: "channel-1",
        threadId: "thread-1",
      }),
    ).toBe("/channels?channelId=channel-1&threadId=thread-1");
  });

  it("trims ids and prefix before encoding", () => {
    expect(
      buildExceptionHuddlePath({
        companyPrefix: "  PAP  ",
        channelId: "  channel-1  ",
        threadId: "\tthread-1\n",
      }),
    ).toBe("/PAP/channels?channelId=channel-1&threadId=thread-1");
  });

  it("adds the huddle decision focus flag only when requested", () => {
    expect(
      buildExceptionHuddlePath({
        companyPrefix: "PAP",
        channelId: "channel-1",
        threadId: "thread-1",
        focusDecision: true,
      }),
    ).toBe("/PAP/channels?channelId=channel-1&threadId=thread-1&focus=huddle-decision");
    expect(
      buildExceptionHuddlePath({
        companyPrefix: "PAP",
        channelId: "channel-1",
        threadId: "thread-1",
        focusDecision: false,
      }),
    ).toBe("/PAP/channels?channelId=channel-1&threadId=thread-1");
  });

  it("encodes special characters in path and query values", () => {
    expect(
      buildExceptionHuddlePath({
        companyPrefix: "PA/P?",
        channelId: "channel alpha/beta?",
        threadId: "thread#1+2",
      }),
    ).toBe(
      "/PA%2FP%3F/channels?channelId=channel%20alpha%2Fbeta%3F&threadId=thread%231%2B2",
    );
  });
});

describe("parseExceptionHuddleSearch", () => {
  it("parses a search string with or without the leading question mark", () => {
    const expected = {
      channelId: "channel-1",
      threadId: "thread-1",
      focusDecision: true,
    };
    expect(parseExceptionHuddleSearch("?channelId=channel-1&threadId=thread-1&focus=huddle-decision")).toEqual(expected);
    expect(parseExceptionHuddleSearch("channelId=channel-1&threadId=thread-1&focus=huddle-decision")).toEqual(expected);
  });

  it("returns nulls and false for an empty search string", () => {
    expect(parseExceptionHuddleSearch("")).toEqual({
      channelId: null,
      threadId: null,
      focusDecision: false,
    });
  });

  it("returns null for missing params", () => {
    expect(parseExceptionHuddleSearch("?threadId=thread-1")).toEqual({
      channelId: null,
      threadId: "thread-1",
      focusDecision: false,
    });
    expect(parseExceptionHuddleSearch("?channelId=channel-1")).toEqual({
      channelId: "channel-1",
      threadId: null,
      focusDecision: false,
    });
  });

  it("trims values and treats whitespace-only params as null", () => {
    expect(parseExceptionHuddleSearch("?channelId=%20channel-1%20&threadId=%09thread-1%0a")).toEqual({
      channelId: "channel-1",
      threadId: "thread-1",
      focusDecision: false,
    });
    expect(parseExceptionHuddleSearch("?channelId=%20%20&threadId=%09")).toEqual({
      channelId: null,
      threadId: null,
      focusDecision: false,
    });
  });

  it("only enables focusDecision for the exact huddle decision flag after trimming", () => {
    expect(parseExceptionHuddleSearch("?focus=%20huddle-decision%20").focusDecision).toBe(true);
    expect(parseExceptionHuddleSearch("?focus=other").focusDecision).toBe(false);
    expect(parseExceptionHuddleSearch("?focus=").focusDecision).toBe(false);
  });

  it("round-trips a built huddle link", () => {
    const path = buildExceptionHuddlePath({
      companyPrefix: "PAP",
      channelId: "channel alpha/beta?",
      threadId: "thread#1+2",
      focusDecision: true,
    });
    const search = path.slice(path.indexOf("?"));
    expect(parseExceptionHuddleSearch(search)).toEqual({
      channelId: "channel alpha/beta?",
      threadId: "thread#1+2",
      focusDecision: true,
    });
  });

  it("handles malformed input without throwing", () => {
    expect(() => parseExceptionHuddleSearch("%E0%A4%A")).not.toThrow();
    expect(() =>
      buildExceptionHuddlePath({
        companyPrefix: "PAP",
        channelId: "channel-\ud800",
        threadId: "thread-1",
      }),
    ).not.toThrow();
  });
});
