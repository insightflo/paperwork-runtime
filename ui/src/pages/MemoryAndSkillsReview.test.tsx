/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSkillDraft, MemoryReviewProposal } from "../api/agentGovernanceLearning";
import { MemoryAndSkillsReview } from "./MemoryAndSkillsReview";

const { mockState, decideSpy, promoteSpy, discardSpy, invalidateSpy } = vi.hoisted(() => ({
  mockState: {
    memoryReviews: [] as MemoryReviewProposal[],
    skillDrafts: [] as LocalSkillDraft[],
  },
  decideSpy: vi.fn().mockResolvedValue({ id: "mr-1" }),
  promoteSpy: vi.fn().mockResolvedValue({ id: "sd-1" }),
  discardSpy: vi.fn().mockResolvedValue({ id: "sd-1" }),
  invalidateSpy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: invalidateSpy }),
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => ({
    data: queryKey[0] === "memory-reviews" ? mockState.memoryReviews : mockState.skillDrafts,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
  useMutation: (opts: {
    mutationFn: (vars: never) => Promise<unknown>;
    onSuccess?: (data: unknown, vars: unknown) => void;
  }) => ({
    isPending: false,
    mutate: (vars: never) => {
      void opts.mutationFn(vars).then((data) => opts.onSuccess?.(data, vars));
    },
  }),
}));

vi.mock("../api/agentGovernanceLearning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/agentGovernanceLearning")>();
  return {
    ...actual,
    agentGovernanceLearningApi: {
      ...actual.agentGovernanceLearningApi,
      listMemoryReviews: vi.fn(() => Promise.resolve(mockState.memoryReviews)),
      decideMemoryReview: decideSpy,
      listSkillDrafts: vi.fn(() => Promise.resolve(mockState.skillDrafts)),
      promoteSkillDraft: promoteSpy,
      discardSkillDraft: discardSpy,
    },
  };
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

const proposal: MemoryReviewProposal = {
  id: "mr-1",
  companyId: "company-1",
  agentId: "agent-1",
  targetPath: "skills/release-writer.md",
  beforeContent: "이전 지시",
  afterContent: "새 지시",
  diffLines: ["@@ -1,2 +1,2 @@", "-이전 지시", "+새 지시"],
  summary: "릴리스 노트 스킬 지시를 갱신",
  status: "pending",
  heldUntilMs: null,
  reviewedByUserId: null,
  reviewNote: null,
  createdAt: "2026-07-29T10:00:00.000Z",
  updatedAt: "2026-07-29T10:00:00.000Z",
};

const draft: LocalSkillDraft = {
  id: "sd-1",
  companyId: "company-1",
  slug: "release-notes-writer",
  title: "릴리스 노트 작성기",
  description: "런 로그에서 추출된 스킬 초안",
  revision: 3,
  contentSha256: "a".repeat(64),
  skillMarkdown: "---\nname: release-notes-writer\n---\n# SKILL",
  sourceRunIds: ["run-1", "run-2"],
  status: "draft",
  createdAt: "2026-07-29T10:00:00.000Z",
  updatedAt: "2026-07-29T10:00:00.000Z",
};

let host: HTMLDivElement;
let root: Root;

function renderPage() {
  return act(async () => root.render(<MemoryAndSkillsReview />));
}

function findButton(label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  if (!button) throw new Error(`button not found: ${label}`);
  return button as HTMLButtonElement;
}

function clickTab(label: string) {
  const tab = [...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.includes(label));
  if (!tab) throw new Error(`tab not found: ${label}`);
  // Radix Tabs activates on mousedown, not click.
  return act(async () => tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
}

describe("MemoryAndSkillsReview", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mockState.memoryReviews = [{ ...proposal }];
    mockState.skillDrafts = [{ ...draft }];
    decideSpy.mockClear();
    promoteSpy.mockClear();
    discardSpy.mockClear();
    invalidateSpy.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("renders memory diff lines and calls decideMemoryReview on approve/hold/reject", async () => {
    await renderPage();

    expect(host.textContent).toContain("skills/release-writer.md");
    expect(host.textContent).toContain("릴리스 노트 스킬 지시를 갱신");

    const addLine = host.querySelector('[data-diff-type="add"]');
    const delLine = host.querySelector('[data-diff-type="del"]');
    expect(addLine?.textContent).toContain("+새 지시");
    expect(delLine?.textContent).toContain("-이전 지시");
    expect(addLine?.className).toContain("emerald");
    expect(delLine?.className).toContain("rose");

    await act(async () => findButton("승인 (Approve)").click());
    expect(decideSpy).toHaveBeenCalledWith("company-1", "mr-1", { decision: "approve" });

    await act(async () => findButton("보류 (Hold 24h)").click());
    expect(decideSpy).toHaveBeenCalledWith("company-1", "mr-1", { decision: "hold" });

    await act(async () => findButton("반려 (Reject)").click());
    expect(decideSpy).toHaveBeenCalledWith("company-1", "mr-1", { decision: "reject" });
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("switches to the skill drafts tab, shows revision and SHA-256, and calls promote/discard", async () => {
    await renderPage();

    expect(host.querySelector('[role="tab"]')?.textContent).toContain("메모리 Diff 리뷰");
    await clickTab("자동 학습 스킬 초안");

    expect(host.textContent).toContain("release-notes-writer");
    expect(host.textContent).toContain("v3");
    expect(host.textContent).toContain(draft.contentSha256.slice(0, 12));
    expect(host.textContent).toContain("소스 런 2개");

    await act(async () => findButton("승격 (Promote)").click());
    expect(promoteSpy).toHaveBeenCalledWith("company-1", "sd-1");

    await act(async () => findButton("폐기 (Discard)").click());
    expect(discardSpy).toHaveBeenCalledWith("company-1", "sd-1");
    expect(invalidateSpy).toHaveBeenCalled();
  });
});
