// [파일 목적] Quality RSI 서비스 — 작업자 RSI(Plan QA 반복 반려 → Wiki 자동 주입) +
//   QA 자체 RSI(Plan QA pass 후 취소/실패 미탐 → Plan QA 체크리스트 보강) + 완료/취소 미션 방치 항목 자동 정리.
import { and, desc, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import { companyKnowledgePatterns, missionPlanQaVerdicts, missions, qualityReviewItems, type Db } from "@paperclipai/db";
import { syncPromotedCanonToKb } from "./knowledge/kb-tree-admin.js";

export const QUALITY_RSI_CLOSED_STATUSES = [
  "resolved_pass", "resolved_fail", "dismissed", "closed", "evaluator_promoted", "evaluator_rejected",
] as const;
export const QUALITY_RSI_MIN_RECURRENCE = 2;
const ESCAPED_TRIGGER_SOURCES = ["final_qa_failure", "delivery_verification", "oversight_stall"] as const;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export type QualityRsiAxis = "worker" | "qa_self";
export type QualityRsiPatternStatus = "canon" | "auto_injected" | "observing";

export interface QualityRsiCluster {
  axis: QualityRsiAxis; code: string; signature: string; canonSignature: string;
  title: string; summary: string; count: number; recentCount30d: number; latestAt: string;
  samples: Array<{ missionTitle: string; detail: string; createdAt: string }>;
  rsiStatus: QualityRsiPatternStatus; wikiPatternId: string | null;
}

export interface QualityRsiOverview {
  stats: {
    pass30d: number; requestChanges30d: number; passRate30d: number | null;
    passAllTime: number; requestChangesAllTime: number; passRateAllTime: number | null;
    passedMissionsTotal: number; escapedMissionsCount: number; escapedDefectRate: number | null;
    autoInjectedCount: number; canonCount: number; openReviewItemsCount: number; staleReviewItemsCount: number;
  };
  clusters: QualityRsiCluster[];
  recentVerdicts: Array<{
    id: string; missionId: string; missionTitle: string; verdict: string;
    diagnosticCount: number; topDetail: string | null; createdAt: string;
  }>;
  openReviewItems: Array<{
    id: string; missionId: string | null; missionTitle: string | null; title: string;
    status: string; triggerSource: string; failureType: string | null; createdAt: string;
  }>;
}

export interface QualityRsiSyncResult {
  closedStaleItems: number; createdPatterns: number; skippedExisting: number; canonCount: number;
}

export function extractDiagnosticCode(diag: Record<string, unknown>): string {
  const raw =
    (typeof diag.code === "string" && diag.code.trim()) ||
    (typeof diag.class === "string" && diag.class.trim()) ||
    (typeof diag.check === "string" && diag.check.trim()) || "";
  if (!raw) return "general_qa_gap";
  if (/^template:[0-9a-f-]+:/i.test(raw)) return "template_contract_gap";
  return raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "general_qa_gap";
}

export function extractDiagnosticSummary(diag: Record<string, unknown>): string {
  for (const key of ["message", "problem", "finding", "detail", "brokenConnection"] as const) {
    const val = diag[key];
    if (typeof val === "string" && val.trim()) return val.trim().slice(0, 220);
  }
  return "";
}

export const shouldAutoGraduateToWiki = (count: number): boolean => count >= QUALITY_RSI_MIN_RECURRENCE;

export const canonSignatureFor = (signature: string): string =>
  signature.startsWith("quality-rsi:") ? `quality-rsi-canon:${signature.slice("quality-rsi:".length)}` : `quality-rsi-canon:${signature}`;

function upsertCluster(
  map: Map<string, QualityRsiCluster>,
  item: { axis: QualityRsiAxis; code: string; title: string; summary: string; missionTitle: string; detail: string; createdAt: Date },
  nowMs: number,
) {
  const signature = `quality-rsi:${item.code}`;
  const isRecent = nowMs - item.createdAt.getTime() <= THIRTY_DAYS_MS;
  const iso = item.createdAt.toISOString();
  const existing = map.get(signature);
  if (!existing) {
    map.set(signature, {
      axis: item.axis, code: item.code, signature, canonSignature: canonSignatureFor(signature),
      title: item.title, summary: item.summary, count: 1, recentCount30d: isRecent ? 1 : 0,
      latestAt: iso, samples: [{ missionTitle: item.missionTitle, detail: item.detail, createdAt: iso }],
      rsiStatus: "observing", wikiPatternId: null,
    });
    return;
  }
  existing.count += 1;
  if (isRecent) existing.recentCount30d += 1;
  if (iso > existing.latestAt) {
    existing.latestAt = iso;
    if (item.axis === "worker" && item.detail && item.detail !== item.code) existing.summary = item.detail;
  }
  if (existing.samples.length < 3) existing.samples.push({ missionTitle: item.missionTitle, detail: item.detail, createdAt: iso });
}

export function clusterPlanQaDiagnostics(
  verdicts: Array<{ missionTitle: string; verdict: string; diagnostics: Array<Record<string, unknown>>; createdAt: Date }>,
  nowMs = Date.now(),
): QualityRsiCluster[] {
  const map = new Map<string, QualityRsiCluster>();
  for (const v of verdicts) {
    if (v.verdict !== "request_changes") continue;
    const diags = Array.isArray(v.diagnostics) && v.diagnostics.length > 0 ? v.diagnostics : [{}];
    const seen = new Set<string>();
    for (const d of diags) {
      const code = extractDiagnosticCode(d);
      if (seen.has(code)) continue;
      seen.add(code);
      const detail = extractDiagnosticSummary(d);
      upsertCluster(map, {
        axis: "worker", code, title: `Plan QA recurring failure: ${code}`,
        summary: detail || `Recurring Plan QA rejection (${code}). Verify contract & prerequisites before submitting plan.`,
        missionTitle: v.missionTitle, detail: detail || code, createdAt: v.createdAt,
      }, nowMs);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count || b.latestAt.localeCompare(a.latestAt));
}

export function clusterEscapedDefects(
  escapedRows: Array<{ source: string; missionTitle: string; detail: string; createdAt: Date }>,
  nowMs = Date.now(),
): QualityRsiCluster[] {
  const map = new Map<string, QualityRsiCluster>();
  for (const row of escapedRows) {
    const code = `qa_escaped_${row.source.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`;
    upsertCluster(map, {
      axis: "qa_self", code, title: `Plan QA blind spot (${row.source})`,
      summary: `Missions passed Plan QA but later hit ${row.source}. Tighten Plan QA pre-flight checklist for this failure class.`,
      missionTitle: row.missionTitle, detail: row.detail || row.source, createdAt: row.createdAt,
    }, nowMs);
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count || b.latestAt.localeCompare(a.latestAt));
}

export async function getQualityRsiOverview(db: Db, companyId: string): Promise<QualityRsiOverview> {
  const nowMs = Date.now();
  const [verdictRows, reviewRows, patternRows] = await Promise.all([
    db.select({
      id: missionPlanQaVerdicts.id, missionId: missionPlanQaVerdicts.missionId, missionTitle: missions.title,
      missionStatus: missions.status, verdict: missionPlanQaVerdicts.verdict,
      diagnostics: missionPlanQaVerdicts.diagnostics, createdAt: missionPlanQaVerdicts.createdAt,
    }).from(missionPlanQaVerdicts).leftJoin(missions, eq(missions.id, missionPlanQaVerdicts.missionId))
      .where(eq(missionPlanQaVerdicts.companyId, companyId)).orderBy(desc(missionPlanQaVerdicts.createdAt)).limit(400),
    db.select({
      id: qualityReviewItems.id, missionId: qualityReviewItems.missionId, missionTitle: missions.title,
      missionStatus: missions.status, title: qualityReviewItems.title, status: qualityReviewItems.status,
      triggerSource: qualityReviewItems.triggerSource, failureType: qualityReviewItems.failureType,
      createdAt: qualityReviewItems.createdAt,
    }).from(qualityReviewItems).leftJoin(missions, eq(missions.id, qualityReviewItems.missionId))
      .where(eq(qualityReviewItems.companyId, companyId)).orderBy(desc(qualityReviewItems.createdAt)).limit(300),
    db.select({
      id: companyKnowledgePatterns.id, kind: companyKnowledgePatterns.kind, status: companyKnowledgePatterns.status,
      defectSignature: companyKnowledgePatterns.defectSignature, supersededById: companyKnowledgePatterns.supersededById,
    }).from(companyKnowledgePatterns)
      .where(and(eq(companyKnowledgePatterns.companyId, companyId), isNotNull(companyKnowledgePatterns.defectSignature))),
  ]);

  let pass30d = 0, requestChanges30d = 0, passAllTime = 0, requestChangesAllTime = 0;
  const passedMissions = new Map<string, { title: string; status: string | null; latestPassAt: Date }>();
  for (const v of verdictRows) {
    const recent = nowMs - v.createdAt.getTime() <= THIRTY_DAYS_MS;
    if (v.verdict === "pass") {
      passAllTime += 1;
      if (recent) pass30d += 1;
      if (!passedMissions.has(v.missionId)) passedMissions.set(v.missionId, { title: v.missionTitle ?? v.missionId.slice(0, 8), status: v.missionStatus ?? null, latestPassAt: v.createdAt });
    } else if (v.verdict === "request_changes") {
      requestChangesAllTime += 1;
      if (recent) requestChanges30d += 1;
    }
  }

  const escapedRows: Array<{ source: string; missionTitle: string; detail: string; createdAt: Date }> = [];
  const escapedMissionIds = new Set<string>();
  for (const [mId, info] of passedMissions) {
    if (info.status === "cancelled") {
      escapedMissionIds.add(mId);
      escapedRows.push({ source: "post_pass_cancelled", missionTitle: info.title, detail: "Cancelled after Plan QA pass", createdAt: info.latestPassAt });
    }
  }
  for (const r of reviewRows) {
    if (!r.missionId || !passedMissions.has(r.missionId) || !(ESCAPED_TRIGGER_SOURCES as readonly string[]).includes(r.triggerSource)) continue;
    escapedMissionIds.add(r.missionId);
    escapedRows.push({ source: r.triggerSource, missionTitle: r.missionTitle ?? r.title, detail: r.failureType ?? r.title, createdAt: r.createdAt });
  }

  const activeBySig = new Map<string, { id: string; kind: string }>();
  for (const p of patternRows) {
    if (p.status === "active" && !p.supersededById && p.defectSignature) activeBySig.set(p.defectSignature, { id: p.id, kind: p.kind });
  }
  const workerClusters = clusterPlanQaDiagnostics(
    verdictRows.map((v) => ({ missionTitle: v.missionTitle ?? v.missionId.slice(0, 8), verdict: v.verdict, diagnostics: Array.isArray(v.diagnostics) ? v.diagnostics : [], createdAt: v.createdAt })),
    nowMs,
  );
  const clusters = [...clusterEscapedDefects(escapedRows, nowMs), ...workerClusters].map((c) => {
    const canon = activeBySig.get(c.canonSignature);
    if (canon) return { ...c, rsiStatus: "canon" as const, wikiPatternId: canon.id };
    const auto = activeBySig.get(c.signature);
    return auto ? { ...c, rsiStatus: auto.kind === "constraint" ? ("canon" as const) : ("auto_injected" as const), wikiPatternId: auto.id } : c;
  });

  const closedSet = new Set<string>(QUALITY_RSI_CLOSED_STATUSES);
  let staleReviewItemsCount = 0;
  const openReviewItems: QualityRsiOverview["openReviewItems"] = [];
  for (const r of reviewRows) {
    if (closedSet.has(r.status)) continue;
    if (r.missionStatus === "completed" || r.missionStatus === "cancelled") { staleReviewItemsCount += 1; continue; }
    openReviewItems.push({ id: r.id, missionId: r.missionId, missionTitle: r.missionTitle ?? null, title: r.title, status: r.status, triggerSource: r.triggerSource, failureType: r.failureType ?? null, createdAt: r.createdAt.toISOString() });
  }

  const total30d = pass30d + requestChanges30d, totalAll = passAllTime + requestChangesAllTime;
  return {
    stats: {
      pass30d, requestChanges30d, passRate30d: total30d > 0 ? Math.round((pass30d / total30d) * 100) : null,
      passAllTime, requestChangesAllTime, passRateAllTime: totalAll > 0 ? Math.round((passAllTime / totalAll) * 100) : null,
      passedMissionsTotal: passedMissions.size, escapedMissionsCount: escapedMissionIds.size,
      escapedDefectRate: passedMissions.size > 0 ? Math.round((escapedMissionIds.size / passedMissions.size) * 100) : null,
      autoInjectedCount: clusters.filter((c) => c.rsiStatus === "auto_injected").length,
      canonCount: clusters.filter((c) => c.rsiStatus === "canon").length,
      openReviewItemsCount: openReviewItems.length, staleReviewItemsCount,
    },
    clusters,
    recentVerdicts: verdictRows.slice(0, 20).map((v) => {
      const diags = Array.isArray(v.diagnostics) ? v.diagnostics : [];
      return { id: v.id, missionId: v.missionId, missionTitle: v.missionTitle ?? v.missionId.slice(0, 8), verdict: v.verdict, diagnosticCount: diags.length, topDetail: diags.length > 0 ? extractDiagnosticSummary(diags[0]) || extractDiagnosticCode(diags[0]) : null, createdAt: v.createdAt.toISOString() };
    }),
    openReviewItems,
  };
}

export async function syncQualityRsi(db: Db, companyId: string): Promise<QualityRsiSyncResult> {
  const stale = await db.select({ id: qualityReviewItems.id }).from(qualityReviewItems)
    .innerJoin(missions, eq(missions.id, qualityReviewItems.missionId))
    .where(and(eq(qualityReviewItems.companyId, companyId), isNotNull(qualityReviewItems.missionId), notInArray(qualityReviewItems.status, [...QUALITY_RSI_CLOSED_STATUSES]), inArray(missions.status, ["completed", "cancelled"])));
  let closedStaleItems = 0;
  if (stale.length > 0) {
    const updated = await db.update(qualityReviewItems).set({ status: "closed", updatedAt: new Date() })
      .where(and(eq(qualityReviewItems.companyId, companyId), inArray(qualityReviewItems.id, stale.map((r) => r.id)))).returning({ id: qualityReviewItems.id });
    closedStaleItems = updated.length;
  }

  const overview = await getQualityRsiOverview(db, companyId);
  const existingRows = await db.select({ defectSignature: companyKnowledgePatterns.defectSignature })
    .from(companyKnowledgePatterns).where(and(eq(companyKnowledgePatterns.companyId, companyId), isNotNull(companyKnowledgePatterns.defectSignature)));
  const existingSigs = new Set(existingRows.map((r) => r.defectSignature).filter(Boolean) as string[]);

  let createdPatterns = 0, skippedExisting = 0;
  for (const c of overview.clusters) {
    if (!shouldAutoGraduateToWiki(c.count)) continue;
    if (existingSigs.has(c.signature) || existingSigs.has(c.canonSignature)) { skippedExisting += 1; continue; }
    const [inserted] = await db.insert(companyKnowledgePatterns).values({
      companyId, kind: "failure_mode", title: c.title, summary: `${c.summary} (observed ${c.count}x)`,
      symptoms: c.samples.map((s) => `${s.missionTitle}: ${s.detail}`).join(" | ").slice(0, 500),
      rootCause: c.axis === "qa_self" ? "Plan QA passed without catching downstream failure risk." : `Recurring Plan QA diagnostic: ${c.code}`,
      whatWorked: c.axis === "qa_self" ? "Explicitly verify this failure class during Plan QA before issuing PASS." : `Verify ${c.code} contract requirements before submitting plan.`,
      scopeTags: c.axis === "qa_self" ? ["quality-rsi", "plan-qa", "qa-escaped", c.code] : ["quality-rsi", "plan-qa", c.code],
      errorSignatures: [c.signature], defectSignature: c.signature, source: "mission_owner_compile", status: "active", audience: "agent",
    }).onConflictDoNothing().returning({ id: companyKnowledgePatterns.id });
    if (inserted) { createdPatterns += 1; existingSigs.add(c.signature); } else { skippedExisting += 1; }
  }
  return { closedStaleItems, createdPatterns, skippedExisting, canonCount: overview.stats.canonCount };
}

export async function promoteQualityPatternToCanon(
  db: Db, companyId: string, signature: string,
): Promise<{ patternId: string; alreadyCanon: boolean }> {
  const trimmed = signature.trim(), canonSig = canonSignatureFor(trimmed);
  const res = await db.transaction(async (tx) => {
    const [existingCanon] = await tx.select({ id: companyKnowledgePatterns.id }).from(companyKnowledgePatterns)
      .where(and(eq(companyKnowledgePatterns.companyId, companyId), eq(companyKnowledgePatterns.defectSignature, canonSig), eq(companyKnowledgePatterns.status, "active"), isNull(companyKnowledgePatterns.supersededById))).limit(1);
    if (existingCanon) return { patternId: existingCanon.id, alreadyCanon: true, syncPayload: null };

    const [prev] = await tx.select().from(companyKnowledgePatterns)
      .where(and(eq(companyKnowledgePatterns.companyId, companyId), eq(companyKnowledgePatterns.defectSignature, trimmed))).limit(1);
    const code = trimmed.replace(/^quality-rsi:/, "");
    const title = prev?.title ?? `Canonical QA rule: ${code}`;
    const summary = prev?.summary ?? `Durable QA standard rule promoted from ${code}.`;
    const whatWorked = prev?.whatWorked ?? "Enforce this check before passing or submitting plans.";
    const tags = prev?.scopeTags?.length ? prev.scopeTags : ["quality-rsi", "plan-qa", ...(code.startsWith("qa_escaped_") ? ["qa-escaped"] : []), code];
    const [created] = await tx.insert(companyKnowledgePatterns).values({
      companyId, kind: "constraint", title, summary, symptoms: prev?.symptoms ?? null,
      rootCause: prev?.rootCause ?? `Promoted from Quality RSI (${code})`, whatWorked, scopeTags: tags,
      errorSignatures: [trimmed], defectSignature: canonSig, source: "operator", status: "active", audience: "agent", versionNumber: prev ? prev.versionNumber + 1 : 1,
    }).onConflictDoNothing().returning({ id: companyKnowledgePatterns.id });

    if (!created) {
      const [raced] = await tx.select({ id: companyKnowledgePatterns.id }).from(companyKnowledgePatterns)
        .where(and(eq(companyKnowledgePatterns.companyId, companyId), eq(companyKnowledgePatterns.defectSignature, canonSig), isNull(companyKnowledgePatterns.supersededById))).limit(1);
      if (!raced) throw new Error("quality_rsi_canon_conflict");
      return { patternId: raced.id, alreadyCanon: true, syncPayload: null };
    }
    if (prev && !prev.supersededById) {
      await tx.update(companyKnowledgePatterns).set({ supersededById: created.id, supersedeReason: "Promoted to canonical constraint via Quality RSI" }).where(eq(companyKnowledgePatterns.id, prev.id));
    }
    return { patternId: created.id, alreadyCanon: false, syncPayload: { companyId, patternId: created.id, code, title, summary, whatWorked, tags } };
  });
  if (!res.alreadyCanon && res.syncPayload) void syncPromotedCanonToKb(db, res.syncPayload);
  return { patternId: res.patternId, alreadyCanon: res.alreadyCanon };
}
