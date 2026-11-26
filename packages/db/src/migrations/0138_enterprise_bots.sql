-- 0138: Enterprise bots & OpenBot external attachment tables (idempotent for fresh and live DBs).
CREATE TABLE IF NOT EXISTS "teams" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teams_company_slug_unique_idx" ON "teams" ("company_id", "slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "owner_user_id" text,
  "team_id" uuid REFERENCES "teams"("id"),
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "callable_by" text DEFAULT 'team' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "webhook_url" text,
  "token_secret_id" uuid REFERENCES "company_secrets"("id") ON DELETE SET NULL,
  "inbound_token_hash" text,
  "last_ping_at" timestamp with time zone,
  "last_ping_status" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bots_kind_check" CHECK ("kind" in ('personal', 'team', 'company')),
  CONSTRAINT "bots_callable_by_check" CHECK ("callable_by" in ('self_only', 'team', 'company')),
  CONSTRAINT "bots_owner_or_team_required_check" CHECK (("kind" = 'personal' and "owner_user_id" is not null) or ("kind" = 'team' and "team_id" is not null) or ("kind" = 'company')),
  CONSTRAINT "bots_last_ping_status_check" CHECK ("last_ping_status" is null or "last_ping_status" in ('ok', 'error'))
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "webhook_url" text;
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "token_secret_id" uuid REFERENCES "company_secrets"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "inbound_token_hash" text;
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "last_ping_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "last_ping_status" text;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "bots" DROP CONSTRAINT IF EXISTS "bots_kind_check";
  ALTER TABLE "bots" ADD CONSTRAINT "bots_kind_check" CHECK ("kind" in ('personal', 'team', 'company'));
  ALTER TABLE "bots" DROP CONSTRAINT IF EXISTS "bots_owner_or_team_required_check";
  ALTER TABLE "bots" ADD CONSTRAINT "bots_owner_or_team_required_check" CHECK (("kind" = 'personal' and "owner_user_id" is not null) or ("kind" = 'team' and "team_id" is not null) or ("kind" = 'company'));
  ALTER TABLE "bots" DROP CONSTRAINT IF EXISTS "bots_last_ping_status_check";
  ALTER TABLE "bots" ADD CONSTRAINT "bots_last_ping_status_check" CHECK ("last_ping_status" is null or "last_ping_status" in ('ok', 'error'));
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bots_company_status_idx" ON "bots" ("company_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bots_team_idx" ON "bots" ("team_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bots_owner_user_idx" ON "bots" ("owner_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_capabilities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bot_id" uuid NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "capability_key" text NOT NULL,
  "callable_by" text NOT NULL,
  "data_scope" text DEFAULT 'self' NOT NULL,
  "requires_approval" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bot_capabilities_callable_by_check" CHECK ("callable_by" in ('self_only', 'team', 'company')),
  CONSTRAINT "bot_capabilities_data_scope_check" CHECK ("data_scope" in ('self', 'team', 'company'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bot_capabilities_bot_capability_unique_idx" ON "bot_capabilities" ("bot_id", "capability_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_terminals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "owner_user_id" text,
  "team_id" uuid REFERENCES "teams"("id") ON DELETE SET NULL,
  "bot_id" uuid REFERENCES "bots"("id") ON DELETE SET NULL,
  "token_hash" text NOT NULL,
  "transport" text DEFAULT 'outbound_wss' NOT NULL,
  "status" text DEFAULT 'offline' NOT NULL,
  "last_heartbeat_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "client_terminals_kind_check" CHECK ("kind" in ('personal_terminal', 'worker_node')),
  CONSTRAINT "client_terminals_transport_check" CHECK ("transport" in ('outbound_wss', 'tailscale_direct')),
  CONSTRAINT "client_terminals_token_hash_hex_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_terminals_company_status_idx" ON "client_terminals" ("company_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_terminals_token_hash_idx" ON "client_terminals" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_terminals_bot_idx" ON "client_terminals" ("bot_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "team_id" uuid REFERENCES "teams"("id") ON DELETE SET NULL,
  "created_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "channels_kind_check" CHECK ("kind" in ('team', 'shared', 'dm'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_company_kind_idx" ON "channels" ("company_id", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_team_idx" ON "channels" ("team_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "principal_kind" text NOT NULL,
  "principal_id" text NOT NULL,
  "role" text DEFAULT 'member' NOT NULL,
  "invited_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "channel_members_principal_kind_check" CHECK ("principal_kind" in ('human', 'personal_bot', 'team_bot')),
  CONSTRAINT "channel_members_role_check" CHECK ("role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_members_channel_principal_unique_idx" ON "channel_members" ("channel_id", "principal_kind", "principal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_members_principal_idx" ON "channel_members" ("principal_kind", "principal_id");
