#!/usr/bin/env node
/**
 * resume-policy-bindings.ts — 검토 resume 정책 바인딩 채취·검증 도구(읽기 전용).
 *
 * [목적] REVIEWED_RESUME_POLICIES(server/src/services/workflow/resume/reviewed-policy.ts)
 *   의 toolBindings 는 "검토 시점 registry 행의 정확 참조"(id/updatedAt ISO/configHash)다.
 *   이 스크립트는 검토자가 live DB 에서 바인딩을 채취하고, 등록된 매니페스트가 현재
 *   registry 와 아직 일치하는지(정책 자동 무효화 여부)를 검증한다.
 *   configHash 계산은 preview-policy.ts 의 registryBindingHash 와 동일 규칙
 *   hashStructuredValue({name,enabled,adapterType,adapterConfig,inputSchema}) 를
 *   실제 구현(server/src/services/issue-execution-cards/hash.ts)에서 import 해 계산한다.
 *   steps-hash 모드는 frozen run 정의의 안정 매칭 키(resumeStepsHash)를 계산해
 *   매니페스트 매치 여부(exact/stepsHash/없음)를 보고한다 — 재개 차단 사전 진단용.
 *
 * [사용법]
 *   바인딩 채취(도구 이름 지정):
 *     pnpm exec tsx scripts/resume-policy-bindings.ts collect \
 *       --company ff3e3efd-e30c-45c2-b893-497164405629 \
 *       --names manual-onboarding-qa,manual-onboarding-publish
 *   바인딩 채취(run frozen 정의가 참조하는 도구 전부):
 *     pnpm exec tsx scripts/resume-policy-bindings.ts collect --run <runId>
 *   매니페스트 전체 검증(바인딧 값이 현재 registry 와 일치하는지):
 *     pnpm exec tsx scripts/resume-policy-bindings.ts verify
 *   run 재개 진단(definitionHash/stepsHash/매치 정책):
 *     pnpm exec tsx scripts/resume-policy-bindings.ts steps-hash --run <runId>
 *   psql 접근 방식 변경(기본은 ssh a1 경유, hwagin-check 와 동일. SQL 은 stdin 으로 전달):
 *     --psql 'PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -tA'
 *
 * [보안] 이 스크립트는 SELECT 만 실행한다. SQL 은 스크립트가 스스로 조립하며 사용자
 *   입력(uuid/도구명)은 엄격 정규식 검증 후 리터럴로만 삽입한다. 결과에 secret 값
 *   (adapterConfig 의 secret_ref 등)은 포함하지 않는다 — id/updatedAt/configHash 만 출력.
 * [수정시 주의] registryBindingHash 규칙이 바뀌면 preview-policy.ts 와 함께 갱신한다.
 */
import { spawnSync } from "node:child_process";
import { hashStructuredValue } from "../server/src/services/issue-execution-cards/hash.js";
import { resumeStepsHash } from "../server/src/services/workflow/resume/preview-policy.js";
import { REVIEWED_RESUME_POLICIES } from "../server/src/services/workflow/resume/reviewed-policy.js";

const DEFAULT_PSQL =
  `ssh a1 "PGPASSWORD=paperclip /usr/pgsql-18/bin/psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -tA"`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TOOL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,120}$/u;

interface UsageError extends Error {}
function usage(message: string): never {
  process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    "사용법: pnpm exec tsx scripts/resume-policy-bindings.ts <collect|verify|steps-hash> [options]\n" +
    "  collect --company <uuid> [--names a,b | --run <runId>] [--psql <cmd>]\n" +
    "  verify [--psql <cmd>]\n" +
    "  steps-hash --run <runId> [--psql <cmd>]\n",
  );
  process.exit(2);
}

/** 단일 SELECT 를 stdin(-f -)으로 전달해 실행하고 tA 출력 행 배열을 반환한다.
 *  SQL 을 인자로 넘기지 않아 로컬/원격 셸 이중 인용 문제가 없다. */
function psqlRows(psqlCmd: string, sql: string): string[] {
  if (!/^select[\s(]/iu.test(sql.trim()) || /;/u.test(sql)) {
    throw new Error("이 스크립트는 단일 SELECT 만 실행합니다");
  }
  const result = spawnSync("/bin/sh", ["-c", `${psqlCmd} -f -`], {
    input: sql, encoding: "utf8", timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`psql 실패(exit ${result.status}): ${(result.stderr ?? "").trim().slice(0, 500)}`);
  }
  return (result.stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

interface RegistryRow {
  id: string; name: string; enabled: boolean;
  adapterType: string; adapterConfig: unknown; inputSchema: unknown;
  updatedAtMs: string; configHash: string;
}

function registryBindingHash(row: {
  name: string; enabled: boolean; adapterType: string; adapterConfig: unknown; inputSchema: unknown;
}): string {
  return hashStructuredValue({
    name: row.name, enabled: row.enabled, adapterType: row.adapterType,
    adapterConfig: row.adapterConfig, inputSchema: row.inputSchema,
  });
}

function fetchRegistryRows(psqlCmd: string, companyId: string, names?: string[]): RegistryRow[] {
  if (!UUID_RE.test(companyId)) usage("--company 는 uuid 여야 합니다");
  const nameFilter = names && names.length > 0
    ? ` AND name = ANY(ARRAY[${names.map((n) => `'${n}'`).join(",")}]::text[])`
    : "";
  const sql =
    `SELECT jsonb_build_object('id',id,'name',name,'enabled',enabled,'adapterType',adapter_type,` +
    `'adapterConfig',adapter_config,'inputSchema',input_schema,'updatedAt',to_json(updated_at))::text ` +
    `FROM tool_definitions WHERE company_id='${companyId}'${nameFilter} ORDER BY name`;
  return psqlRows(psqlCmd, sql).map((line) => {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const base = {
      name: String(raw.name), enabled: raw.enabled === true, adapterType: String(raw.adapterType),
      adapterConfig: raw.adapterConfig, inputSchema: raw.inputSchema,
    };
    return {
      id: String(raw.id), ...base,
      updatedAtMs: new Date(String(raw.updatedAt)).toISOString(),
      configHash: registryBindingHash(base),
    };
  });
}

function printBinding(row: RegistryRow): void {
  process.stdout.write(
    JSON.stringify({ name: row.name, id: row.id, updatedAt: row.updatedAtMs, configHash: row.configHash, enabled: row.enabled }) + "\n",
  );
}

function toolNamesFromSteps(steps: unknown): string[] {
  const names = new Set<string>();
  for (const step of Array.isArray(steps) ? (steps as Record<string, unknown>[]) : []) {
    if (typeof step.toolName === "string") names.add(step.toolName);
    for (const listKey of ["toolNames", "tools"] as const) {
      const list = step[listKey];
      if (Array.isArray(list)) for (const item of list) if (typeof item === "string") names.add(item);
    }
  }
  return [...names];
}

interface RunDefinitionRow { companyId: string; definitionHash: string; executionMode: string; steps: unknown[] }

function fetchRunDefinition(psqlCmd: string, runId: string): RunDefinitionRow {
  if (!UUID_RE.test(runId)) usage("--run 은 uuid 여야 합니다");
  const sql =
    `SELECT jsonb_build_object('companyId',company_id,'definitionHash',definition_hash,` +
    `'executionMode',execution_mode,'steps',steps)::text FROM workflow_run_definitions WHERE workflow_run_id='${runId}'`;
  const rows = psqlRows(psqlCmd, sql);
  if (rows.length !== 1) throw new Error(`workflow_run_definitions 행이 ${rows.length}건 — runId 를 확인하세요`);
  const raw = JSON.parse(rows[0]!) as Record<string, unknown>;
  return {
    companyId: String(raw.companyId), definitionHash: String(raw.definitionHash),
    executionMode: String(raw.executionMode), steps: raw.steps as unknown[],
  };
}

function parseNames(value: string): string[] {
  return value.split(",").map((n) => n.trim()).filter((n) => n.length > 0).map((n) => {
    if (!TOOL_NAME_RE.test(n)) usage(`도구 이름 형식 오류: ${n}`);
    return n;
  });
}

function main(): void {
  const argv = process.argv.slice(2);
  const mode = argv.shift();
  let psqlCmd = DEFAULT_PSQL;
  let company: string | undefined;
  let names: string[] | undefined;
  let runId: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]; const value = argv[i + 1];
    if (value === undefined) usage(`플래그 값 누락: ${flag}`);
    if (flag === "--psql") psqlCmd = value;
    else if (flag === "--company") company = value;
    else if (flag === "--names") names = parseNames(value);
    else if (flag === "--run") runId = value;
    else usage(`알 수 없는 플래그: ${flag}`);
  }

  if (mode === "collect") {
    if (runId !== undefined) {
      const def = fetchRunDefinition(psqlCmd, runId);
      const tools = toolNamesFromSteps(def.steps);
      process.stdout.write(`# run ${runId} frozen 정의가 참조하는 도구(${tools.length}개) 바인딩\n`);
      for (const row of fetchRegistryRows(psqlCmd, def.companyId, tools)) printBinding(row);
      return;
    }
    if (company === undefined || names === undefined || names.length === 0) {
      usage("collect 는 --company + --names 또는 --run 이 필요합니다");
    }
    for (const row of fetchRegistryRows(psqlCmd, company, names)) printBinding(row);
    return;
  }

  if (mode === "verify") {
    const byCompany = new Map<string, Map<string, RegistryRow>>();
    const rowsFor = (companyId: string): Map<string, RegistryRow> => {
      let map = byCompany.get(companyId);
      if (map === undefined) {
        map = new Map(fetchRegistryRows(psqlCmd, companyId).map((row) => [row.id, row]));
        byCompany.set(companyId, map);
      }
      return map;
    };
    let failures = 0;
    const stepsHashKeys = new Map<string, number>();
    for (const policy of REVIEWED_RESUME_POLICIES) {
      if (policy.stepsHash !== undefined) {
        const key = `${policy.companyId}:${policy.stepsHash}`;
        stepsHashKeys.set(key, (stepsHashKeys.get(key) ?? 0) + 1);
      }
      const registry = rowsFor(policy.companyId);
      for (const [stepId, step] of Object.entries(policy.steps)) {
        for (const binding of step.toolBindings) {
          const row = registry.get(binding.id);
          const problems: string[] = [];
          if (row === undefined) problems.push("registry 행 없음(삭제됨)");
          else {
            if (!row.enabled) problems.push(`enabled=false(${row.name})`);
            if (row.updatedAtMs !== binding.updatedAt) problems.push(`updatedAt 불일치 manifest=${binding.updatedAt} live=${row.updatedAtMs}`);
            if (row.configHash !== binding.configHash) problems.push(`configHash 불일치 manifest=${binding.configHash.slice(0, 12)} live=${row.configHash.slice(0, 12)}`);
          }
          if (problems.length > 0) {
            failures += 1;
            process.stdout.write(`STALE ${policy.definitionHash.slice(0, 12)} step=${stepId} binding=${binding.id}\n  - ${problems.join("; ")}\n`);
          }
        }
      }
    }
    for (const [key, count] of stepsHashKeys) {
      if (count > 1) {
        failures += 1;
        process.stdout.write(`CONTRADICT (companyId,stepsHash) 중복 ${count}건: ${key.slice(0, 47)}…\n`);
      }
    }
    process.stdout.write(failures === 0
      ? `OK — 매니페스트 ${REVIEWED_RESUME_POLICIES.length}건, 바인딩 전부 현재 registry 와 일치\n`
      : `FAIL — 불일치 ${failures}건(행이 바뀌면 정책은 자동 무효화 — 재검토·갱신 필요)\n`);
    process.exitCode = failures === 0 ? 0 : 1;
    return;
  }

  if (mode === "steps-hash") {
    if (runId === undefined) usage("steps-hash 는 --run 이 필요합니다");
    const def = fetchRunDefinition(psqlCmd, runId);
    const hash = resumeStepsHash(def);
    const exact = REVIEWED_RESUME_POLICIES.filter((p) => p.companyId === def.companyId && p.definitionHash === def.definitionHash);
    const byShape = REVIEWED_RESUME_POLICIES.filter((p) => p.companyId === def.companyId && p.stepsHash === hash);
    process.stdout.write(JSON.stringify({
      runId, companyId: def.companyId, definitionHash: def.definitionHash, stepsHash: hash,
      match: exact.length === 1 ? "exact-definitionHash" : byShape.length === 1 ? "stepsHash" : "none(정책 미검토 — policyMissing)",
    }, null, 2) + "\n");
    return;
  }

  usage(`알 수 없는 모드: ${String(mode)}`);
}

main();
