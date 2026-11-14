-- [mistology 흡수 T2a 2026-11-15] company_knowledge_patterns supersede 계보·은퇴 라이프사이클.
--   pitfalls: 폐기된 오답에서 얻은 "하지 말 것" 격리 — 주입 브리핑에 '피할 오답'으로만
--   표시되며 랭킹 점수에는 기여하지 않는다(검색 제외가 목적이 아니라 주의 표시가 목적).
--   version_number: supersede 체인 깊이(대체 발행마다 기존+1). supersede_reason: 왜
--   대체/은퇴됐는지 한 줄(supersedeWithLineage·retire가 기록).
--   기존 행은 기본값으로 둔다(데이터 백필 없음 — 신규 컬럼 default로 충분).
--   'retired' 상태값은 앱 계층 전이이므로 이 마이그레이션에서 DDL 변경이 없다.
ALTER TABLE "company_knowledge_patterns" ADD COLUMN IF NOT EXISTS "pitfalls" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "company_knowledge_patterns" ADD COLUMN IF NOT EXISTS "version_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_knowledge_patterns" ADD COLUMN IF NOT EXISTS "supersede_reason" text;
