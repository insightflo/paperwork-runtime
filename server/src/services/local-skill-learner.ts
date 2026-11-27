// server/src/services/local-skill-learner.ts
// [파일 목적] 런 결과에서 로컬 SKILL.md 초안을 추출·관리하는 학습 장부.
//   동일 내용은 sha256 중복 제거로 한 초안에 런 출처만 누적하고, 내용이 바뀌면
//   불변 다음 리비전을 만든다. promote/discard는 초안 상태 전이만 수행한다.

import { createHash, randomUUID } from "node:crypto";
import { badRequest, conflict, notFound } from "../errors.js";

export type LocalSkillDraftStatus = "draft" | "promoted" | "discarded";

export interface LocalSkillDraft {
  id: string;
  companyId: string;
  slug: string;
  title: string;
  description: string;
  revision: number;
  contentSha256: string;
  skillMarkdown: string;
  sourceRunIds: string[];
  status: LocalSkillDraftStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ExtractSkillDraftInput {
  companyId: string;
  slug: string;
  title: string;
  description: string;
  steps: string[];
  sourceRunId: string;
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`${label} is required`);
  }
}

// SKILL.md는 프론트매터 + 번호 매기기 절차의 결정론적 템플릿이다. 같은 입력이
// 항상 같은 바이트를 만들어야 contentSha256 중복 제거 계약이 성립한다.
export function buildSkillMarkdown(input: ExtractSkillDraftInput): string {
  const procedure = input.steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  return [
    "---",
    `name: ${input.slug}`,
    `description: ${input.description}`,
    "---",
    "",
    `# ${input.title}`,
    "",
    "## Procedure",
    "",
    procedure,
    "",
  ].join("\n");
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface LocalSkillLearnerStore {
  extractDraft(input: ExtractSkillDraftInput): LocalSkillDraft;
  list(companyId: string, opts?: { status?: LocalSkillDraftStatus }): LocalSkillDraft[];
  promote(companyId: string, draftId: string): LocalSkillDraft;
  discard(companyId: string, draftId: string): LocalSkillDraft;
}

export function createLocalSkillLearnerStore(): LocalSkillLearnerStore {
  const drafts = new Map<string, LocalSkillDraft>();

  // 상태 전이는 draft 상태에서만 허용한다. promote 이후 discard(또는 그 반대)로
  // 최종 상태를 덮어쓰지 못하게 해 상태 감사 가능성을 지킨다.
  function transition(
    companyId: string,
    draftId: string,
    status: Exclude<LocalSkillDraftStatus, "draft">,
  ): LocalSkillDraft {
    const draft = drafts.get(draftId);
    // 회사 격리: 다른 회사 초안은 존재 여부조차 노출하지 않는다(notFound).
    if (!draft || draft.companyId !== companyId) {
      throw notFound("Skill draft not found");
    }
    if (draft.status !== "draft") {
      throw conflict(`Skill draft is already ${draft.status}`);
    }
    draft.status = status;
    draft.updatedAt = Date.now();
    return draft;
  }

  return {
    extractDraft(input) {
      assertNonEmpty(input.companyId, "companyId");
      assertNonEmpty(input.slug, "slug");
      assertNonEmpty(input.title, "title");
      assertNonEmpty(input.description, "description");
      assertNonEmpty(input.sourceRunId, "sourceRunId");
      if (
        !Array.isArray(input.steps) ||
        input.steps.length === 0 ||
        input.steps.some((step) => typeof step !== "string" || step.trim() === "")
      ) {
        throw badRequest("steps must be a non-empty array of non-empty strings");
      }
      const skillMarkdown = buildSkillMarkdown(input);
      const contentSha256 = sha256(skillMarkdown);
      const now = Date.now();
      const siblings = [...drafts.values()].filter(
        (draft) => draft.companyId === input.companyId && draft.slug === input.slug,
      );
      const duplicate = siblings.find((draft) => draft.contentSha256 === contentSha256);
      if (duplicate) {
        // 동일 내용: 리비전을 늘리지 않고 런 출처만 누적한다(중복 방지 계약).
        if (!duplicate.sourceRunIds.includes(input.sourceRunId)) {
          duplicate.sourceRunIds.push(input.sourceRunId);
          duplicate.updatedAt = now;
        }
        return duplicate;
      }
      const nextRevision =
        siblings.length > 0 ? Math.max(...siblings.map((draft) => draft.revision)) + 1 : 1;
      const draft: LocalSkillDraft = {
        id: randomUUID(),
        companyId: input.companyId,
        slug: input.slug,
        title: input.title,
        description: input.description,
        revision: nextRevision,
        contentSha256,
        skillMarkdown,
        sourceRunIds: [input.sourceRunId],
        status: "draft",
        createdAt: now,
        updatedAt: now,
      };
      drafts.set(draft.id, draft);
      return draft;
    },

    list(companyId, opts = {}) {
      return [...drafts.values()]
        .filter(
          (draft) =>
            draft.companyId === companyId &&
            (opts.status === undefined || draft.status === opts.status),
        )
        .sort((x, y) => y.createdAt - x.createdAt);
    },

    promote(companyId, draftId) {
      return transition(companyId, draftId, "promoted");
    },

    discard(companyId, draftId) {
      return transition(companyId, draftId, "discarded");
    },
  };
}

export const globalLocalSkillLearnerStore = createLocalSkillLearnerStore();
