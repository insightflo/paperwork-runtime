# Database

papercompany uses PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/). There are three ways to run the database, from simplest to most production-ready.

Compatibility note: local paths, CLI package names, and environment variables still use Paperclip-era names such as `~/.paperclip`, `paperclipai`, and `PAPERCLIP_*`. They are retained so existing instances and tooling continue to work while the product documentation moves to papercompany.

## 1. Embedded PostgreSQL — zero config

If you don't set `DATABASE_URL`, the server automatically starts an embedded PostgreSQL instance and manages a local data directory.

```sh
pnpm dev
```

That's it. On first start the server:

1. Creates a `~/.paperclip/instances/default/db/` directory for storage
2. Ensures the `paperclip` database exists
3. Runs migrations automatically for empty databases
4. Starts serving requests

Data persists across restarts in `~/.paperclip/instances/default/db/`. To reset local dev data, delete that directory.

If you need to apply pending migrations manually, run:

```sh
pnpm db:migrate
```

When `DATABASE_URL` is unset, this command targets the current embedded PostgreSQL instance for your active papercompany config/instance.

This mode is ideal for local development and one-command installs.

Docker note: the Docker quickstart image also uses embedded PostgreSQL by default. Persist `/paperclip` to keep DB state across container restarts (see `doc/DOCKER.md`).

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally, use the included Docker Compose setup:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Then set the connection string:

```sh
cp .env.example .env
# .env already contains:
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

Apply SQL migrations with `pnpm db:migrate` (do **not** use `drizzle-kit push` — the schema relies on PostgreSQL 15+ column-scoped `ON DELETE SET NULL (...)`, custom FTS GIN indexes, and migration preflights that `drizzle-kit push` cannot install):

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  pnpm db:migrate
```

Start the server:

```sh
pnpm dev
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted PostgreSQL provider. [Supabase](https://supabase.com/) is a good option with a free tier.

### Setup

1. Create a project at [database.new](https://database.new)
2. Go to **Project Settings > Database > Connection string**
3. Copy the URI and replace the password placeholder with your database password

### Connection string

Supabase offers two connection modes:

**Direct connection** (port 5432) — use for migrations and one-off scripts:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

**Connection pooling via Supavisor** (port 6543) — use for the application:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

### Configure

Set `DATABASE_URL` in your `.env`:

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

If using connection pooling (port 6543), the `postgres` client must disable prepared statements. Update `packages/db/src/client.ts`:

```ts
export function createDb(url: string) {
  const sql = postgres(url, { prepare: false });
  return drizzlePg(sql, { schema });
}
```

### Apply migrations

Use `pnpm db:migrate` against the direct connection (port 5432); do **not** use `drizzle-kit push` (it cannot install PostgreSQL 15+ column-scoped `ON DELETE SET NULL (...)` or custom FTS GIN indexes):

```sh
# Use the direct connection (port 5432) for schema migrations
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@...5432/postgres \
  pnpm db:migrate
```

### Free tier limits

- 500 MB database storage
- 200 concurrent connections
- Projects pause after 1 week of inactivity

See [Supabase pricing](https://supabase.com/pricing) for current details.

## Switching between modes

The database mode is controlled by `DATABASE_URL`:

| `DATABASE_URL` | Mode |
|---|---|
| Not set | Embedded PostgreSQL (`~/.paperclip/instances/default/db/`) |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

Your Drizzle schema (`packages/db/src/schema/`) stays the same regardless of mode.

## Secret storage

papercompany stores secret metadata and versions in:

- `company_secrets`
- `company_secret_versions`

For local/default installs, the active provider is `local_encrypted`:

- Secret material is encrypted at rest with a local master key.
- Default key file: `~/.paperclip/instances/default/secrets/master.key` (auto-created if missing).
- CLI config location: `~/.paperclip/instances/default/config.json` under `secrets.localEncrypted.keyFilePath`.

Optional overrides:

- `PAPERCLIP_SECRETS_MASTER_KEY` (32-byte key as base64, hex, or raw 32-char string)
- `PAPERCLIP_SECRETS_MASTER_KEY_FILE` (custom key file path)

Strict mode to block new inline sensitive env values:

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

You can set strict mode and provider defaults via:

```sh
pnpm paperclipai configure --section secrets
```

Inline secret migration command:

```sh
pnpm secrets:migrate-inline-env --apply
```
## Workflow tool progress (0102)

`tool_execution_heartbeats` stores company-scoped invocation identity, a frozen policy, stage/counter values, optional workflow attempt bindings, and first-wins terminal evidence for opt-in builtin/HTTP tool progress. The runtime uses row locks and the DB clock for expiry; state changes and `tool_progress.*` activity entries commit together. HTTP capabilities are stored only as `token_hash`, excluded from reader DTOs and diagnostic queries. Progress is not workflow completion or proof of dispatch. Migration `0102_tool_execution_heartbeats.sql` adds this table and its indexes; do not rebaseline historical migration metadata. See the [tool progress runbook](./runbooks/tool-progress.md#diagnose-without-reading-secrets) for company-filtered queries and rollback boundaries.

## Workflow step-status provenance (observability)

`workflow_transition_events` rows with `event_type='workflow_step_status_transition'`, `layer='workflow_sync'`, and `reason_code=<caller source>` are appended whenever a `workflow_step_runs.status` physically changes to a terminal value (`completed`/`failed`/`skipped`). The recorder is savepoint-isolated so an observability insert failure can never roll back the authoritative transaction. Idempotency key: `wf-step-status:<stepRunId>:<toStatus>:<statusTransitionVersion>` (the trigger-maintained `workflow_step_runs.status_transition_version` monotonic column dedupes concurrent/different-source observers to exactly one row per physical transition). The originating caller source is threaded into the first mutation/sync (e.g. `issues_service`, `plugin_host`, `heartbeat_promotion`, `workflow_retry`). See `doc/runbooks/workflow-step-status-provenance.md` for the attribution query. These rows are audit/observability only and are never execution authority.

## Heartbeat finalization v1 (lifecycle completion) — feature-flagged, shadow

`heartbeat_runs.settled_at` is the durable heartbeat lifecycle-completion signal, distinct from the result/display `status`. It is written only after a run's non-compensable quiescence/runtime-release stages are positively observed and mandatory business side-effects are done or equivalently failed. The v1 writers are gated by the experimental instance setting `enableHeartbeatFinalizationV1` (default OFF); with the flag off, legacy behavior is unchanged and `settled_at` is never written by v1 code.

New workflow wake requests capture the canonical company/run/step/generation identity independently of that flag. With finalization OFF, queued→running claim validates and copies the original wake's identity atomically; it does not create owner capabilities, settle runs, or change capacity/readiness semantics. New process-loss/transient retries and adapter fallbacks retain a verified parent's identity and original attempt ancestry. Legacy NULL identities and historical artifacts are not adopted or backfilled; stale or mismatched typed identities are refused.

Original workflow admission also writes the strict, versioned `payload.__paperclipWorkflowProducerAttempt` JSON contract on `agent_wakeup_requests`: company/agent/issue/mission/run/step/generation, retry/iteration counters, original wake ID, and immediate parent heartbeat ID. The server derives it under the step lock in the insertion transaction; callers cannot supply it. Deferred promotion and coalescing preserve the original record, never restamp the current iteration. Claim, official registration, and selection validate that original scope and bounded retry ancestry against the current attempt, retaining generic retry keys and quality acceptance/ledger checks. A typed request without valid original proof fails closed; a NULL legacy identity remains NULL. A request alone cannot register output before its heartbeat's own atomic claim. Issue checkout may project a later step start time, so that display timestamp is not attempt authority. No migration or historical proof backfill is performed.

Relevant `heartbeat_runs` columns: `execution_epoch`, `execution_token`, `executor_owner_*` (lease/ack/release), `terminal_outcome`/`terminal_decided_at`/`terminal_decision_source` (first-wins), `finalization_version` (0=legacy, 1=v1), `settled_at`, `execution_scope_kind`, `workflow_step_run_id`/`workflow_execution_generation` (typed workflow link). Generation is also persisted on `agent_wakeup_requests` and `workflow_step_runs` (`execution_generation`) so a stale queued wake cannot bind a newer generation; `workflow_delegations.source_execution_generation` scopes delegation callbacks.

New tables: `heartbeat_run_finalizations` (finalization parent: immutable outcome, finalizer lease/fence), `heartbeat_run_finalization_steps` (Q/C/O stage records, unique `(company_id, heartbeat_run_id, stage_kind, idempotency_key)`), `workflow_resync_jobs`, `agent_queue_admission_jobs` (durable post-settlement work with `pending|leased|completed|dead_letter` lifecycle, lease/fence, `SKIP LOCKED` claiming).

Stage classes: **Q** (non-compensable — exact revoked-owner quiescence, process/provider absence, run-owned `workspace_operations` non-running, `workspace_runtime_services` stopped, bound `mission_agent_runtimes` not busy; positive observation only; a dead-lettered Q stage permanently blocks settlement as `blocked_noncompensable`), **C** (compensable business side-effects; may be satisfied by an equivalent structured failure), **O** (optional; may dead-letter). Enforcement (successor dispatch and workflow finalization gated on evidence-ready AND owner-settled) lands in a later phase; until then these columns are written in shadow and unread.

## Logical Data Graph Edge Catalog (Zero-Copy Over Existing Tables)

The logical data graph (see `SPEC-implementation.md` §22.2) is a read-only relation
view derived at query time from FK columns, self-FKs, and jsonb reference columns
that already exist. It adds no tables, no physical edge storage, no views, and no
ETL. The 15 logical edge kinds below span `missions`, `issues`, `issue_work_products`,
`operator_decisions`, `heartbeat_runs`, `workflow_runs`, `workflow_step_runs`,
`knowledge_nodes` (scoped by their `knowledge_bases` parent), and `agent_wiki_entries`.

| # | Edge kind | From → To | Derived from | Covering index (existing) |
|---|---|---|---|---|
| 1 | `mission_issue` | mission → issue | `issues.mission_id` | `issues_company_mission_idx (company_id, mission_id)` |
| 2 | `issue_parent` | issue → issue | `issues.parent_id` | `issues_company_parent_idx (company_id, parent_id)` |
| 3 | `issue_work_product` | issue → work_product | `issue_work_products.issue_id` | `issue_work_products_company_issue_type_idx (company_id, issue_id, type)` |
| 4 | `issue_run` | issue → heartbeat run | `issues.checkout_run_id`, `issues.execution_run_id` | reverse direction: `heartbeat_runs_company_issue_created_idx (company_id, issue_id, created_at)` |
| 5 | `work_product_run` | work_product → heartbeat run | `issue_work_products.created_by_run_id` | `issue_work_products_created_by_run_generation_idx (created_by_run_id, source_execution_generation)` |
| 6 | `run_retry` | heartbeat run → heartbeat run | `heartbeat_runs.retry_of_run_id` | none dedicated (FK column) |
| 7 | `run_step_run` | heartbeat run → step run | `heartbeat_runs.workflow_step_run_id` (+ `workflow_execution_generation`) | `heartbeat_runs_workflow_step_generation_idx (company_id, workflow_step_run_id, workflow_execution_generation)` |
| 8 | `workflow_run_mission` | workflow run → mission | `workflow_runs.mission_id` | `idx_workflow_runs_company_id_mission_id (company_id, mission_id)` |
| 9 | `workflow_run_parent` | workflow run → workflow run | `workflow_runs.parent_run_id`, `workflow_runs.parent_step_run_id`, `workflow_runs.root_run_id` | `idx_workflow_runs_parent_run_id`, `idx_workflow_runs_parent_step_run_id`, `idx_workflow_runs_root_run_id` |
| 10 | `step_run_issue` | step run → issue | `workflow_step_runs.issue_id` | `idx_workflow_step_runs_issue_id` |
| 11 | `decision_issue` | operator decision → issue | `operator_decisions.issue_id` | `operator_decisions_issue_created_idx (issue_id, created_at) WHERE issue_id IS NOT NULL` |
| 12 | `decision_workflow_run` | operator decision → workflow run | `operator_decisions.source_context ->> 'workflowRunId'` (jsonb) | none dedicated (jsonb expression; reads are company-scoped) |
| 13 | `knowledge_source` | knowledge node → mission/issue/file/url/pr/manual | `knowledge_nodes.source_refs` (jsonb `{type, id}`) | scan scoped by `idx_knowledge_nodes_company_kb (company_id, kb_id)` |
| 14 | `knowledge_link` | knowledge node → knowledge node | `knowledge_nodes.linked_node_ids` (text[] wiki links) | none dedicated (scan scoped by `idx_knowledge_nodes_company_kb`) |
| 15 | `wiki_mission` | wiki entry → mission | `agent_wiki_entries.mission_id` | none dedicated (company-scoped reads) |

Invariants:

- **Zero copy.** Node and edge sets are derived from the columns above at query time.
  Edges must never be materialized into new storage: no physical edge table, no
  materialized view, and no vector index is introduced for the data graph.
- **Company scoping.** Every traversal branch filters on `company_id`, matching the
  company ownership of the source tables (`knowledge_nodes` carries its own
  `company_id` alongside `kb_id`). An agent API key can only reach nodes of its own
  company; cross-company nodes are unreachable through the graph.
- **Bounded traversal.** Expansion is fixed at two hops (seed → hop 1 → hop 2) with
  per-branch limits and a global node/edge cap; capped responses report `truncated`.
  Existing indexes are expected to cover traversal; reliance on them must be
  confirmed with `EXPLAIN` on representative seeds before the query surface ships.
- **Derivations are not authority.** Edge rows are query-time derivations for context
  and display. They are never written back and never replace the structured records
  (operator decisions, continuations, receipts) that drive workflow execution.
