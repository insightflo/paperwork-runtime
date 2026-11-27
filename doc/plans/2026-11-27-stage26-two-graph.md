# Stage 26 Two-Graph Architecture — 구현 현황·불변식·잔여 연결 계획

- 작성일: 2026-11-27
- 브랜치: `s26-w6-plan-doc` (기반 `61984852` = `stage/stage25-local` 위 Stage 26 웨이브 커밋 포함)
- 설계 원본: North Star 덱 `graphs-in-ai-교육자료.html` + 읽기 전용 설계 문서 `s26-two-graph-architecture.md`
- 이 문서의 역할: Wave 1–6에서 실제로 구현된 모듈·경로, 핵심 불변식, 남은 live-wiring 작업을 한 곳에 정리한다.

---

## 1. Two-Graph North Star

### Pillar 1 — Workflow Graph (Control)

워크플로 그래프는 3가지 논리 노드 클래스(`WorkflowLogicalNodeClass`)를 1급 개념으로 다룬다.

| 논리 클래스 | 의미 | 원본 draft 타입 |
|---|---|---|
| `function` | 결정적 코드·규칙. 보장을 담당 | `tool`, `complete` (제어 의사노드 `if`는 간선/종결 핸들) |
| `ai_agent` | 판단·초안. 언어를 담당 | `agent`, `workflow` (자식 위임) |
| `human_wait` | 구조적 멈춤-재개 | 신규 `type: "human_wait"` + 레거시 `graphApprovalRequired` 읽기 승격 |

병렬·조인은 `dependsOn`+`graphConcurrencyKey/Limit`, 조건 분기는 `conditionGroup` 간선, 루프는 `iterationIndex`로 기존 의미론을 유지한다. 실행 엔진은 `dag-engine.ts` + `control-flow/*`다.

### Pillar 2 — Zero-Copy PG 논리 데이터 그래프 / GraphRAG (Context)

물리적 복사·신규 그래프 DB 없이 기존 PostgreSQL 테이블의 FK·self-FK·jsonb·배열 컬럼만으로 노드/엣지를 정의한다(테이블 위 관계 정의). 15종 엣지 카탈로그(`mission_issue`, `issue_parent`, `issue_work_product`, `issue_run`, `work_product_run`, `run_retry`, `run_step_run`, `workflow_run_mission`, `workflow_run_parent`, `step_run_issue`, `step_run_workflow_run`, `decision_issue`, `decision_workflow_run`, `knowledge_source`, `knowledge_link`) 위에서 bounded 2-hop traversal을 수행하고, FTS 시드 → 2-hop 확장 → `via` 출처 인용을 포함한 GraphRAG 컨텍스트 팩을 만든다. 벡터 인덱스 없이 vectorless 노선을 유지한다.

### Pillar 3 — Problem-First 라우팅 가드 (Q1/Q2)

- **Q1**: 멈춤(사람 승인)·분기·순서 보장이 앱 구조로 강제돼야 하는가 → Workflow Graph (`human_wait` + 간선)
- **Q2**: 필요한 정보가 2 hop 이상 떨어진 여러 기록에 흩어져 있는가 → Data Graph 질의 (`data_graph_query`)
- 둘 다 아니오 → 단일 에이전트/함수 호출. 그래프를 만들지 않는다.

가드는 생성 UI에서 차단이 아닌 완화 가능한 권고(none/hint/caution)로 표시된다. 문제가 도구보다 먼저다.

### Thin Query Bridge

워크플로 노드가 데이터 그래프를 질의해 연결된 컨텍스트를 얻고 → 결정적 규칙을 적용하고 → 사람 승인을 거쳐 → 에이전트가 초안을 쓴다. `workflow-context-adapter.ts`가 traversal 결과를 `buildGraphRagContextPack` 출처 인용 팩으로 연결한다.

---

## 2. 구현된 모듈과 파일 경로 (Wave 1–6)

아래 경로는 이 워크트리에서 실제 존재를 검증했다. 커밋 해시는 해당 파일이 만들어진 커밋이다.

### Wave 1 — 공유 타입·드래프트 (`a93e8985`, 테스트 `b100c24d`)

| 파일 | 역할 |
|---|---|
| `packages/shared/src/types/workflow.ts` | `human_wait` 논리 클래스, `WorkflowHumanWaitDecisionTemplate`, `resolveWorkflowNodeLogicalClass`(type > decisionTemplate > `graphApprovalRequired` 순 판정) |
| `packages/shared/src/validators/workflow.ts` | `workflowHumanWaitDecisionTemplateSchema` zod 검증, step 스키마에 `type:"human_wait"`·`decisionTemplate` 추가 |
| `ui/src/pages/workflows/step-draft-types.ts` | decisionTemplate 초안 프리셋 필드 |
| `ui/src/pages/workflows/step-draft-defaults.ts` | human_wait 기본값 |
| `ui/src/pages/workflows/step-draft-parsers.ts` | import 파싱 + 레거시 `graphApprovalRequired` 읽기 논리 승격 |
| `packages/shared/src/workflow-human-wait.test.ts` | shared 검증·승격 단위 테스트 |
| `ui/src/pages/workflows/step-draft-human-wait.test.ts` | 드래프트 파서 테스트 (`1f0fa6af`에서 직렬화 케이스 확장) |

### Wave 2 — 에디터 논리 클래스 오버레이 (`ecb0c1b2`, `fbe26f87`, `e63ddcb1`, `7abcf358`, `1f0fa6af`, `8a4733b2`)

| 파일 | 역할 |
|---|---|
| `ui/src/pages/workflows/graph-editor/node-logical-class.ts` | 스텝 → 3클래스 매핑 + 배지 라벨/스타일 |
| `ui/src/pages/workflows/graph-editor/GraphCanvasStatusStrip.tsx` | 3클래스 노드 수 pill |
| `ui/src/pages/workflows/graph-editor/GraphCanvas.tsx` | 노드 카드에 논리 클래스 배지 렌더 + 카운트 전파 |
| `ui/src/pages/workflows/graph-editor/GraphInspectorEditStep.tsx` | 인스펙터에서 decisionTemplate 편집 |
| `ui/src/pages/workflows/step-decision-template-card.tsx` | 승인 카드 프리셋 편집 컴포넌트 |
| `ui/src/pages/workflows/step-draft-serialization.ts` | decisionTemplate 초안 필드 → 스텝 정의 직렬화 |
| `ui/src/pages/workflows/graph-editor/workflowGraphActionHelpers.ts`, `ui/src/pages/workflows/workflow-graph-structure-edits.ts` | 노드 구조 편집 헬퍼 (기존, 오버레이와 호환) |
| 테스트 | `GraphNodeLogicalClassBadge.test.tsx`, `GraphInspectorEditStepContract.test.tsx`, `GraphCanvasStatusStrip.test.tsx` |

### Wave 3 — 서버 human_wait 카드·게이트 (`4f3812f5`, `c635bc77`)

| 파일 | 역할 |
|---|---|
| `server/src/services/workflow/human-wait-card.ts` | 멱등 카드 생성. `requestKey = human-wait:{companyId}:{workflowRunId}:{stepKey}:{generation}` (회사별 유일). 템플릿은 구조화 옵션 fact로만 직렬화 |
| `server/src/services/workflow/control-flow/human-wait-gate.ts` | `classifyHumanWaitDecisionRow`(순수 분류) + `evaluateHumanWaitGate`(카드 보장 → 판정). `operator_decisions.status`+`result` jsonb만 읽음 |
| `server/src/__tests__/human-wait-card.test.ts`, `server/src/__tests__/human-wait-gate.test.ts` | 멱등성·분류·fail-closed 테스트 |

`dag-engine.ts` 진입점 연결은 아직 남아 있다(§4).

### Wave 4 — 실행 타임라인 (`ecb0c1b2`, `aa54b964`)

| 파일 | 역할 |
|---|---|
| `ui/src/pages/workflows/graph-run-timeline-segments.ts` | 순수 세그먼트 계산: `step` / `parallel` / `join` / `human_wait` / `resume` (Parallel→Join→Human Wait→Resume 읽기 순서) |
| `ui/src/pages/workflows/GraphRunTimeline.tsx` | 타임라인 렌더 |
| `ui/src/pages/workflows/GraphRunTimeline.test.tsx` | 세그먼트 픽스처 테스트 |
| `ui/src/pages/workflows/graph-editor/GraphRunPreview.tsx` | Graph/Timeline 토글로 마운트 |

`human_wait` 세그먼트는 오버레이 스텝의 `graphRunDecisionId` 등 필드를 읽는데, run 오버레이 API가 이 필드를 아직 내려주지 않는다(§4).

### Wave 5 — 논리 데이터 그래프 질의·라우트·UI 클라이언트 (`91391e5a`, `f1a3b803`, `928ff1af`, `592532e5`, `3892ed67`, `45d8b89b`)

| 파일 | 역할 |
|---|---|
| `server/src/services/data-graph/logical-graph-catalog.ts` | 8종 노드·15종 엣지 카탈로그 (근거 컬럼 `viaColumn` 명시) |
| `server/src/services/data-graph/logical-graph.ts` | bounded 2-hop traversal. `LOGICAL_GRAPH_MAX_HOPS=2`, limit clamp ≤100, hop별 UNION 확장, `truncated` 플래그 |
| `server/src/services/data-graph/graphrag-context-pack.ts` | FTS 시드 컨텍스트 팩 + 비밀 가림(sanitize) |
| `server/src/routes/data-graph.ts` | POST `recommend-mode`·`context-pack` (`f1a3b803`), GET `/companies/:companyId/data-graph/query` (`592532e5`). 전부 읽기 전용·회사 스코프 |
| `server/src/app.ts` | data-graph 라우트 마운트 |
| `ui/src/api/data-graph.ts` | 타입 클라이언트 (`928ff1af`) + `queryDataGraph` GET (`3892ed67`) |
| `ui/src/components/DataGraphContextPanel.tsx` | 2-hop 탐색 + GraphRAG 출처 팩 드로어 패널 (`45d8b89b`) |
| 테스트 | `logical-graph.test.ts`, `graphrag-context-pack.test.ts`, `data-graph-routes.test.ts`, `data-graph.test.ts`, `DataGraphContextPanel.test.tsx` |

### Wave 6 — Thin Bridge·주입 헬퍼·문서 (`36e3e8ce`, `ffaffb69`, `af2f04fa`)

| 파일 | 역할 |
|---|---|
| `server/src/services/data-graph/workflow-context-adapter.ts` | traversal → `buildGraphRagContextPack` 브리지, bounded 마크다운 직렬화 |
| `server/src/__tests__/workflow-context-adapter.test.ts` | 브리지 계약 테스트 |
| `server/src/services/heartbeat-workflow-knowledge-context.ts` | `appendOptionalDataGraphContext`: opt-in(`enabled` 기본 false) 컨텍스트 덧붙이기 헬퍼 |
| `server/src/__tests__/heartbeat-workflow-graph-context.test.ts` | opt-in·fail-open(zero prompt bloat) 테스트 |
| `doc/SPEC-implementation.md` | Two-Graph 아키텍처 절 추가(추가형, 109줄) |
| `doc/DATABASE.md` | 논리 엣지 카탈로그 문서화(44줄) |
| `doc/plans/2026-11-27-stage26-two-graph.md` | 이 문서 (Wave 6 마지막 산출물) |

### Pillar 3 — 라우팅 가드 UI (`50ae245d`, `4b3180e7`, `61984852`)

| 파일 | 역할 |
|---|---|
| `ui/src/pages/workflows/ProblemFirstRoutingBanner.tsx` | 순수 `evaluateWorkflowRoutingGuard`(Q1 구조 제어 + Q2 multi-hop → single_agent/workflow_graph/data_graph_rag/two_graph, none/hint/caution) + 비차단 권고 배너 |
| `ui/src/pages/workflows/workflow-create-form.tsx` | 생성 폼에 배너 마운트 |
| `ui/src/pages/workflows/ProblemFirstRoutingBanner.test.tsx`, `workflow-create-form-routing.test.tsx` | 가드 평가·마운트 테스트 |

`data_graph_query` 에이전트 도구 등록은 아직 남아 있다(§4).

---

## 3. 핵심 불변식

1. **DB 테이블 0 신규**: Stage 26 전체 커밋(base 웨이브 + 이 브랜치 10커밋)이 `packages/db`를 전혀 건드리지 않는다(마이그레이션·뷰·물리 엣지 테이블 없음). 논리 그래프는 기존 FK/jsonb/배열 컬럼에서만 파생된다.
2. **company_id 스코프**: traversal 컨텍스트, GET/POST 라우트, 컨텍스트 팩, 도구 실행 전부 `companyId`를 강제한다. 에이전트 키는 타 회사 노드를 반환할 수 없다.
3. **2-hop 경계**: `maxHops`는 리터럴 1|2로 클램프되고 파라미터로 확장 불가하다. 노드 상한 ≤100, hop별 질의별 LIMIT, 초과 시 `truncated=true`.
4. **Fail-closed 구조적 권위 (AGENTS.md §5.9)**: 게이트는 `operator_decisions`의 `status`+`result` jsonb만 읽는다. pending→pause, resolved+approve→resume, reject/hold/빈 선택/result 누락/cancelled/미인식 상태→fail-closed rejected, expired→expired. 자연어·댓글·stdout 파싱은 어디에도 없다. 재개 권위는 구조 jsonb뿐이다.
5. **100% 역호환 (`graphApprovalRequired`)**: 기존 플래그 스텝은 저장 직렬화를 그대로 유지하고 읽기 시에만 `human_wait`로 논리 승격한다. `appendOptionalDataGraphContext`는 `enabled=false`(기본)일 때 기존 마크다운을 byte-for-byte 그대로 돌려준다.
6. **Zero prompt bloat**: 그래프 노드/fact가 0이면 컨텍스트 블록을 만들지 않는다. fact는 maxChars 예산 안의 온전한 라인만 포함하고 부분 절단하지 않는다. 비밀은 팩 sanitize 통과 결과만 렌더링한다.
7. **읽기 전용 데이터 그래프**: mutation이 없으므로 activity log 대상이 아니며, 기존 인덱스만 사용한다.

---

## 4. 남은 Wave 3d/6 live-wiring 체크리스트

구현된 모듈은 이미 있고, 다음 3개 연결 지점만 남아 있다. 각 작업은 `doc/SPEC-implementation.md` §5.7 영향 증명(호출부·테스트·라이브/DB 실증 표면)을 완료 조건에 포함한다.

- [ ] **`dag-engine.ts` 단일 진입점 연결 (Wave 3d)**: 스텝 실행 진입 1곳에서 `human_wait` 논리 클래스 스텝에 `evaluateHumanWaitGate`를 호출한다. verdict `pause`면 step run을 wake 큐에서 빼고 유지하고, `resume`이면 기존 `operator_decision_continuations`→wakeup 경로로 재개하고, `fail`이면 기존 실패 경로로 처리한다. 상태 필드가 아니라 결정 영수증이 권위다. 큐·run 의미론 보존과 이중 카드 0건을 격리 PG 통합 테스트로 증명한다.
- [ ] **`routes/workflows.ts` run 오버레이 마운트 (Wave 4 완결)**: run 오버레이 `stepRuns` 응답에 결정 조인 필드(`graphRunDecisionId`, decision 상태/시각/outcome)를 추가해 타임라인 `human_wait` 세그먼트가 실제 결정에 바인딩되게 한다. 신규 엔드포인트 없이 기존 응답 확장만 한다.
- [ ] **`core-tool-executor.ts` `data_graph_query` 등록 (Wave 6)**: builtin `adapterConfig.kind` 분기 하나를 추가해 `queryLogicalDataGraph` + 출처 컨텍스트 팩(`workflow-context-adapter`)을 실행한다. 읽기 전용, executor arg의 companyId만 사용, `tool_definitions` 시드로 등록하며 에이전트 그랜트 검증은 기존 `executeCoreWorkflowTool` 경로를 그대로 쓴다.

위 3개가 끝나면 "쿼리가 두 그래프를 잇는다"가 라이브로 닫히고, Wave 6 검증(`pnpm -r typecheck && pnpm test:run && pnpm build`)을 전체 변경본에 대해 다시 수행한다.
