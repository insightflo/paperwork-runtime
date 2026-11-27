-- 0140: Threaded collaboration channels (Stage 29) — channels, threads, messages. Idempotent for fresh and live DBs.
CREATE TABLE IF NOT EXISTS "collab_channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "member_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "lead_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "archived_at" timestamp with time zone,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collab_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "channel_id" uuid NOT NULL REFERENCES "collab_channels"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "owner_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "root_issue_id" uuid,
  "assignment_count" integer DEFAULT 0 NOT NULL,
  "reply_count" integer DEFAULT 0 NOT NULL,
  "created_by_actor_type" text DEFAULT 'user' NOT NULL,
  "created_by_actor_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "collab_threads_status_check" CHECK ("status" in ('open', 'waiting', 'paused', 'resolved')),
  CONSTRAINT "collab_threads_created_by_actor_type_check" CHECK ("created_by_actor_type" in ('user', 'agent'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collab_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "channel_id" uuid NOT NULL REFERENCES "collab_channels"("id") ON DELETE CASCADE,
  "thread_id" uuid NOT NULL REFERENCES "collab_threads"("id") ON DELETE CASCADE,
  "parent_message_id" uuid,
  "author_type" text NOT NULL,
  "author_id" text,
  "action_kind" text DEFAULT 'message' NOT NULL,
  "target_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "body" text NOT NULL,
  "expects_reply" boolean DEFAULT false NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "collab_messages_author_type_check" CHECK ("author_type" in ('user', 'agent', 'system')),
  CONSTRAINT "collab_messages_action_kind_check" CHECK ("action_kind" in ('message', 'channel_assign', 'channel_transfer', 'channel_reply', 'channel_result', 'user_steer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collab_channels_company_slug_unique_idx" ON "collab_channels" ("company_id", "slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collab_threads_company_channel_updated_idx" ON "collab_threads" ("company_id", "channel_id", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collab_messages_company_thread_created_idx" ON "collab_messages" ("company_id", "thread_id", "created_at");
