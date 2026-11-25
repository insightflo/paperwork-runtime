import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { botCapabilities, bots, channelMembers, channels, clientTerminals, teams } from "./enterprise_bots.js";
import {
  botCapabilities as exportedBotCapabilities,
  bots as exportedBots,
  channelMembers as exportedChannelMembers,
  channels as exportedChannels,
  clientTerminals as exportedClientTerminals,
  teams as exportedTeams,
} from "./index.js";

type SchemaTable = Parameters<typeof getTableConfig>[0];

type TableCase = {
  label: string;
  table: SchemaTable;
  columns: string[];
  required: string[];
  nullable: string[];
  columnTypes?: Record<string, string>;
  defaults?: Record<string, unknown>;
  uniqueIndexes?: Array<[string, string[]]>;
  lookupIndexes?: Array<[string, string[]]>;
  checks?: Record<string, string[]>;
};

function columnNames(table: SchemaTable): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function columnByName(table: SchemaTable, name: string) {
  const column = getTableConfig(table).columns.find((candidate) => candidate.name === name);
  expect(column, `missing column ${name}`).toBeDefined();
  return column!;
}

function indexByName(table: SchemaTable, name: string) {
  const tableIndex = getTableConfig(table).indexes.find((candidate) => candidate.config.name === name);
  expect(tableIndex, `missing index ${name}`).toBeDefined();
  return tableIndex!;
}

function indexColumnNames(tableIndex: ReturnType<typeof indexByName>): string[] {
  return tableIndex.config.columns.map((column) => {
    if (typeof column === "object" && column !== null && "name" in column) {
      return String((column as { name: unknown }).name);
    }
    return String(column);
  });
}

function expectIndex(table: SchemaTable, name: string, columns: string[], unique: boolean) {
  const tableIndex = indexByName(table, name);
  expect(tableIndex.config.unique).toBe(unique);
  expect(indexColumnNames(tableIndex)).toEqual(columns);
}

function renderedCheck(table: SchemaTable, name: string): string {
  const tableCheck = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  expect(tableCheck, `missing check ${name}`).toBeDefined();
  return new PgDialect().sqlToQuery(tableCheck!.value).sql.toLowerCase();
}

const timestampColumns = ["created_at", "updated_at"];
const tableCases: TableCase[] = [
  {
    label: "teams", table: teams,
    columns: ["id", "company_id", "name", "slug", ...timestampColumns],
    required: ["id", "company_id", "name", "slug", ...timestampColumns],
    nullable: [],
    columnTypes: { id: "PgUUID", company_id: "PgUUID" },
    uniqueIndexes: [["teams_company_slug_unique_idx", ["company_id", "slug"]]],
  },
  {
    label: "bots", table: bots,
    columns: ["id", "company_id", "kind", "name", "owner_user_id", "team_id", "agent_id", "callable_by", "status", ...timestampColumns],
    required: ["id", "company_id", "kind", "name", "callable_by", "status", ...timestampColumns],
    nullable: ["owner_user_id", "team_id", "agent_id"],
    columnTypes: { team_id: "PgUUID", agent_id: "PgUUID" },
    defaults: { callable_by: "team", status: "active" },
    lookupIndexes: [
      ["bots_company_status_idx", ["company_id", "status"]],
      ["bots_team_idx", ["team_id"]],
      ["bots_owner_user_idx", ["owner_user_id"]],
    ],
    checks: {
      bots_kind_check: ["personal", "team"],
      bots_callable_by_check: ["self_only", "team", "company"],
    },
  },
  {
    label: "bot_capabilities", table: botCapabilities,
    columns: ["id", "bot_id", "capability_key", "callable_by", "data_scope", "requires_approval", ...timestampColumns],
    required: ["id", "bot_id", "capability_key", "callable_by", "data_scope", "requires_approval", ...timestampColumns],
    nullable: [],
    columnTypes: { bot_id: "PgUUID", requires_approval: "PgBoolean" },
    defaults: { data_scope: "self", requires_approval: false },
    uniqueIndexes: [["bot_capabilities_bot_capability_unique_idx", ["bot_id", "capability_key"]]],
    checks: {
      bot_capabilities_callable_by_check: ["self_only", "team", "company"],
      bot_capabilities_data_scope_check: ["self", "team", "company"],
    },
  },
  {
    label: "client_terminals", table: clientTerminals,
    columns: [
      "id", "company_id", "kind", "name", "owner_user_id", "team_id", "bot_id", "token_hash",
      "transport", "status", "last_heartbeat_at", "revoked_at", ...timestampColumns,
    ],
    required: ["id", "company_id", "kind", "name", "token_hash", "transport", "status", ...timestampColumns],
    nullable: ["owner_user_id", "team_id", "bot_id", "last_heartbeat_at", "revoked_at"],
    defaults: { transport: "outbound_wss", status: "offline" },
    lookupIndexes: [
      ["client_terminals_company_status_idx", ["company_id", "status"]],
      ["client_terminals_token_hash_idx", ["token_hash"]],
      ["client_terminals_bot_idx", ["bot_id"]],
    ],
    checks: {
      client_terminals_kind_check: ["personal_terminal", "worker_node"],
      client_terminals_transport_check: ["outbound_wss", "tailscale_direct"],
    },
  },
  {
    label: "channels", table: channels,
    columns: ["id", "company_id", "kind", "name", "team_id", "created_by_user_id", ...timestampColumns],
    required: ["id", "company_id", "kind", "name", "created_by_user_id", ...timestampColumns],
    nullable: ["team_id"],
    lookupIndexes: [
      ["channels_company_kind_idx", ["company_id", "kind"]],
      ["channels_team_idx", ["team_id"]],
    ],
    checks: { channels_kind_check: ["team", "shared", "dm"] },
  },
  {
    label: "channel_members", table: channelMembers,
    columns: ["id", "channel_id", "principal_kind", "principal_id", "role", "invited_by_user_id", "created_at"],
    required: ["id", "channel_id", "principal_kind", "principal_id", "role", "created_at"],
    nullable: ["invited_by_user_id"],
    defaults: { role: "member" },
    uniqueIndexes: [["channel_members_channel_principal_unique_idx", ["channel_id", "principal_kind", "principal_id"]]],
    lookupIndexes: [["channel_members_principal_idx", ["principal_kind", "principal_id"]]],
    checks: {
      channel_members_principal_kind_check: ["human", "personal_bot", "team_bot"],
      channel_members_role_check: ["owner", "member"],
    },
  },
];

for (const testCase of tableCases) {
  describe(`${testCase.label} schema`, () => {
    it("defines the required columns, nullability, defaults, indexes, and checks", () => {
      expect(getTableConfig(testCase.table).name).toBe(testCase.label);
      expect(columnNames(testCase.table)).toEqual(expect.arrayContaining(testCase.columns));
      for (const name of testCase.required) expect(columnByName(testCase.table, name).notNull, `${name} required`).toBe(true);
      for (const name of testCase.nullable) expect(columnByName(testCase.table, name).notNull, `${name} nullable`).toBe(false);
      for (const [name, type] of Object.entries(testCase.columnTypes ?? {})) {
        expect(columnByName(testCase.table, name).columnType).toBe(type);
      }
      for (const [name, value] of Object.entries(testCase.defaults ?? {})) {
        expect(columnByName(testCase.table, name).default).toBe(value);
      }
      for (const [name, columns] of testCase.uniqueIndexes ?? []) expectIndex(testCase.table, name, columns, true);
      for (const [name, columns] of testCase.lookupIndexes ?? []) expectIndex(testCase.table, name, columns, false);
      for (const [name, values] of Object.entries(testCase.checks ?? {})) {
        const rendered = renderedCheck(testCase.table, name);
        for (const value of values) expect(rendered).toContain(value);
      }
    });
  });
}

describe("enterprise bot schema-specific invariants", () => {
  it("gives every table a default-random uuid primary key", () => {
    for (const { table } of tableCases) {
      const id = columnByName(table, "id");
      expect(id.primary).toBe(true);
      expect(id.columnType).toBe("PgUUID");
      expect(id.hasDefault).toBe(true);
    }
  });

  it("requires personal bot owners and team bot teams at the database shape level", () => {
    const ownershipCheck = renderedCheck(bots, "bots_owner_or_team_required_check");
    expect(ownershipCheck).toContain("owner_user_id");
    expect(ownershipCheck).toContain("team_id");
    expect(ownershipCheck).toContain("personal");
    expect(ownershipCheck).toContain("team");
  });

  it("stores only a SHA-256 hex token hash, never a plaintext token column", () => {
    expect(columnNames(clientTerminals)).toContain("token_hash");
    expect(columnNames(clientTerminals)).not.toContain("token");
    const hashCheck = renderedCheck(clientTerminals, "client_terminals_token_hash_hex_check");
    expect(hashCheck).toContain("token_hash");
    expect(hashCheck).toContain("0-9a-f");
    expect(hashCheck).toContain("64");
  });
});

describe("enterprise bot schema barrel exports", () => {
  it("re-exports all six additive tables", () => {
    expect(exportedTeams).toBe(teams);
    expect(exportedBots).toBe(bots);
    expect(exportedBotCapabilities).toBe(botCapabilities);
    expect(exportedClientTerminals).toBe(clientTerminals);
    expect(exportedChannels).toBe(channels);
    expect(exportedChannelMembers).toBe(channelMembers);
  });
});
