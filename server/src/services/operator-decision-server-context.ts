import { and, desc, eq } from "drizzle-orm";
import { missionPlanArtifacts, type Db } from "@paperclipai/db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Server-owned context keys — persisted on the stored row but excluded when rebuilding
 * the caller-authored immutable card input for the strict public schema / requestHash.
 * planDecisionHash·missionOwnerHumanInput are joined at create/merge time; the choice-card
 * keys (decisionKind/decisionPoint/choiceOptions/ttlMs/suggestedDecision/safeAutoAdvance/
 * irreversible) are joined by the owner-choice-card producer — neither may be caller-forged.
 */
const SERVER_OWNED_CONTEXT_KEYS = new Set([
  "planDecisionHash",
  "missionOwnerHumanInput",
  "decisionKind",
  "decisionPoint",
  "choiceOptions",
  "ttlMs",
  "suggestedDecision",
  "safeAutoAdvance",
  "irreversible",
]);

/** Server-owned context is excluded when rebuilding the caller-authored immutable card input. */
export function stripOperatorDecisionServerContext(sourceContext: unknown): Record<string, unknown> {
  if (sourceContext === null || typeof sourceContext !== "object" || Array.isArray(sourceContext)) return {};
  return Object.fromEntries(Object.entries(sourceContext as Record<string, unknown>)
    .filter(([key]) => !SERVER_OWNED_CONTEXT_KEYS.has(key)));
}

/** Current active owner-plan decision hash used to bind a human approval to one revision. */
export async function activePlanDecisionHash(db: Pick<Db, "select">, companyId: string, missionId: string) {
  if (!UUID_RE.test(missionId)) return null;
  const [plan] = await db.select({ refs: missionPlanArtifacts.refs }).from(missionPlanArtifacts)
    .where(and(eq(missionPlanArtifacts.companyId, companyId), eq(missionPlanArtifacts.missionId, missionId),
      eq(missionPlanArtifacts.status, "active")))
    .orderBy(desc(missionPlanArtifacts.revision)).limit(1);
  const refs = plan?.refs !== null && typeof plan?.refs === "object" && !Array.isArray(plan.refs)
    ? plan.refs as Record<string, unknown> : {};
  const owner = refs.ownerPlanDecision !== null && typeof refs.ownerPlanDecision === "object"
    && !Array.isArray(refs.ownerPlanDecision) ? refs.ownerPlanDecision as Record<string, unknown> : {};
  return typeof owner.decisionHash === "string" && owner.decisionHash.trim() ? owner.decisionHash : null;
}
