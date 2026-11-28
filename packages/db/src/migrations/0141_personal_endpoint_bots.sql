-- Stage 35: durable endpoint pairing, presence, and at-least-once local tasks.
CREATE TABLE IF NOT EXISTS "personal_endpoint_pairing_codes" (
  "code" text PRIMARY KEY NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "bot_name" text NOT NULL,
  "requested_folders_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "personal_endpoint_bots" (
  "device_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "bot_name" text NOT NULL,
  "token_hash" text NOT NULL,
  "token_preview" text NOT NULL,
  "os" text NOT NULL,
  "arch" text NOT NULL,
  "detected_clis_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "allowed_folders_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "pending_outbox_count" integer DEFAULT 0 NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "personal_endpoint_bots_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "personal_endpoint_bots_outbox_check" CHECK ("pending_outbox_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "personal_endpoint_bots_company_device_idx" ON "personal_endpoint_bots" ("company_id", "device_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "personal_endpoint_tasks" (
  "task_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "device_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "target_path" text NOT NULL,
  "command" text,
  "args_json" jsonb,
  "status" text DEFAULT 'pending' NOT NULL,
  "ok" boolean,
  "output" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "acked_at" timestamp with time zone,
  CONSTRAINT "personal_endpoint_tasks_device_fk" FOREIGN KEY ("company_id", "device_id") REFERENCES "personal_endpoint_bots" ("company_id", "device_id") ON DELETE CASCADE,
  CONSTRAINT "personal_endpoint_tasks_kind_check" CHECK ("kind" IN ('read_file', 'write_file', 'list_dir', 'shell_exec')),
  CONSTRAINT "personal_endpoint_tasks_status_check" CHECK ("status" IN ('pending', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "personal_endpoint_pairing_company_expiry_idx" ON "personal_endpoint_pairing_codes" ("company_id", "expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "personal_endpoint_tasks_pending_idx" ON "personal_endpoint_tasks" ("company_id", "device_id", "status", "created_at", "task_id");
