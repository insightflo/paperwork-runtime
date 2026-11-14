// server/src/__tests__/helpers/knowledge-pattern-eval-fixtures.ts
//
// [파일 목적] 지식 패턴 관련도 엔진 정량 eval 코퍼스(T3 — mistology 후보⑦⑩).
//   Paperwork 모노레포의 실제 결함 유형 16종을 시드 카드로 만들고, 고빈도 도메인 단어
//   (workflow/mission/issue)를 남용하는 유사 노이즈 카드 84장 생성기로 100장 코퍼스를
//   채운다. 엔티티(files/symbols/coupled/errorSignatures)는 실제 경로·심볼만 사용한다.
// [구조] 시드 16장은 signatureQuery(Recall@1 기준)와 변형 질의(korean/camel)를 함께
//   들고 있어 두 eval 파일이 같은 코퍼스·질의를 공유한다. 노이즈 84장 중 마지막 4장은
//   superseded/draft/retired 오염 카드 — 강한 엔티티를 싣고 있어 가시 집합 필터를
//   통과하면 상단에 뜨게 되므로 오염 eval이 의미를 갖는다(필터가 진짜로 막는지 검증).
// [경계] DB·서비스 import 금지 — 순수 픽스처. KnowledgePattern 행 타입만 빌린다.

import type { KnowledgePattern } from "../../services/knowledge-patterns.js";

/** eval 카드 — 관련도 엔진(RelevanceCard)·브리핑(BriefCard)이 요구하는 필드를 모두 포함.
 *  status/supersededById는 검색 가시성 계약(기본 검색 = active + supersededById IS NULL)
 *   을 순수 픽스처 수준에서 재현하기 위한 표시용 필드다(엔진은 이 필드를 읽지 않는다). */
export type EvalPatternCard = Pick<
  KnowledgePattern,
  | "id" | "kind" | "title" | "summary" | "symptoms" | "rootCause" | "whatWorked"
  | "scopeTags" | "files" | "symbols" | "coupled" | "errorSignatures"
  | "status" | "supersededById" | "versionNumber" | "pitfalls"
>;

export type SeedEvalPattern = {
  key: string;
  card: EvalPatternCard;
  /** Recall@1 기준 질의 — 고유 오류 서명 또는 희소 엔티티를 포함한다. */
  signatureQuery: string;
  /** 한국어 조사 변형 질의(Recall@2 대상 — 본문 토큰 매칭이 받쳐줘야 한다). */
  koreanQuery?: string;
  /** camelCase 심볼을 공백 분리한 질의(Recall@2 — 심볼 보유 시드만). */
  camelQuery?: string;
};

const base = {
  kind: "failure_mode",
  symptoms: null,
  rootCause: null,
  whatWorked: null,
  scopeTags: [] as string[],
  files: [] as string[],
  symbols: [] as string[],
  coupled: [] as string[],
  errorSignatures: [] as string[],
  status: "active",
  supersededById: null as string | null,
  versionNumber: 1,
  pitfalls: [] as string[],
};

function evalCard(id: string, over: Partial<EvalPatternCard> & Pick<EvalPatternCard, "title" | "summary">): EvalPatternCard {
  return { id, ...base, ...over };
}

/** 시드 16종 — Paperwork 실제 도메인 결함 유형(게이트 토큰, 산출물 경로, 어댑터
 *  타임아웃, journal drift, UI 계약, 웹훅 멱등, 트랜잭션 웨이크, PID, 잠금 순서,
 *  스텝 이슈 중복, 체크아웃 웨이크, 예산 하드스톱, 승인 게이트, 원장 권위,
 *  macOS EINVAL, PGlite 잠금). symptoms에 심볼 원문을 실어 camel 변형 질의가
 *  본문 토큰으로도 소환되게 한다. */
export function seedEvalPatterns(): SeedEvalPattern[] {
  return [
    { key: "gate-token-mismatch", signatureQuery: "gate_token_mismatch: stale completion token 서명", koreanQuery: "게이트 토큰의 불일치로 스텝이 발사되지 않는다", camelQuery: "synthesize delivery verification gate step",
      card: evalCard("seed-01", { title: "구조 게이트 토큰 불일치로 QA 스텝 무발사", summary: "생산자가 같은 세대에서 재완료되면 구 게이트 PASS 토큰과 현 토큰이 영구 불일치해 QA 이슈가 발사되지 않는다.", symptoms: "synthesizeDeliveryVerificationGateStep 재조합 후 런 running 유지, QA 스텝 pending 지속", rootCause: "이중완료가 completedAt을 재스탬프", whatWorked: "게이트 세대 토큰 CAS 재큐", scopeTags: ["workflow", "structural-gate"], files: ["server/src/services/workflow/delivery-verification-gate.ts"], symbols: ["synthesizeDeliveryVerificationGateStep"], errorSignatures: ["gate_token_mismatch: stale completion token"] }) },
    { key: "artifact-path-contract", signatureQuery: "work_product_path_contract: declared path escapes workspace root", koreanQuery: "산출물 경로가 계약을 위반해서 등록이 거부된다", camelQuery: "create company work product storage service",
      card: evalCard("seed-02", { title: "산출물 경로 계약 위반 등록 거부", summary: "선언된 산출물 경로가 워크스페이스 루트 밖을 가리키면 등록을 거부한다.", symptoms: "createCompanyWorkProductStorageService 호출부에서 경로 계약 거부", files: ["server/src/services/company-work-product-storage.ts"], symbols: ["createCompanyWorkProductStorageService"], errorSignatures: ["work_product_path_contract: declared path escapes workspace root"] }) },
    { key: "adapter-timeout", signatureQuery: "AdapterTimeoutError: claude_local child exceeded 600s", koreanQuery: "어댑터 자식 프로세스가 타임아웃으로 회수된다", camelQuery: "process adapter timeout",
      card: evalCard("seed-03", { title: "claude_local 어댑터 자식 프로세스 타임아웃", summary: "로컬 어댑터 자식이 600초를 넘기면 heartbeat가 프로세스를 회수한다.", symptoms: "processAdapter execute 호출이 응답 없이 600초 초과", files: ["server/src/adapters/process/execute.ts"], symbols: ["processAdapter"], errorSignatures: ["AdapterTimeoutError: claude_local child exceeded 600s"] }) },
    { key: "journal-drift", signatureQuery: "drizzle journal drift: idx mismatch with journaled migrations", koreanQuery: "마이그레이션 journal drift가 누적되면 DDL이 어긋난다",
      card: evalCard("seed-04", { title: "마이그레이션 journal drift로 수기 DDL 누락", summary: "journal에 기록되지 않은 수기 마이그레이션은 재생성 DDL과 drift를 만든다.", symptoms: "journal idx와 수기 마이그레이션 파일이 어긋남", files: ["packages/db/src/migrations/meta/_journal.json", "packages/db/drizzle.config.ts"], errorSignatures: ["drizzle journal drift: idx mismatch with journaled migrations"] }) },
    { key: "ui-contract-mismatch", signatureQuery: "TypeError: Cannot read properties of undefined (reading 'checklist')", koreanQuery: "이슈 상세 화면이 계약 불일치로 깨진다", camelQuery: "issues api contract",
      card: evalCard("seed-05", { title: "UI 계약 불일치로 이슈 상세 렌더 실패", summary: "issuesApi 응답 DTO 필드명이 서버와 어긋나 상세 화면이 깨진다.", symptoms: "issuesApi contract 드리프트로 checklist 필드가 undefined", files: ["ui/src/api/issues.ts"], symbols: ["issuesApi"], errorSignatures: ["TypeError: Cannot read properties of undefined (reading 'checklist')"] }) },
    { key: "webhook-idempotency", signatureQuery: "webhook_receipt_race: duplicate run created for delivery", koreanQuery: "웹훅 리플레이가 동시에 와서 런이 이중으로 발사된다", camelQuery: "ingest webhook delivery",
      card: evalCard("seed-06", { title: "웹훅 멱등 수신 경합으로 이중 런 발사", summary: "동시 리플레이가 receipt 잠금 전에 통과하면 같은 delivery로 run이 두 개 생긴다.", symptoms: "ingestWebhookDelivery 동시 호출 시 run 중복", files: ["server/src/services/plugin-webhook-receipt.ts"], symbols: ["ingestWebhookDelivery", "extractExternalId"], errorSignatures: ["webhook_receipt_race: duplicate run created for delivery"] }) },
    { key: "agent-wake-before-commit", signatureQuery: "resume_wake_before_commit: agent started on uncommitted state", koreanQuery: "웨이크가 커밋 전에 발송돼서 에이전트가 깬다", camelQuery: "find accepted workflow resume wake for step",
      card: evalCard("seed-07", { title: "루트 커밋 전 에이전트 웨이크 발송", summary: "재시작 승인 트랜잭션이 커밋되기 전에 웨이크가 나가면 에이전트가 미커밋 상태로 깬다.", symptoms: "findAcceptedWorkflowResumeWakeForStep 조회 직후 웨이크 발송", scopeTags: ["workflow", "wake"], files: ["server/src/services/workflow-resume-wake.ts"], symbols: ["findAcceptedWorkflowResumeWakeForStep"], coupled: ["server/src/services/plugin-webhook-receipt.ts"], errorSignatures: ["resume_wake_before_commit: agent started on uncommitted state"] }) },
    { key: "spawn-pid-heartbeat", signatureQuery: "heartbeat_pid_mismatch: stored pid is wrapper not child", koreanQuery: "자식 프로세스의 아이디가 래퍼로 기록된다",
      card: evalCard("seed-08", { title: "heartbeat에 래퍼 PID가 저장돼 자식 취소 불가", summary: "프로세스 어댑터의 spawn 콜백이 래퍼를 거치면 heartbeat가 실제 자식 PID를 놓친다.", files: ["server/src/services/runtime-execution-lifecycle.ts"], coupled: ["server/src/adapters/process/execute.ts"], errorSignatures: ["heartbeat_pid_mismatch: stored pid is wrapper not child"] }) },
    { key: "mission-runtime-lock", signatureQuery: "deadlock detected: mission_runtime upsert lock order", koreanQuery: "미션 런타임 잠금 순서 때문에 데드락이 난다", camelQuery: "stop mission runtimes for mission",
      card: evalCard("seed-09", { title: "미션 런타임 upsert 잠금 순서 데드락", summary: "미션 행 잠금 없이 런타임 유일 키를 먼저 잡으면 도착 순서에 따라 데드락이 난다.", symptoms: "stopMissionRuntimesForMission 대기 중 잠금 순서 충돌", files: ["server/src/services/missions/mission-runtime-manager.ts"], symbols: ["stopMissionRuntimesForMission"], errorSignatures: ["deadlock detected: mission_runtime upsert lock order"] }) },
    { key: "step-issue-dup", signatureQuery: "unique_step_issue: duplicate issue row for step", koreanQuery: "동기화가 겹쳐서 스텝 이슈가 두 개 생긴다", camelQuery: "process queued workflow tool step runs",
      card: evalCard("seed-10", { title: "겹치는 동기화로 스텝 이슈 이중 생성", summary: "유일 스텝 행만으로는 겹치는 동기화 시 이슈가 두 개 생긴다.", symptoms: "processQueuedWorkflowToolStepRuns 동시 실행으로 이슈 중복", files: ["server/src/services/workflow/dag-engine.ts"], symbols: ["processQueuedWorkflowToolStepRuns"], errorSignatures: ["unique_step_issue: duplicate issue row for step"] }) },
    { key: "issue-checkout-wake", signatureQuery: "checkout_wake_skip: assignee wake skipped after claim", koreanQuery: "체크아웃 후에 담당자 웨이크가 누락된다", camelQuery: "should wake assignee on checkout",
      card: evalCard("seed-11", { title: "이슈 체크아웃 후 담당자 웨이크 누락", summary: "체크아웃 원자 갱신은 됐지만 웨이크 판정이 스킵돼 담당자가 깨지 않는다.", symptoms: "shouldWakeAssigneeOnCheckout 반환이 클레임 직후 false", files: ["server/src/routes/issues-checkout-wakeup.ts"], symbols: ["shouldWakeAssigneeOnCheckout"], errorSignatures: ["checkout_wake_skip: assignee wake skipped after claim"] }) },
    { key: "budget-hard-stop", signatureQuery: "budget_hard_stop: run auto-paused at cap", koreanQuery: "예산 상한에 닿아서 런이 자동으로 멈춘다", camelQuery: "budget service hard stop",
      card: evalCard("seed-12", { kind: "constraint", title: "예산 상한 도달 시 런 자동 일시정지", summary: "예산 하드스톱에 닿으면 진행 중 런을 자동 일시정지한다.", symptoms: "budgetService hardStop 판정 후 런이 paused로 전이", scopeTags: ["budget"], files: ["server/src/services/budgets.ts"], symbols: ["budgetService"], errorSignatures: ["budget_hard_stop: run auto-paused at cap"] }) },
    { key: "approval-gate", signatureQuery: "approval_gate_bypass: governed action ran without approval", koreanQuery: "승인 없이 관리 행동이 실행됐다", camelQuery: "approval service gate",
      card: evalCard("seed-13", { kind: "constraint", title: "승인 없는 관리 행동 실행 차단", summary: "승인 게이트 대상 행동은 승인 전에 실행될 수 없다.", symptoms: "approvalService gateBypass 미승인 행동이 큐 통과", scopeTags: ["approval"], files: ["server/src/services/approvals.ts"], symbols: ["approvalService"], errorSignatures: ["approval_gate_bypass: governed action ran without approval"] }) },
    { key: "verdict-ledger-authority", signatureQuery: "verdict_ledger_authority: comment-derived row used as authority", koreanQuery: "원장 행을 권위로 읽어서 판정이 오염된다",
      card: evalCard("seed-14", { title: "코멘트 파생 원장 행을 실행 권위로 오인", summary: "sourceCommentId가 있는 원장 행은 표시 전용인데 실행 소비자가 권위로 읽으면 재개 판정이 오염된다.", files: ["server/src/services/workflow/validation-verdict-ledger.ts"], errorSignatures: ["verdict_ledger_authority: comment-derived row used as authority"] }) },
    { key: "macos-einval", signatureQuery: "setTypeOfService EINVAL 재현", koreanQuery: "macOS에서 Node 클라이언트가 EINVAL을 던진다",
      card: evalCard("seed-15", { title: "macOS Node HTTP 클라이언트 EINVAL", summary: "macOS에서 Node HTTP 클라이언트가 setTypeOfService EINVAL을 던지면 실패 결과를 보존하고 Node/undici 버전을 비교한다.", files: ["server/src/services/public-https-request.ts"], errorSignatures: ["setTypeOfService EINVAL"] }) },
    { key: "pglite-lock", signatureQuery: "pglite bootstrap failed: data directory locked", koreanQuery: "데이터 디렉터리가 잠겨서 디비가 안 뜬다", camelQuery: "start embedded postgres test database",
      card: evalCard("seed-16", { title: "PGlite 데이터 디렉터리 잠금으로 임베디드 DB 기동 실패", summary: "data/pglite 잔여 잠금이 있으면 임베디드 Postgres 기동이 실패한다.", symptoms: "startEmbeddedPostgresTestDatabase 호출이 데이터 디렉터리 잠금으로 실패", files: ["packages/db/src/test-embedded-postgres.ts"], symbols: ["startEmbeddedPostgresTestDatabase"], errorSignatures: ["pglite bootstrap failed: data directory locked"] }) },
  ];
}

const NOISE_WORDS = [
  "workflow", "mission", "issue", "heartbeat", "step", "run", "queue", "budget",
  "owner", "dispatch", "retry", "verdict", "ledger", "gate", "token", "artifact",
];

/** 노이즈 84장 — 고빈도 도메인 단어 남용 유사카드 80장 + 오염 카드 4장.
 *  공유 심볼 sharedWorkflowVocabHelper를 전 장이 들고 있어(df≈84) IDF 붕괴 방어
 *  eval의 고빈도 엔티티 역할을 한다. 4장의 오염 카드는 superseded/draft/retired
 *  상태에 강한 시드급 엔티티를 실어 가시성 필터가 실제로 막는지 증명한다. */
export function noiseEvalCards(): EvalPatternCard[] {
  const cards: EvalPatternCard[] = [];
  for (let i = 0; i < 80; i += 1) {
    const a = NOISE_WORDS[i % NOISE_WORDS.length]!;
    const b = NOISE_WORDS[(i * 7 + 3) % NOISE_WORDS.length]!;
    const c = NOISE_WORDS[(i * 11 + 5) % NOISE_WORDS.length]!;
    cards.push(evalCard(`noise-${String(i + 1).padStart(3, "0")}`, {
      title: `${a} ${b} 점검 메모 ${i + 1}`,
      summary: `${a}/${b}/${c} 관련 일상 점검 기록 — 특이사항 없음.`,
      symptoms: `${b} ${c} 재점검 예정`,
      scopeTags: i % 4 === 0 ? [a] : ["ops-memo"],
      files: [`server/src/services/noise/${a}-mod-${i % 9}.ts`],
      symbols: ["sharedWorkflowVocabHelper", `noiseCheck${i % 5}`],
    }));
  }
  // 오염 카드 — 시드급 강한 엔티티를 싣고 비가시 상태(superseded/draft/retired).
  cards.push(
    evalCard("noise-081", { title: "폐기된 게이트 토큰 카드", summary: "구 버전 판정 — 대체 체인으로 물러남.", errorSignatures: ["gate_token_mismatch: stale completion token"], supersededById: "seed-01-v2" }),
    evalCard("noise-082", { title: "미승인 어댑터 초안", summary: "게이트 강등 draft — 승인 전 무측.", symbols: ["processAdapter"], status: "draft" }),
    evalCard("noise-083", { title: "은퇴한 예산 카드", summary: "더는 유효하지 않은 예산 정책.", symbols: ["budgetService"], status: "retired" }),
    evalCard("noise-084", { title: "대체된 웹훅 카드", summary: "체인 중간 버전.", errorSignatures: ["webhook_receipt_race: duplicate run created for delivery"], supersededById: "seed-06-v2" }),
  );
  return cards;
}

/** 기본 검색 가시성 계약의 순수 거울 — searchKnowledgePatterns의
 *  supersededById IS NULL + status='active' 조건과 같은 술어. 오염 eval에서
 *  "필터가 진짜로 강한 카드를 막는가"를 증명하는 데 쓴다. */
export function isDefaultSearchVisible(card: EvalPatternCard): boolean {
  return card.status === "active" && card.supersededById == null;
}

export type EvalCorpus = {
  seeds: SeedEvalPattern[];
  noise: EvalPatternCard[];
  /** 100장 전체(가시 + 오염). */
  all: EvalPatternCard[];
  /** 기본 검색이 보는 집합 — active + 미대체 96장. */
  visible: EvalPatternCard[];
  /** 가시성 필터가 배제해야 하는 카드들(비가시 상태). */
  contaminated: EvalPatternCard[];
};

export function buildEvalCorpus(): EvalCorpus {
  const seeds = seedEvalPatterns();
  const noise = noiseEvalCards();
  const all = [...seeds.map((seed) => seed.card), ...noise];
  const visible = all.filter(isDefaultSearchVisible);
  const contaminated = all.filter((card) => !isDefaultSearchVisible(card));
  return { seeds, noise, all, visible, contaminated };
}
