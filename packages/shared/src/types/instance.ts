export interface LlmStructuredProvider {
  id: string;
  name: string;
  baseUrl: string;
  model?: string;
  readonly apiKeyConfigured: boolean;
}

export interface LlmStructuredConnectionTestResult {
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  models: string[];
  error?: string;
}

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  /** 판단(Jev) 엔드포인트 오버라이드. 미설정(undefined)이면 기본값 사용. */
  judgmentBaseUrl?: string;
  /** 판단(Jev) 모델 오버라이드. 미설정(undefined)이면 정의별 모델 사용. */
  judgmentModelId?: string;
  /** 판단(Jev) API 키 저장 여부(마스킹 플래그 — 원문 키는 어떤 응답에도 포함되지 않는다). */
  readonly judgmentApiKeyConfigured?: boolean;
  llmStructuredBaseUrl?: string;
  llmStructuredModel?: string;
  readonly llmStructuredApiKeyConfigured?: boolean;
  llmStructuredProviders?: LlmStructuredProvider[];
  llmStructuredDefaultProviderId?: string;
}

export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableHeartbeatFinalizationV1: boolean;
  /** [run-terminal-boundary v1] 종결 경계(원인 스탬프 결정·회복 게이트·권한 CAS·스코프 정지) 스위치. 기본 off. */
  enableRunTerminalBoundaryV1: boolean;
  /** [run-reopen-guard v1] 종결 run 재오픈 가드 — 재개는 상태 CAS + 권한버전 범프로만. 기본 off. */
  enableRunReopenGuardV1: boolean;
  /** [run-recovery-service v1] 종결 실행의 공식 복구(결정 1회 소비·권한버전 검증)를
   *  resume/감독 재시도/언블록 해결에 적용. 기본 off — off 면 PR-2a 가드 동작을 유지하고,
   *  서버는 reopenGuard 플래그와 함께 켜져 있을 때만 활성으로 판정한다. */
  enableRunRecoveryServiceV1: boolean;
  /** [work-product binding v1 — 스테이지 A] 도구 스텝의 workProducts 참조를 실행 단위로
   *  핀한다(재시도가 "현재 대표"를 재해석하지 않는다). 기본 off — off 면 기존 대표 우선
   *  재해석 경로 유지. 핀은 tool-step dispatch 경로(스텝런 신원 있는 곳)에만 적용되며
   *  condition-source/child-precheck 호출부는 스텝런 신원이 없어 이 단계에서 제외. */
  enableWorkProductBindingV1: boolean;
  /** [P2 측정 롤아웃] 사람 큐레이션 패턴 카드의 스텝 디스패치 주입 스위치. 기본 off = 주입 없음. */
  enableKnowledgePatternInjection: boolean;
  /** [qa-rebind recovery v1] QA 재바인드 자동 복구(전체). 기본 off. */
  enableQaRebindRecoveryV1: boolean;
  /** [qa-rebind recovery v1] 회사 단위 허용 목록. 기본 빈 목록. */
  enableQaRebindRecoveryCompanyIdsV1: string[];
  /** [workproduct selector-reject v1 — 소비 하드닝 4단계] selector 없는 타-단계 참조 소비의
   *  명시 거부(전체). 기본 off — off 면 폴백 핀 감사만 축적(fail-open). */
  enableWorkProductSelectorRejectV1: boolean;
  /** [workproduct selector-reject v1] 회사 단위 허용 목록. 기본 빈 목록. */
  enableWorkProductSelectorRejectCompanyIdsV1: string[];
  /** Broad search release by company, mission, or running agent (OR matching). Empty lists deny. */
  broadSearchAllowedCompanyIdsV1: string[];
  broadSearchAllowedMissionIdsV1: string[];
  broadSearchAllowedAgentIdsV1: string[];
  /** [stale-source wakeup v1] 주기 감독의 stale-source 자동 깨움(전체). 기본 off. */
  enableStaleSourceIssueWakeupV1: boolean;
  /** [stale-source wakeup v1] 미션 단위 허용 목록. 기본 빈 목록. */
  staleSourceIssueWakeupAllowedMissionIdsV1: string[];
  /** [resume review-relief v1] 실패 런 resume preview 의 보수 검토 차단 완화(전체). 기본 off. */
  enableResumeReviewReliefV1: boolean;
  /** [resume review-relief v1] 미션 단위 허용 목록. 기본 빈 목록. */
  resumeReviewReliefAllowedMissionIdsV1: string[];
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}

export type CliRuntimeId =
  | "pi"
  | "codex"
  | "claude"
  | "opencode"
  | "commandcode"
  | "antigravity"
  | "gemini"
  | "hermes"
  | "cursor";

export interface CliRuntimeStatus {
  id: CliRuntimeId;
  name: string;
  adapterType: string;
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  authConfigured: boolean;
  authSource?: string | null;
  modelCount: number;
  sampleModels: string[];
  supportsSelfUpdate: boolean;
  supportsModelUpdate: boolean;
  supportsProviderSync: boolean;
  /** npm registry 최신 버전(확인된 경우에만). 미확인이면 undefined/null. */
  latestVersion?: string | null;
  /** latestVersion > version (semver) 일 때 true. 확인 전/미지원이면 undefined. */
  updateAvailable?: boolean;
  error?: string;
}

export interface PiCliProviderStatus {
  id: string;
  baseUrl?: string;
  api?: string;
  modelCount: number;
  models: string[];
  authConfigured: boolean;
}

export interface PiCliStatusSnapshot {
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  agentDir: string;
  providers: PiCliProviderStatus[];
  catalogModels: string[];
  runtimes?: CliRuntimeStatus[];
  error?: string;
}

export interface PiCliActionResult {
  ok: boolean;
  action: "sync" | "update_self" | "update_models" | "update_cli" | "logout" | "refresh_models";
  message: string;
  status: PiCliStatusSnapshot;
}
