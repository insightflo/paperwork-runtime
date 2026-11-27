import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

export interface SharedTableSummary {
  id: string;
  name: string;
  columns: string[];
  rows: Record<string, string | number | boolean | null>[];
  updatedAt?: string;
}

interface AgentSharedTablesPanelProps {
  tables: SharedTableSummary[];
  onCreateTable?: (input: { name: string; columns: string[] }) => void | Promise<void>;
  creating?: boolean;
}

export function AgentSharedTablesPanel({ tables, onCreateTable, creating = false }: AgentSharedTablesPanelProps) {
  const id = useId();
  const [selectedId, setSelectedId] = useState<string>();
  const [name, setName] = useState("");
  const [columnNames, setColumnNames] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const columns = [...new Set(columnNames.split(",").map((column) => column.trim()).filter(Boolean))];
  const busy = creating || submitting;
  const selected = tables.find((table) => table.id === selectedId) ?? tables[0];

  async function createTable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onCreateTable || creating || inFlight.current || !name.trim() || !columns.length) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onCreateTable({ name: name.trim(), columns });
      setName("");
      setColumnNames("");
    } catch {
      setError("공유 표를 만들지 못했습니다. 입력 내용을 확인하고 다시 시도해 주세요.");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section aria-label="에이전트 공유 표" className="min-w-0 space-y-4 rounded-lg border bg-card p-4">
      <header>
        <h3 className="text-sm font-semibold">공유 표</h3>
        <p className="mt-1 text-xs text-muted-foreground">여러 에이전트가 같은 정보를 함께 확인하고 정리합니다.</p>
      </header>
      {!selected ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          에이전트들이 함께 읽고 쓰는 공유 표가 아직 없습니다
        </p>
      ) : (
        <Tabs value={selected.id} onValueChange={setSelectedId} className="min-w-0">
          {tables.length > 1 && (
            <div className="overflow-x-auto">
              <TabsList aria-label="공유 표 선택">
                {tables.map((table) => <TabsTrigger key={table.id} value={table.id}>{table.name}</TabsTrigger>)}
              </TabsList>
            </div>
          )}
          {tables.map((table) => (
            <TabsContent key={table.id} value={table.id} aria-label={table.name}>
              <div className="overflow-x-auto rounded-md border">
                <table aria-label={table.name} className="w-full text-left text-sm">
                  <caption className="sr-only">{table.name} · {table.rows.length}개 행</caption>
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>{table.columns.map((column, index) => (
                      <th key={`${column}-${index}`} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{column}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {table.rows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-t">
                        {table.columns.map((column, index) => (
                          <td key={`${column}-${index}`} className="max-w-xs break-words px-3 py-2">{String(row[column] ?? "—")}</td>
                        ))}
                      </tr>
                    ))}
                    {!table.rows.length && (
                      <tr><td colSpan={Math.max(1, table.columns.length)} className="px-3 py-6 text-center text-muted-foreground">
                        아직 등록된 행이 없습니다.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      )}
      {onCreateTable && (
        <form aria-label="새 공유 표 만들기" aria-busy={busy} onSubmit={createTable} className="space-y-2 border-t pt-3">
          <h4 className="text-xs font-medium">새 공유 표 만들기</h4>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex-1 space-y-1 text-xs">
              <span>표 이름</span>
              <Input aria-label="표 이름" value={name} onChange={(event) => setName(event.target.value)} required disabled={busy} placeholder="예: 고객 목록" />
            </label>
            <label className="flex-1 space-y-1 text-xs">
              <span>열 이름</span>
              <Input aria-label="열 이름" aria-describedby={`${id}-hint`} value={columnNames} onChange={(event) => setColumnNames(event.target.value)} required disabled={busy} placeholder="이름, 상태, 담당자" />
            </label>
            <Button type="submit" size="sm" disabled={busy || !name.trim() || !columns.length}>
              {busy ? "만드는 중…" : "만들기"}
            </Button>
          </div>
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">열 이름은 쉼표로 구분하세요. 중복된 이름과 빈 항목은 제외합니다.</p>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </form>
      )}
    </section>
  );
}
