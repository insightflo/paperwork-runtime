// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, ApprovalComment, IssueComment } from "@paperclipai/shared";
import { ApprovalComments } from "../ApprovalComments";
import { ApprovalCard } from "../ApprovalCard";
import { CommentThread } from "../CommentThread";
import { CompanyLanguageProvider } from "../../lib/companyLanguage";

vi.mock("../../lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("../../context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));
// jsdom rejects Stitches' sentinel selector. Normalize only that marker so the
// real MarkdownEditor and Lexical contenteditable remain under test.
const { originalInsertRule } = vi.hoisted(() => {
  const insertRule = CSSStyleSheet.prototype.insertRule;
  CSSStyleSheet.prototype.insertRule = function (rule, index) {
    return insertRule.call(this, rule.replace(/^--sxs\{/, "x-sxs{"), index);
  };
  return { originalInsertRule: insertRule };
});
afterAll(() => { CSSStyleSheet.prototype.insertRule = originalInsertRule; });

const approval: Approval = {
  id: "approval-1", companyId: "company-1", type: "hire_agent", status: "pending",
  payload: { name: "Reviewer", role: "engineer" }, requestedByAgentId: null,
  requestedByUserId: "board", requestedByPluginId: null, decisionNote: null,
  decidedByUserId: null, decidedAt: null,
  createdAt: new Date("2026-11-28"), updatedAt: new Date("2026-11-28"),
};
const approvalComment: ApprovalComment = {
  id: "comment-1", companyId: "company-1", approvalId: approval.id,
  authorAgentId: null, authorUserId: "board", body: "Please review",
  createdAt: new Date("2026-11-28"), updatedAt: new Date("2026-11-28"),
};
const issueComment: IssueComment = {
  id: "comment-1", companyId: "company-1", issueId: "issue-1",
  authorAgentId: null, authorUserId: "board", body: "Please review",
  createdAt: new Date("2026-11-28"), updatedAt: new Date("2026-11-28"),
};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers();
  localStorage.removeItem("approval-a11y-draft");
});
async function render(ui: ReactNode) {
  await act(async () => root.render(<MemoryRouter>{ui}</MemoryRouter>));
}
function button(name: string) {
  const result = host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  expect(result, name).not.toBeNull();
  expect(result!.getAttribute("type")).toBe("button");
  return result!;
}
function comments(props: Partial<Parameters<typeof ApprovalComments>[0]> = {}) {
  return <ApprovalComments comments={[]} agentNameById={new Map()} commentBody="Ready"
    setCommentBody={vi.fn()} isPending={false} onPost={vi.fn()} {...props} />;
}
function card(props: Partial<Parameters<typeof ApprovalCard>[0]> = {}) {
  return <ApprovalCard approval={approval} requesterAgent={null} onApprove={vi.fn()}
    onReject={vi.fn()} isPending={false} {...props} />;
}

describe("approval comment accessibility", () => {
  it.each([["en", "Approval comment", "Post comment"], ["ko", "승인 댓글", "댓글 게시"]] as const)(
    "provides an explicit input name and action in %s", async (language, label, action) => {
      await render(<CompanyLanguageProvider language={language}>{comments()}</CompanyLanguageProvider>);
      const input = host.querySelector("textarea")!;
      expect(input.getAttribute("aria-label")).toBe(label);
      input.focus(); expect(document.activeElement).toBe(input);
      expect(button(action).disabled).toBe(false);
    },
  );

  it("keeps typing and posting connected without submitting an enclosing form", async () => {
    const post = vi.fn(); const submit = vi.fn();
    function Composer() {
      const [body, setBody] = useState("Ready");
      return <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        {comments({ commentBody: body, setCommentBody: setBody, onPost: () => post(body) })}
      </form>;
    }
    await render(<Composer />);
    const input = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Updated");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("Updated");
    await act(async () => button("Post comment").click());
    expect(post).toHaveBeenCalledExactlyOnceWith("Updated"); expect(submit).not.toHaveBeenCalled();
  });

  it("keeps pending and comment-count announcements in persistent polite regions", async () => {
    await render(comments());
    const region = button("Post comment").parentElement!;
    expect(region.getAttribute("aria-live")).toBe("polite");
    const heading = host.querySelector("h3")!;
    expect(heading.getAttribute("aria-live")).toBe("polite");
    await render(comments({ isPending: true, comments: [approvalComment] }));
    expect(region.isConnected).toBe(true); expect(region.textContent).toContain("Posting…");
    expect(button("Post comment").disabled).toBe(true);
    expect(heading.textContent).toContain("Comments (1)");
    await render(comments({ commentBody: "   " }));
    expect(button("Post comment").disabled).toBe(true);
  });
});

describe("approval card accessibility", () => {
  it("names actions and prevents accidental form submission", async () => {
    const reject = vi.fn(); const open = vi.fn(); const submit = vi.fn();
    await render(<form onSubmit={(event) => { event.preventDefault(); submit(); }}>
      {card({ onReject: reject, onOpen: open })}
    </form>);
    // The existing missing-review-information guard still disables approval.
    expect(button("Approve").disabled).toBe(true);
    await act(async () => { button("Reject").click(); button("View details").click(); });
    expect(reject).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it("announces status changes without announcing the entire card", async () => {
    await render(card());
    const region = host.querySelector('[aria-live="polite"]')!;
    expect(region.textContent).toContain("Pending");
    await render(card({ approval: { ...approval, status: "approved" } }));
    expect(region.isConnected).toBe(true); expect(region.textContent).toContain("Approved");
    expect(host.querySelector('button[aria-label="Approve"]')).toBeNull();
  });

  it("preserves detail navigation as a link and pending action guards", async () => {
    await render(card({ detailLink: "/approvals/approval-1", isPending: true }));
    expect(button("Reject").disabled).toBe(true);
    const link = host.querySelector('a[href="/approvals/approval-1"]');
    expect(link?.textContent).toContain("View details");
    expect(link?.hasAttribute("type")).toBe(false);
  });
});

describe("comment thread accessibility", () => {
  it("names icon controls and retains the real editor's accessible name", async () => {
    await render(<CommentThread comments={[issueComment]} onAdd={vi.fn()} onAttachImage={vi.fn()} />);
    expect(button("Copy as markdown")).toBeTruthy();
    expect(button("Attach image")).toBeTruthy();
    expect(host.querySelector('input[type="file"]')?.getAttribute("aria-label")).toBe("Attach image");
    expect(host.querySelector('[contenteditable="true"]')?.getAttribute("aria-label")).toBe("editable markdown");
    expect(button("Comment").disabled).toBe(true);
  });

  it("announces successful copy feedback", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await render(<CommentThread comments={[issueComment]} onAdd={vi.fn()} readOnly />);
    await act(async () => button("Copy as markdown").click());
    expect(writeText).toHaveBeenCalledWith("Please review");
    expect(button("Copied").getAttribute("aria-live")).toBe("polite");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(button("Copy as markdown")).toBeTruthy();
    expect(host.querySelector('[contenteditable="true"]')).toBeNull();
  });

  it("announces pending posting and preserves the existing submit contract", async () => {
    localStorage.setItem("approval-a11y-draft", "Ready to post");
    let finish!: () => void;
    const post = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const submit = vi.fn();
    await render(<form onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <CommentThread comments={[]} onAdd={post} draftKey="approval-a11y-draft" />
    </form>);
    await act(async () => button("Comment").click());
    expect(post).toHaveBeenCalledExactlyOnceWith("Ready to post", true, undefined);
    expect(submit).not.toHaveBeenCalled();
    expect(button("Posting...").disabled).toBe(true);
    expect(button("Posting...").getAttribute("aria-live")).toBe("polite");
    await act(async () => finish());
    expect(button("Comment").disabled).toBe(true);
    expect(localStorage.getItem("approval-a11y-draft")).toBeNull();
  });

  it("announces attachment progress and keeps the picker usable", async () => {
    let finish!: () => void;
    const attach = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    await render(<CommentThread comments={[]} onAdd={vi.fn()} onAttachImage={attach} />);
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, "click");
    await act(async () => button("Attach image").click());
    expect(click).toHaveBeenCalledOnce();
    const file = new File(["image"], "note.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(attach).toHaveBeenCalledWith(file);
    expect(button("Attaching image...").disabled).toBe(true);
    expect(button("Attaching image...").getAttribute("aria-live")).toBe("polite");
    await act(async () => finish());
    expect(button("Attach image").disabled).toBe(false);
  });
});
