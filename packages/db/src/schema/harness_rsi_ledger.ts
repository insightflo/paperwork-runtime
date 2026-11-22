// packages/db/src/schema/harness_rsi_ledger.ts
//
// [harness-rsi ledger] RRSI + Harness² 자기개선 라운드의 제안→결정→평가 내구 장부.
//   variant/component 별 개선 가설(hypothesis)과 diff 참조(diff_ref)를 승인·기각·보류
//   결정(decision/decided_by)과 함께 기록하고, 후속 평가가 수용 여부(accepted/verdict)와
//   점수·비용 델타(delta_score/delta_cost)를 채운다.
// [불변식] 결정 필드는 기록 시 확정되며, 평가 필드(accepted/verdict/delta_*·evaluated_at)만
//   이후 갱신 대상이다. 결정 자체의 재기록이 아니라 라운드·변형별 행 적재가 기본이다.
// [외부 연결] FK: companies(cascade) — 회사 삭제 시 장부 행도 함께 삭제된다.
//   writer/reader: server/src/services/harness-rsi/* (제안 루프·평가 경로).
// [수정시 주의] 스키마 변경 시 수기 마이그레이션 규약 준수(journal drift — 0096 참조).
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const harnessRsiLedger = pgTable(
  "harness_rsi_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    round: integer("round").notNull().default(0),
    variant: text("variant").notNull(),
    component: text("component").notNull(),
    hypothesis: text("hypothesis").notNull().default(""),
    diffRef: text("diff_ref").notNull().default(""),
    decision: text("decision").notNull(), // approved | rejected | deferred
    decidedBy: text("decided_by").notNull(),
    overrideReason: text("override_reason"),
    baselineJson: jsonb("baseline_json").$type<Record<string, unknown>>(),
    deltaScore: doublePrecision("delta_score"),
    deltaCost: doublePrecision("delta_cost"),
    accepted: boolean("accepted"),
    verdict: text("verdict"), // winner | rejected | null
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
  },
  (table) => [
    index("harness_rsi_ledger_company_created_idx").on(table.companyId, table.createdAt),
  ],
);
