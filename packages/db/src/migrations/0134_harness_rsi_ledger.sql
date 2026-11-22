-- [RRSI + Harness² Stage 4A-db 2026-11-22] harness_rsi_ledger — 자기개선 라운드의
--   제안·결정·평가 내구 장부(순수 추가 — 기존 테이블 변경 없음).
--   결정 필드(decision/decided_by)는 기록 시 확정, 평가 필드(accepted/verdict/delta_*)는
--   후속 평가가 채운다. 회사 삭제 시 cascade.
CREATE TABLE IF NOT EXISTS "harness_rsi_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
	"round" integer DEFAULT 0 NOT NULL,
	"variant" text NOT NULL,
	"component" text NOT NULL,
	"hypothesis" text DEFAULT '' NOT NULL,
	"diff_ref" text DEFAULT '' NOT NULL,
	"decision" text NOT NULL,
	"decided_by" text NOT NULL,
	"override_reason" text,
	"baseline_json" jsonb,
	"delta_score" double precision,
	"delta_cost" double precision,
	"accepted" boolean,
	"verdict" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evaluated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "harness_rsi_ledger_company_created_idx" ON "harness_rsi_ledger" ("company_id", "created_at" DESC);