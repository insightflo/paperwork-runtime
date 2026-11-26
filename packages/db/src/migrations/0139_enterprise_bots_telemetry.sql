-- 0139: Additive telemetry and bounded health_history columns for enterprise bots and client terminals.
ALTER TABLE "client_terminals" ADD COLUMN IF NOT EXISTS "telemetry" jsonb;
--> statement-breakpoint
ALTER TABLE "client_terminals" ADD COLUMN IF NOT EXISTS "health_history" jsonb;
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "health_history" jsonb;
