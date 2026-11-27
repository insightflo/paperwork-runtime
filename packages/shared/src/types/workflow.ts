import type { WorkflowConditionGroup } from "../validators/workflow-condition.js";
import type { WorkflowStepContract, WorkflowHumanWaitDecisionTemplate } from "../validators/workflow.js";

// decisionTemplate 프리셋 타입의 공개 경로 — UI 등 소비자는 types/workflow 서브패스로 읽는다.
// (index.ts 명시 export 목록 밖 추가 없이 서브패스 재수출만으로 공개한다.)
export type { WorkflowHumanWaitDecisionTemplate };

export type WorkflowDefinitionStatus = "active" | "paused" | "archived";
export type WorkflowExecutionMode = "static_dag" | "dynamic_owner_plan";
export type WorkflowTriggerSource = "manual" | "api" | "schedule" | "label" | string;
export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | string;
export type WorkflowStepRunStatus = "pending" | "running" | "completed" | "failed" | "skipped" | string;

export type WorkflowConditionalEdgeWhen =
  | "success"
  | "failure"
  | "qa_request_changes"
  | "always"
  | "condition_true"
  | "condition_false";

export interface WorkflowConditionalDependency {
  stepId: string;
  when?: WorkflowConditionalEdgeWhen;
  isBackEdge?: boolean;
  maxIterations?: number;
  allowCapAcceptance?: boolean;
}

export interface WorkflowStepDefinition {
  id: string;
  title?: string;
  name?: string;
  description?: string;
  dependsOn?: string[];
  dependencies?: string[];
  /**
   * workflow→workflow 자식 실행(n8n "Execute Workflow"). type:"workflow" 스텝이
   * 같은 회사의 대상 워크플로우를 실행한다. targetWorkflowId 는 type==="workflow" 일 때 필수,
   * wait 는 기본 true(자식 종말 대기), inputs 는 토큰 렌더 대상 문자열 인자(최대 20키).
   */
  targetWorkflowId?: string;
  /** [descope v1 D1] wait 는 생략(기본 true) 또는 true 만 허용 — false 는 검증에서 거부. */
  wait?: true;
  inputs?: Record<string, string>;
  conditionalDependencies?: WorkflowConditionalDependency[];
  type?: string;
  conditionGroup?: WorkflowConditionGroup;
  completionReason?: string;
  toolName?: string;
  toolArgs?: unknown;
  workProductSelectors?: import("../validators/workflow-artifact.js").WorkProductSelectors;
  toolArtifactContract?: import("../validators/workflow-artifact.js").ToolArtifactContract;
  qaConfig?: import("../validators/qa-config.js").QaConfig;
  deliveryVerification?: 'required';
  capAcceptance?: 'blocked';
  tools?: string[];
  toolNames?: string[];
  allowedSearchScopes?: string[];
  searchScopes?: string[];
  sessionMode?: string;
  onFailure?: string;
  escalateTo?: string;
  maxRetries?: number;
  triggerOn?: "normal" | "escalation" | string;
  timeoutSeconds?: number;
  dynamicChildren?: boolean | string;
  ownerPlanBootstrapOnly?: boolean | string;
  bootstrapOnly?: boolean | string;
  agentName?: string;
  agentId?: string;
  assigneeAgentId?: string;
  /**
   * 이 step이 파일 산출물(workProduct)을 생산하는지.
   * true면 dag-engine이 출력 디렉토리 + `[ARTIFACT]:` 등록 contract를 issue에 주입하고
   * heartbeat가 missing-workProduct 자동등록 gate를 적용한다.
   * false는 "QA 단계"를 뜻하지 않는다 — 단지 산출물 contract 강제를 안 할 뿐. verdict는 별개.
   * (UI graphWorkProductRequired 토글과 동일 필드.)
   */
  graphRetryDelaySeconds?: number;
  graphRetryBackoff?: "fixed" | "linear" | "exponential";
  graphRetryJitter?: boolean;
  graphWorkProductRequired?: boolean;
  graphWorkProductPattern?: string;
  graphResourceRefs?: string[];
  graphSecretRefs?: string[];
  /**
   * 스텝 발주 계약 — 사전조건/사후조건/미정의동작 구조 레코드(정의 시점 작성).
   * 발주 시 이슈 지침·이슈 실행카드·QA 루브릭에 전달된다. 실행 통제 권위는 아니다(규칙 8).
   */
  contract?: WorkflowStepContract;
  /**
   * Stage 26 human_wait 결정 프리셋 — 스텝이 사람 승인 대기(human_wait 논리 클래스 또는
   * 레거시 graphApprovalRequired 플래그)로 materialize 될 때 operator decision 카드 구성을
   * 정의 시점에 선언한다. 프리셋 메타데이터일 뿐 실행 권위는 아니다(규칙 8 — 결정 권위는
   * operator_decisions.result 구조화 값에만 있다).
   */
  decisionTemplate?: WorkflowHumanWaitDecisionTemplate;
}

/**
 * [purpose] Stage 26 Two-Graph 노드 3 유형(function / ai_agent / human_wait)의 논리 클래스.
 * 기존 5 draft 타입(agent/tool/if/complete/workflow)을 파괴하지 않는 capability 오버레이다.
 * [care] Wave 1 은 공유 어휘만 제공한다 — dag-engine 실행 스위치 연결은 Wave 3 이다.
 * 열린 문자열 type 유지(역호환)를 위해 닫힌 WorkflowStepType 유니언을 도입하지 않는다.
 */
export type WorkflowLogicalNodeClass = "function" | "ai_agent" | "human_wait";

export interface WorkflowStepLogicalClassSource {
  type?: string;
  decisionTemplate?: WorkflowHumanWaitDecisionTemplate;
  /**
   * 레거시 사람 승인 플래그(graphApproval* 계열, 검증기 passthrough 필드).
   * true/"true" 면 읽기 시 human_wait 로 논리 승격한다. 저장 직렬화는 기존 플래그를 유지한다(역호환).
   */
  graphApprovalRequired?: boolean | string;
}

/**
 * 스텝 정의의 논리 노드 클래스를 계산한다.
 * human_wait 판정 우선순위: 명시 type === "human_wait" > decisionTemplate 존재 >
 * 레거시 graphApprovalRequired 플래그. 나머지는 기존 정규화 관례(tool/if/complete=function,
 * agent/workflow 및 미지정 타입=ai_agent)를 따른다.
 */
export function resolveStepLogicalClass(
  step: WorkflowStepLogicalClassSource | null | undefined,
): WorkflowLogicalNodeClass {
  if (!step) return "ai_agent";
  const nodeType = typeof step.type === "string" ? step.type : undefined;
  if (nodeType === "human_wait") return "human_wait";
  if (step.decisionTemplate !== undefined) return "human_wait";
  if (step.graphApprovalRequired === true || step.graphApprovalRequired === "true") return "human_wait";
  if (nodeType === "tool" || nodeType === "if" || nodeType === "complete") return "function";
  return "ai_agent";
}

export interface WorkflowDefinitionDto {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  status: WorkflowDefinitionStatus | string;
  steps: WorkflowStepDefinition[];
  schedule: string | null;
  timezone: string | null;
  deadlineTime: string | null;
  lastScheduledRunAt: string | null;
  lastScheduleError: string | null;
  lastScheduleErrorAt: string | null;
  timeoutMinutes: number | null;
  maxDailyRuns: number | null;
  maxConcurrentRuns: number | null;
  triggerLabels: string[];
  labelIds: string[];
  projectId: string | null;
  goalId: string | null;
  createParentIssuePolicy: string | null;
  executionMode: WorkflowExecutionMode | string | null;
  dynamicPlanBootstrapOnly: boolean;
  source: string | null;
  sourceKind: string | null;
  legacyPluginEntityId: string | null;
  legacyMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunDto {
  id: string;
  workflowId: string;
  companyId: string;
  missionId: string | null;
  status: WorkflowRunStatus;
  originalStatus: string | null;
  triggeredBy: string;
  triggerSource: WorkflowTriggerSource | null;
  runDate: string | null;
  runNumber: number | null;
  runLabel: string | null;
  parentIssueId: string | null;
  parentRunId: string | null;
  parentStepRunId: string | null;
  rootRunId: string | null;
  scheduledSlotId: string | null;
  legacyPluginRunEntityId: string | null;
  metadata: Record<string, unknown>;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface WorkflowStepRunDto {
  id: string;
  workflowRunId: string;
  stepId: string;
  issueId: string | null;
  status: WorkflowStepRunStatus;
  originalStatus: string | null;
  agentName: string | null;
  retryCount: number;
  sessionId: string | null;
  lastDispatchAttemptAt: string | null;
  lastDispatchAcceptedAt: string | null;
  lastDispatchErrorAt: string | null;
  lastDispatchErrorSummary: string | null;
  lastDispatchRequestId: string | null;
  legacyPluginStepEntityId: string | null;
  metadata: Record<string, unknown>;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkflowRunSlotDto {
  id: string;
  workflowDefinitionId: string;
  companyId: string;
  triggerSource: WorkflowTriggerSource;
  scheduledAt: string;
  runDate: string | null;
  timezone: string | null;
  claimedAt: string;
  status: "claimed" | "run_created" | "skipped" | "failed" | "cancelled" | string;
  metadata: Record<string, unknown>;
}
