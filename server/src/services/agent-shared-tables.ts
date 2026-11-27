// server/src/services/agent-shared-tables.ts
// [Agent Shared Tables v1] 회사 스코프 구조화 키-값 테이블(in-memory, OpenBot agent-tables 모델).
// [fail-closed] 식별자·타입·필수·미지 컬럼(upsert/where) 전부 거부; 표시/참조용이며 실행 권한 판정 근거로 읽지 않는다.

import { randomUUID } from "node:crypto";

export type SharedTableColumnType = "string" | "number" | "boolean" | "json";

export interface SharedTableColumn {
  name: string;
  type: SharedTableColumnType;
  required?: boolean;
}

export interface SharedTableDef {
  id: string;
  companyId: string;
  name: string;
  columns: SharedTableColumn[];
  createdAt: string;
  updatedAt: string;
}

export interface SharedTableRow {
  key: string;
  values: Record<string, unknown>;
  updatedByAgentId: string | null;
  updatedAt: string;
}

export interface SharedTableRowInput {
  key: string;
  values: Record<string, unknown>;
  agentId?: string | null;
}

export interface SharedTableQueryOptions {
  where?: Record<string, unknown>;
  limit?: number;
}

export interface SharedTableStore {
  createTable(companyId: string, input: { name: string; columns: SharedTableColumn[] }): SharedTableDef;
  upsertRow(companyId: string, tableName: string, input: SharedTableRowInput): SharedTableRow;
  queryRows(companyId: string, tableName: string, options?: SharedTableQueryOptions): SharedTableRow[];
  deleteRow(companyId: string, tableName: string, key: string): boolean;
  listTables(companyId: string): SharedTableDef[];
}

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const COLUMN_TYPES: readonly SharedTableColumnType[] = ["string", "number", "boolean", "json"];

function nowIso(): string {
  return new Date().toISOString();
}

function assertNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} must be an identifier matching ${IDENTIFIER_PATTERN.source}`);
  }
  return value;
}

function isJsonSafe(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

function matchesColumnType(type: SharedTableColumnType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "json":
      return isJsonSafe(value);
  }
}

/** json 컬럼 exact-match 필터용 구조 비교(키 순서 무관). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

interface StoredTable {
  def: SharedTableDef;
  rows: Map<string, SharedTableRow>;
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const copyDef = (def: SharedTableDef): SharedTableDef => ({ ...def, columns: def.columns.map((column) => ({ ...column })) });

export function createSharedTableStore(): SharedTableStore {
  const tablesByCompany = new Map<string, Map<string, StoredTable>>();

  function requireTable(companyId: string, tableName: string): StoredTable {
    const table = tablesByCompany.get(companyId)?.get(tableName);
    if (!table) throw new Error(`shared table not found: ${tableName} (company ${companyId})`);
    return table;
  }

  return {
    createTable(companyId, input) {
      assertNonEmpty(companyId, "companyId");
      const name = assertIdentifier(input.name, "table name");
      if (!Array.isArray(input.columns) || input.columns.length === 0) {
        throw new Error("columns must be a non-empty array");
      }
      const seen = new Set<string>();
      const columns = input.columns.map((column) => {
        const columnName = assertIdentifier(column.name, "column name");
        if (seen.has(columnName)) throw new Error(`duplicate column name: ${columnName}`);
        seen.add(columnName);
        const type = column.type as SharedTableColumnType;
        if (!COLUMN_TYPES.includes(type)) throw new Error(`column ${columnName}: unknown type ${String(column.type)}`);
        return { name: columnName, type, required: column.required === true || undefined };
      });
      const companyTables = tablesByCompany.get(companyId) ?? new Map<string, StoredTable>();
      if (companyTables.has(name)) {
        throw new Error(`shared table already exists: ${name} (company ${companyId})`);
      }
      const def: SharedTableDef = { id: randomUUID(), companyId, name, columns, createdAt: nowIso(), updatedAt: nowIso() };
      companyTables.set(name, { def, rows: new Map() });
      tablesByCompany.set(companyId, companyTables);
      return copyDef(def);
    },

    upsertRow(companyId, tableName, input) {
      const table = requireTable(companyId, tableName);
      const key = assertNonEmpty(input.key, "row key");
      const values = input.values;
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        throw new Error("values must be a plain object");
      }
      const agentId = input.agentId == null ? null : assertNonEmpty(input.agentId, "agentId");
      const columnByName = new Map(table.def.columns.map((column) => [column.name, column]));
      for (const [columnName, value] of Object.entries(values)) {
        const column = columnByName.get(columnName);
        if (!column) throw new Error(`unknown column: ${columnName}`);
        if (!matchesColumnType(column.type, value)) {
          throw new Error(`type mismatch for column ${columnName} (expected ${column.type})`);
        }
      }
      for (const column of table.def.columns) {
        if (column.required && !(column.name in values)) {
          throw new Error(`missing required column: ${column.name}`);
        }
      }
      const row: SharedTableRow = { key, values: { ...values }, updatedByAgentId: agentId, updatedAt: nowIso() };
      table.rows.set(key, row);
      return { ...row, values: { ...row.values } };
    },

    queryRows(companyId, tableName, options = {}) {
      const table = requireTable(companyId, tableName);
      let rows = [...table.rows.values()].sort((a, b) => byString(a.key, b.key));
      if (options.where !== undefined) {
        const where = options.where;
        if (!where || typeof where !== "object" || Array.isArray(where)) {
          throw new Error("where must be a plain object");
        }
        const columnNames = new Set(table.def.columns.map((column) => column.name));
        for (const columnName of Object.keys(where)) {
          if (!columnNames.has(columnName)) throw new Error(`unknown column in where: ${columnName}`);
        }
        rows = rows.filter((row) =>
          Object.entries(where).every(([columnName, expected]) => deepEqual(row.values[columnName], expected)),
        );
      }
      if (options.limit !== undefined) {
        if (!Number.isInteger(options.limit) || options.limit < 1) {
          throw new Error("limit must be a positive integer");
        }
        rows = rows.slice(0, options.limit);
      }
      return rows.map((row) => ({ ...row, values: { ...row.values } }));
    },

    deleteRow(companyId, tableName, key) {
      const table = tablesByCompany.get(companyId)?.get(assertNonEmpty(tableName, "table name"));
      if (!table) return false;
      return table.rows.delete(assertNonEmpty(key, "row key"));
    },

    listTables(companyId) {
      const companyTables = tablesByCompany.get(companyId) ?? new Map<string, StoredTable>();
      return [...companyTables.values()]
        .map((table) => table.def)
        .sort((a, b) => byString(a.name, b.name))
        .map(copyDef);
    },
  };
}

const globalRef = globalThis as typeof globalThis & {
  __paperclipGlobalSharedTableStore?: SharedTableStore;
};

export const globalSharedTableStore: SharedTableStore = (globalRef.__paperclipGlobalSharedTableStore ??=
  createSharedTableStore());
