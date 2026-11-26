/**
 * [파일 목적] Task6a resume preview 의 검토된(resumed) 정책 불변 매니페스트 경계.
 *   검토 완료된 (company, definitionHash) 조합에 대해서만 step effect / tool binding /
 *   required gate / publication / generation 매핑을 선언한다.
 * [불변식]
 *   - 이 레지스트리는 사람 검토 결과의 컴파일 타임 불변 매니페스트다. client 입력, DB JSON,
 *     prose, env, 도구 이름 allowlist 로 policy 를 공급하는 경로는 존재하지 않는다.
 *   - 각 엔트리에는 검토 근거(원본 정의 식별·도구 실제 동작 요약·바인딩 채취 방법·날짜)를
 *     헤더 주석으로 남겨야 한다. 근거 주석 없는 엔트리는 계약 위반이다.
 *   - toolBindings 는 "검토 시점의" registry 행 정확 참조(id/updatedAt ISO/configHash)다.
 *     configHash 는 hashStructuredValue({name,enabled,adapterType,adapterConfig,inputSchema})
 *     이며, preview-policy 가 현재 DB registry 행과 대조한다. 이름만 같고 설정이 다른 행은
 *     resolve 되지 않는다(도구 효과 추론 금지).
 *   - 매칭 키(2026-11-15 확장): definitionHash 는 해시 payload 에 workflowRunId·provenance 가
 *     포함되어 run 마다 유일하다(동일 steps 라도 run 이 다르면 해시가 다르다 — 2026-11-15
 *     실증). 그래서 exact definitionHash 엔트리는 그 run 하나에만 적용된다. stepsHash 를
 *     선언한 엔트리는 resumeStepsHash({executionMode, steps}) 로 동일 그래프 형태의 모든
 *     run 에 적용된다(스텝 바이트가 바뀌면 해시가 바뀌어 자동 미매치 — 그래프 표류 보호,
 *     도구 표류는 toolBindings 가 보호). (companyId, stepsHash) 는 유일해야 한다.
 *   - 이 파일의 로직은 없다 — 데이터 경계만 있다. 검토 없이 배열을 채우는 것은
 *     이 레지스트리의 계약 위반이다.
 * [수정시 주의] schemaVersion 은 1 고정. steps 의 key 는 frozen definition 의 stepId 다.
 */

export interface ReviewedResumePolicyToolBinding {
  id: string;
  updatedAt: string;
  configHash: string;
}

export interface ReviewedResumePolicyStep {
  effect: "none" | "read_only" | "external";
  toolBindings: ReviewedResumePolicyToolBinding[];
}

export interface ReviewedResumePolicy {
  schemaVersion: 1;
  companyId: string;
  /** 검토 근거가 된 대표 run 의 frozen definition_hash(run 고유) — provenance 키. */
  definitionHash: string;
  /** 안정 매칭 키(선택) — preview-policy.resumeStepsHash({executionMode, steps}) 값.
 *     동일 그래프 형태의 모든 run 에 정책이 적용된다. 선언 시 (companyId, stepsHash) 유일. */
  stepsHash?: string;
  steps: Record<string, ReviewedResumePolicyStep>;
  requiredGateStepIds: string[];
  publicationStepIds: string[];
  generationStepIds: string[];
}

/**
 * [현재 상태] 2026-10-22 youtube-report 검토 정책, 2026-10-23 dsh-purge PAQO 정책에 이어
 *   2026-11-15 service-onboarding / agent-team-concept-radar / youtube-report(현행 형태)
 *   초안 3건이 추가됐다(에이전트 증거 수집 초안 → **2026-11-16 사용자 최종 승인**, 각 헤더 참조).
 *   2026-11-15 확장으로 기존 2건에 stepsHash 가 추가됐다(동일 그래프 형태의 다른 run 도
 *   재개 가능하게 — 매칭 규칙은 파일 헤더 참조). 각 엔트리의 헤더 주석이 검토 근거(원본 정의·
 *   도구 실제 동작·바인딩 채취 방법·날짜)이며, 근거 없는 엔트리 추가는 이 레지스트리의
 *   계약 위반이다.
 *  [운영 주의] toolBindings 는 검토 시점 registry 행의 정확한 참조다. 해당 tool_definitions 행의
 *   enabled/updatedAt/설정(adapterConfig·inputSchema)이 바뀌면 bindingResolves 가 실패해 그
 *   스텝 effect 는 unknown 으로 되돌아가고(external_effect_unknown 재발) 정책은 자동 무효화된다.
 *   이는 의도된 fail-closed 동작이며, 도구 변경 후에는 이 매니페스트를 다시 검토·갱신해야 한다.
 *   바인딩 채취·현재 registry 대조 검증은 scripts/resume-policy-bindings.ts (collect/verify) 로 한다.
 */
export const REVIEWED_RESUME_POLICIES: readonly ReviewedResumePolicy[] = [
  /**
   * [검토 근거 — 2026-10-22] 원본 정의: workflow_definitions 006d48fe-c6b1-4161-8679-e9894a0c6ca8
   *   (youtube-report, updated 2026-10-17). 검토 대상 스냅샷: workflow_run_definitions run
   *   8305cef9-1ae8-4a9e-bb72-67e9a2f9be49 (definition_hash 아래, captured 2026-10-21, static_dag,
   *   9스텝). 스텝 효과는 frozen 스텝 서술·adapter_config·A1 실행 스크립트로 확인했다.
   *   - collect-youtube-evidence (http→n8n youtube-source-evidence): 유튜브 자막/Gemini 요약을
   *     읽어 artifact 를 런타임 워크스페이스에 저장. 외부 쓰기 없음 → read_only.
   *   - summarize-select-scenes (agent): 등록된 youtube-source-evidence.json 만 읽고 scene plan
   *     산출물 등록(스텝 서술 "입력: 등록된 youtube-source-evidence.json만 사용") → none.
   *   - stage-youtube-video (http→n8n stage-youtube-video): 영상 다운로드 후 A1 호스트 stagedPath
   *     파일 기록(응답 계약 bytes/stagedPath existingFile). 워크스페이스 밖 지속 쓰기 → external.
   *   - capture-youtube-frames (builtin python capture.py): staged 캐시 우선, 없으면 yt-dlp 직접
   *     다운로드(외부 읽기). frames/manifest 는 output-dir(워크스페이스)에만 기록 → read_only.
   *   - build-youtube-report-content (agent, report-for-beginners): 내부 산출물 입력 + "채널 정보는
   *     원본 영상 oEmbed에서 확인"(외부 읽기). content.json/assets 산출, 발행 없음 → read_only.
   *   - validate-youtube-report-content (agent QA): 등록된 content.json 대조 검증, PASS/
   *     REQUEST_CHANGES 반환, "발행 도구를 호출하지 않는다" → none.
   *   - qa-youtube-report-content (builtin manual-onboarding-qa.mjs qa): 등록 HTML 기계 검사,
   *     결과 JSON 을 워크스페이스에 기록. 외부 쓰기 없음 → none. 발행 직전 기계 게이트이므로
   *     requiredGateStepIds 에 등록(재개가 이 게이트를 건너뛰는 것을 금지).
   *   - publish-onboarding-manual (builtin manual-onboarding-publish): Cloudflare API 토큰·D1·
   *     사이트 루트(/srv/manual-onboarding-app)로 외부 발행 → external + publicationStepIds.
   *   - verify-onboarding-manual-publish (builtin manual-onboarding-verify): 공개 상태
   *     publicDetailStatus 200/indexHasEntry 확인 읽기 → read_only.
   *   generationStepIds: 새 콘텐츠/이미지를 산출하는 스텝(장면 구성·프레임 추출·보고서 초안).
   *     validate 는 판정만 반환하므로 제외했다.
   * [바인딩 채취] 2026-10-22 A1(127.0.0.1:54329 paperclip)에서 배포 런타임의
   *   hashStructuredValue({name,enabled,adapterType,adapterConfig,inputSchema}) 와 postgres.js
   *   updatedAt.toISOString() 로 계산. registry 행이 이 시점과 같아야 binding 이 resolve 된다.
   *   [2026-11-15 stepsHash 추가] scripts/resume-policy-bindings.ts steps-hash --run 8305cef9…
   *   로 계산(34960e17…). 동일 형태 run(예: 실패 6620094a, 2026-11-15)도 이 정책으로 재개된다.
   *   같은 날 verify 로 전 바인딩이 현재 registry 와 일치함을 재확인했다.
   *   [2026-11-26 바인딩 재채취] showk.ing → insightflo.si 도메인 이전 및 inputSchema PATCH
   *   반영(사용자 승인): collect-youtube-source-evidence(6090651e)·stage-youtube-video(84d0ca94)
   *   updatedAt/configHash 갱신(effect 불변).
   */
  {
    schemaVersion: 1,
    companyId: "ff3e3efd-e30c-45c2-b893-497164405629",
    definitionHash: "d0b3eca4019e01d75ef97661351f6a9e03954eb585c0e610d71b69d8bf9a97c6",
    stepsHash: "34960e17005591437057a0f1399f94226f99212d0b77f6cd70a8f7ab5d903411",
    steps: {
      "collect-youtube-evidence": {
        effect: "read_only",
        toolBindings: [{
          id: "6090651e-f710-4c53-b874-2706a083bccd",
          updatedAt: "2026-11-26T03:58:10.820Z",
          configHash: "09e50e670033688ef93ec4c57af18dbda183fca25807866e1e3eb7bffd311482",
        }],
      },
      "summarize-select-scenes": { effect: "none", toolBindings: [] },
      "stage-youtube-video": {
        effect: "external",
        toolBindings: [{
          id: "84d0ca94-6b26-4903-995a-4292e62f5dcf",
          updatedAt: "2026-11-26T03:58:10.866Z",
          configHash: "65e3e4ae45fd3a8281a6c92d6b3e086e11dd9278d5c1295efe6225e3e38d012d",
        }],
      },
      "capture-youtube-frames": {
        effect: "read_only",
        toolBindings: [{
          id: "1238c3f7-7bba-4f85-ba02-4dec3519e14b",
          updatedAt: "2026-08-28T13:12:54.623Z",
          configHash: "af15397063aa980988491878739bb90b8a53a43fbb9cbb4b03f5ae57f9f8f3c8",
        }],
      },
      "build-youtube-report-content": { effect: "read_only", toolBindings: [] },
      "validate-youtube-report-content": { effect: "none", toolBindings: [] },
      "qa-youtube-report-content": {
        effect: "none",
        toolBindings: [{
          id: "9512da2f-46af-4ddb-86e4-21bd1c152094",
          updatedAt: "2026-10-02T00:02:12.308Z",
          configHash: "91be83e8546bf63c2b11c37873d6f0b5b7940f60e3ea02748b300f0822473f50",
        }],
      },
      "publish-onboarding-manual": {
        effect: "external",
        toolBindings: [{
          id: "db36b402-5e7c-4efe-a6d9-ee9bfa1fde43",
          updatedAt: "2026-10-03T07:21:49.187Z",
          configHash: "ec9bd5eda6af5c3e6db2c2f342e4899290f00cebf2d62b05c1056488589cb993",
        }],
      },
      "verify-onboarding-manual-publish": {
        effect: "read_only",
        toolBindings: [{
          id: "2523e587-77a8-4a93-ba2f-b1cac07bb777",
          updatedAt: "2026-10-02T00:02:12.723Z",
          configHash: "4f16e4ad1884ae70782afe12baf91075e066cef41187ef2fe373c5e16504eb3d",
        }],
      },
    },
    requiredGateStepIds: ["qa-youtube-report-content"],
    publicationStepIds: ["publish-onboarding-manual"],
    generationStepIds: [
      "summarize-select-scenes",
      "capture-youtube-frames",
      "build-youtube-report-content",
    ],
  },
  /**
   * [검토 근거 — 2026-10-23] 원본 정의: workflow_definitions 069c62ab-ad12-448a-87d8-521b1bb32237
   *   (dsh-purge 수정 미션 PAQO 실행 정의, 2026-10-21 생성). 검토 대상 스냅샷: workflow_run_definitions
   *   run 9c6cf35d-0878-4b59-a2ba-d4670988ddfe (definition_hash 아래, captured 2026-10-22T09:30:24Z,
   *   6스텝). 스텝 효과는 frozen 스텝 서술·도구 계약·위 youtube-report 검토(동일 builtin 도구)로 확인했다.
   *   - action-1-4ae1f74ba7 (agent, 보존 초안 완성·보안 사전점검 증거 재등록): 보존 산출물 상속·
   *     내부 산출물/증거 등록만 수행, 외부 쓰기 없음 → none.
   *   - qa-2-cd874c856d (agent QA, F1 해소 검증·회귀 재검토): 등록 산출물 대조 검증 → none.
   *   - qa-3-bb9e492d5f (builtin manual-onboarding-qa): 등록 본문 기계 검사, 결과 JSON 을
   *     워크스페이스에 기록. 외부 쓰기 없음 → none. [2026-10-23 정정] requiredGateStepIds 에서
   *     제외한다 — 이 정의는 선형 사슬이라 게이트 이전(action-1/qa-2)에서 시작하는 재개는 항상
   *     qa-3 를 포함하고, 게이트 이후(publish/verify)만 재개하는 경우는 이미 qa-3 를 통과한
   *     동일 본문을 보존하는 경로뿐이다(게이트 우회 경로가 존재하지 않는다). 등록 시 게이트가
   *     보존 집합에 들어가 verify 단독 재개가 required_gate_bypass 로 전부 차단되는 오류를 바로잡는다.
   *   - action-4-64dcc548f7 (builtin manual-onboarding-publish): CMS manuals 섹션 외부 발행 →
   *     external + publicationStepIds.
   *   - qa-5-a57c357b38 (builtin manual-onboarding-verify): 공개 상태 readback 확인 읽기 → read_only.
   *   - qa-e4612efd83 (agent QA, Verify mission result): 판정만 반환 → none.
   *   generationStepIds: 새 초안/증거를 산출하는 action-1 만. 검증 스텝은 제외.
   * [바인딩 채취] 도구는 youtube-report 검토(2026-10-22)와 같은 회사 tool_definitions 행 3건이며
   *   2026-10-23 A1 실측으로 updated_at 불변 확인(qa 9512da2f 2026-10-02T00:02:12.308Z,
   *   publish db36b402 2026-10-03T07:21:49.187Z, verify 2523e587 2026-10-02T00:02:12.723Z) —
   *   configHash 는 동일 검토 시점 값을 재사용한다(행 불변). 행이 바뀌면 binding 이 자동 무효화된다.
   *   [2026-11-15 stepsHash 추가] scripts/resume-policy-bindings.ts steps-hash --run 9c6cf35d…
   *   로 계산(0ad558dc…). 같은 날 verify 로 바인딩 3건 모두 현재 registry 와 일치함을 재확인했다.
   */
  {
    schemaVersion: 1,
    companyId: "ff3e3efd-e30c-45c2-b893-497164405629",
    definitionHash: "d57fd45e6eb9d7aeee24d2742f0a2a3a09f7d8d4d988abe2681b610addce42bb",
    stepsHash: "0ad558dcdc213ae6014c11eb14facb4ed2c4ceb53c1104082188ff284a7e7542",
    steps: {
      "action-1-4ae1f74ba7": { effect: "none", toolBindings: [] },
      "qa-2-cd874c856d": { effect: "none", toolBindings: [] },
      "qa-3-bb9e492d5f": {
        effect: "none",
        toolBindings: [{
          id: "9512da2f-46af-4ddb-86e4-21bd1c152094",
          updatedAt: "2026-10-02T00:02:12.308Z",
          configHash: "91be83e8546bf63c2b11c37873d6f0b5b7940f60e3ea02748b300f0822473f50",
        }],
      },
      "action-4-64dcc548f7": {
        effect: "external",
        toolBindings: [{
          id: "db36b402-5e7c-4efe-a6d9-ee9bfa1fde43",
          updatedAt: "2026-10-03T07:21:49.187Z",
          configHash: "ec9bd5eda6af5c3e6db2c2f342e4899290f00cebf2d62b05c1056488589cb993",
        }],
      },
      "qa-5-a57c357b38": {
        effect: "read_only",
        toolBindings: [{
          id: "2523e587-77a8-4a93-ba2f-b1cac07bb777",
          updatedAt: "2026-10-02T00:02:12.723Z",
          configHash: "4f16e4ad1884ae70782afe12baf91075e066cef41187ef2fe373c5e16504eb3d",
        }],
      },
      "qa-e4612efd83": { effect: "none", toolBindings: [] },
    },
    requiredGateStepIds: [],
    publicationStepIds: ["action-4-64dcc548f7"],
    generationStepIds: ["action-1-4ae1f74ba7"],
  },
  /**
   * [검토 근거 — 2026-11-15 초안(에이전트 증거 수집) → 2026-11-16 사람 최종 승인] 원본 정의:
   *   workflow_definitions 56362d74-9c8f-482b-b766-b76bd3fe4ba1 (service-onboarding,
   *   updated 2026-11-07 12:22). 검토 대상 스냅샷: workflow_run_definitions run
   *   ad0eaa12-b39e-4f0d-953d-26e8600d6722 (stepsHash 아래, 9스텝). 2026-11-09~15 실패 8건
   *   전부와 최신 완료 run(05bb0cb8, 90d19824)이 동일 stepsHash 다(그래프 형태 동일 실증).
   *   스텝 효과는 frozen 스텝 서술·adapter_config·A1 실행 스크립트로 확인했다.
   *   - collect-service-source (http→scrapling.showk.ing dynamic-fetch): A1 /srv/inflo-scrapling/
   *     current/app.py fetch_dynamic — 대상 URL 브라우저 렌더 후 HTML 추출 응답(외부 읽기).
   *     진행 콜백 POST는 /crawl 전용. 외부 쓰기 없음 → read_only.
   *   - collect-repo-meta (builtin repo_meta.py): 스크립트 헤더 명시 "읽기 전용: 공개 API
   *     GET만 호출". 산출물(repo-meta.json·이미지)은 $PAPERCLIP_STEP_OUTPUT_DIR(워크스페이스) →
   *     read_only.
   *   - analyze-service-profile (agent): 등록 산출물 입력 + "허용된 공식 범위에서만 보충 자료
   *     최대 4개 저장"(외부 공식 소스 읽기). service-profile.json 산출, 발행 없음 → read_only.
   *   - build-service-report-content (agent): 등록 산출물+repo-meta 입력, "발행하지 않는다"
   *     명시. 저장소 코드 참조 가능(외부 읽기 가능) → read_only.
   *   - prescreen-service-content (builtin judgment): LLM 추론 provider 호출(외부 읽기) 후
   *     judgment-result.json 을 스텝 출력 디렉터리에 저장(agent-judgment-tool-executor.ts) →
   *     read_only.
   *   - validate-service-report-content (agent): 등록 산출물 대조 검증, 판정만 반환 → none.
   *   - qa-service-report-content (builtin manual-onboarding-qa): 2026-10-22 youtube 검토와
   *     동일 도구·동일 행 — 등록 본문 기계 검사, 결과 JSON 워크스페이스 기록 → none.
   *   - publish-onboarding-manual (builtin manual-onboarding-publish): CMS(Cloudflare D1)
   *     manuals 섹션 발행 → external + publicationStepIds.
   *   - verify-onboarding-manual-publish (builtin manual-onboarding-verify): 공개 상태
   *     readback 확인 읽기 → read_only.
   *   generationStepIds: analyze(프로필 초안)·build(ContentV1)만. 수집·검증·발행 제외.
   *   requiredGateStepIds 비움: dsh-purge 2026-10-23 정정과 동일 논리 — 게이트(qa) 이전
   *   재개는 선형 하류라 항상 qa 를 포함하고, 게이트 이후(publish/verify) 재개는 이미 qa 를
   *     통과한 동일 본문을 outside-predecessor 증거 검증으로 보존하는 경로뿐이다.
   *     (사람 최종 검토 확인 항목 — 게이트 REQUIRED 선호 시 youtube 2026-10-22 방식으로 전환.)
   * [바인딩 채취] 2026-11-15 scripts/resume-policy-bindings.ts collect --company ff3e3efd…
   *   --names … 로 live DB 에서 채취(id/updatedAt/configHash 아래). qa·publish·verify 는
   *   youtube 검토와 동일 행·불변(2026-11-15 verify 재확인).
   *   [2026-11-26 바인딩 재채취] showk.ing → insightflo.si 도메인 이전 및 inputSchema PATCH
   *   반영(사용자 승인): scrapling-dynamic-fetch(0bf67156) updatedAt/configHash 갱신(effect 불변).
   */
  {
    schemaVersion: 1,
    companyId: "ff3e3efd-e30c-45c2-b893-497164405629",
    definitionHash: "83e6b5495464417c80d0ef49b95dad4ba9bec2a2df9c437f1849cc85a90d6219",
    stepsHash: "53e4efaed26ec6c0234a026375b35e8eca4c7a55029dec16c0263747da161c8a",
    steps: {
      "collect-service-source": {
        effect: "read_only",
        toolBindings: [{
          id: "0bf67156-a04b-4ecb-bc1e-15e33b2cdc3a",
          updatedAt: "2026-11-26T00:56:06.348Z",
          configHash: "1410265ff1d637749e0948cecc57fe5b6dec134c7ca529f86b1b8d010ce6db0d",
        }],
      },
      "collect-repo-meta": {
        effect: "read_only",
        toolBindings: [{
          id: "22ee6c4c-d677-473e-8756-84118d9abcf2",
          updatedAt: "2026-08-30T14:28:37.457Z",
          configHash: "bc4c286a2d58222abaeac444dae25b8756073a1880ed772c63a54b39d1cb75c8",
        }],
      },
      "analyze-service-profile": { effect: "read_only", toolBindings: [] },
      "build-service-report-content": { effect: "read_only", toolBindings: [] },
      "prescreen-service-content": {
        effect: "read_only",
        toolBindings: [{
          id: "c7073d55-8b75-4343-ab84-9608530c6c07",
          updatedAt: "2026-09-18T10:37:12.079Z",
          configHash: "cd843e46a7696c078103d9f3948635f14132f09777c96ced110f964b9aabcf2f",
        }],
      },
      "validate-service-report-content": { effect: "none", toolBindings: [] },
      "qa-service-report-content": {
        effect: "none",
        toolBindings: [{
          id: "9512da2f-46af-4ddb-86e4-21bd1c152094",
          updatedAt: "2026-10-02T00:02:12.308Z",
          configHash: "91be83e8546bf63c2b11c37873d6f0b5b7940f60e3ea02748b300f0822473f50",
        }],
      },
      "publish-onboarding-manual": {
        effect: "external",
        toolBindings: [{
          id: "db36b402-5e7c-4efe-a6d9-ee9bfa1fde43",
          updatedAt: "2026-10-03T07:21:49.187Z",
          configHash: "ec9bd5eda6af5c3e6db2c2f342e4899290f00cebf2d62b05c1056488589cb993",
        }],
      },
      "verify-onboarding-manual-publish": {
        effect: "read_only",
        toolBindings: [{
          id: "2523e587-77a8-4a93-ba2f-b1cac07bb777",
          updatedAt: "2026-10-02T00:02:12.723Z",
          configHash: "4f16e4ad1884ae70782afe12baf91075e066cef41187ef2fe373c5e16504eb3d",
        }],
      },
    },
    requiredGateStepIds: [],
    publicationStepIds: ["publish-onboarding-manual"],
    generationStepIds: ["analyze-service-profile", "build-service-report-content"],
  },
  /**
   * [검토 근거 — 2026-11-15 초안(에이전트 증거 수집) → 2026-11-16 사람 최종 승인
   *   (n8n 원장 저장 여부는 2026-11-16 n8n API 실확인 완료 — 지속 저장 노드 없음이
   *   확인돼 두 수집 스텝을 external→read_only 로 강등)] 원본 정의:
   *   workflow_definitions 6fa3f267-d00e-44d9-959d-bd161d1c4aeb (agent-team-concept-radar,
   *   updated 2026-11-14 20:00). 검토 대상 스냅샷: workflow_run_definitions run
   *   6583e8a0-362d-4636-b6bf-4b523c13944f (stepsHash 아래, 14스텝). 실패 2건(6583e8a0,
   *   f08ed7ec)·완료 run·정의 11-14 업데이트 후 최신 run(01495532)까지 전부 동일 stepsHash 다.
   *   - collect-arxiv-candidates (http→n8n research-ai-news): 2026-11-16 n8n API
   *     (n8n-auto.showk.ing) 실확인 — 워크플로 "Papercompany - AI News Collect Research
   *     HTTP"(id Q97v6kp5C2ktLyGA) 전 노드가 code/httpRequest/webhook/respondToWebhook
   *     뿐이고 지속 저장 노드(파일·DB·시트 등) 없음. httpRequest 는 전부 외부 fetch(읽기)
   *     → read_only.
   *   - scout-social-ai-concepts (http→n8n normalize-ai-news-ledger): 동일 실확인 —
   *     워크플로 "Papercompany - AI News Normalize HTTP"(id OormEIESe7UVi4GD)도 지속
   *     저장 노드 없음. 도구명 'ledger' 는 응답 아티팩트(normalized_news_ledger.json)를
   *     가리키며 n8n 측 원장 저장 없음 → read_only.
   *   - select-novel-concept (agent): "전체 라이브 concepts 카탈로그" 외부 읽기 +
   *     topic-decision.json 산출 → read_only.
   *   - validate-novelty-decision (agent): 등록 번들 + 라이브 카탈로그 대조 검증(외부 읽기) →
   *     read_only.
   *   - if-has-selected-topic (control, if): conditionGroup 이 등록 work product JSON 만 읽는다 →
   *     none.
   *   - complete-no-novel-topic (control, complete): completionReason 만 → none.
   *   - research-selected-concept (agent): "선정 컨셉의 canonical 일차 소스를 읽는다"(외부
   *     읽기) + evidence.md 산출 → read_only.
   *   - draft-beginner-concept (agent): "등록된 evidence.md와 결정 아티팩트만 사용" → none.
   *   - validate-concept-content (agent): 등록 산출물 대조 검증 → none.
   *   - build-concept-content (agent): 등록 결정·concept.md·evidence.md 입력으로 content.json+
   *     assets 산출, 발행 없음 → none.
   *   - validate-concept-contentv1 (agent): 등록 산출물 대조 검증 → none.
   *   - qa-concept-content (builtin manual-onboarding-qa): 기계 QA 게이트, 결과 JSON
   *     워크스페이스 기록 → none(게이트 등록 여부는 아래 비움 참조).
   *   - publish-concept-conditionally (builtin manual-onboarding-publish): CMS concepts 섹션
   *     발행 → external + publicationStepIds.
   *   - verify-concept-conditionally (builtin manual-onboarding-verify): readback 확인 읽기 →
   *     read_only.
   *   generationStepIds: topic-decision·evidence.md·concept.md·content.json 을 산출하는 4개
   *     agent 스텝. 수집·검증·분기·발행 제외.
   *   requiredGateStepIds 비움: service-onboarding 초안과 동일한 dsh-purge 2026-10-23 정정
   *     논리(선형 하류라 게이트 이전 재개는 항상 qa 포함, 게이트 이후 재개는 통과 본문 보존
   *     경로뿐). complete-no-novel-topic 분기는 발행 경로가 아니므로 우회 경로가 아니다.
   * [바인딩 채취] 2026-11-15 scripts/resume-policy-bindings.ts collect 로 live DB 에서 채취.
   *   qa·publish·verify 는 youtube 검토와 동일 행·불변(2026-11-15 verify 재확인).
   *   [2026-11-26 바인딩 재채취] showk.ing → insightflo.si 도메인 이전 및 inputSchema PATCH
   *   반영(사용자 승인): collect-ai-research-open-source(169487ee)·normalize-ai-news-ledger(25335ed4)
   *   updatedAt/configHash 갱신(effect 불변).
   */
  {
    schemaVersion: 1,
    companyId: "ff3e3efd-e30c-45c2-b893-497164405629",
    definitionHash: "fb64f39784df1b5152b90b070158c1b10b70887426f728386dcb725527a3360d",
    stepsHash: "3e9719e40d6f3cbd39bb08adf9e7ebb6771f92c4335e3579b11a1c362c4cc15f",
    steps: {
      "collect-arxiv-candidates": {
        effect: "read_only",
        toolBindings: [{
          id: "169487ee-e55b-4b4f-9fb6-7c2c6663a07c",
          updatedAt: "2026-11-26T03:51:05.683Z",
          configHash: "b67feaf36285981122578b43cb67ae165124aa71f93eff82e82aef7439dd5f56",
        }],
      },
      "scout-social-ai-concepts": {
        effect: "read_only",
        toolBindings: [{
          id: "25335ed4-64fa-4538-88a4-001aff9f3901",
          updatedAt: "2026-11-26T00:19:48.416Z",
          configHash: "44d1294dab52f58eb64a491f111bca4d420a9a734659623f58102b2827d32f29",
        }],
      },
      "select-novel-concept": { effect: "read_only", toolBindings: [] },
      "validate-novelty-decision": { effect: "read_only", toolBindings: [] },
      "if-has-selected-topic": { effect: "none", toolBindings: [] },
      "complete-no-novel-topic": { effect: "none", toolBindings: [] },
      "research-selected-concept": { effect: "read_only", toolBindings: [] },
      "draft-beginner-concept": { effect: "none", toolBindings: [] },
      "validate-concept-content": { effect: "none", toolBindings: [] },
      "build-concept-content": { effect: "none", toolBindings: [] },
      "validate-concept-contentv1": { effect: "none", toolBindings: [] },
      "qa-concept-content": {
        effect: "none",
        toolBindings: [{
          id: "9512da2f-46af-4ddb-86e4-21bd1c152094",
          updatedAt: "2026-10-02T00:02:12.308Z",
          configHash: "91be83e8546bf63c2b11c37873d6f0b5b7940f60e3ea02748b300f0822473f50",
        }],
      },
      "publish-concept-conditionally": {
        effect: "external",
        toolBindings: [{
          id: "db36b402-5e7c-4efe-a6d9-ee9bfa1fde43",
          updatedAt: "2026-10-03T07:21:49.187Z",
          configHash: "ec9bd5eda6af5c3e6db2c2f342e4899290f00cebf2d62b05c1056488589cb993",
        }],
      },
      "verify-concept-conditionally": {
        effect: "read_only",
        toolBindings: [{
          id: "2523e587-77a8-4a93-ba2f-b1cac07bb777",
          updatedAt: "2026-10-02T00:02:12.723Z",
          configHash: "4f16e4ad1884ae70782afe12baf91075e066cef41187ef2fe373c5e16504eb3d",
        }],
      },
    },
    requiredGateStepIds: [],
    publicationStepIds: ["publish-concept-conditionally"],
    generationStepIds: [
      "select-novel-concept",
      "research-selected-concept",
      "draft-beginner-concept",
      "build-concept-content",
    ],
  },
  /**
   * [검토 근거 — 2026-11-15 초안(에이전트 증거 수집) → 2026-11-16 사람 최종 승인] 원본 정의:
   *   workflow_definitions 006d48fe-c6b1-4161-8679-e9894a0c6ca8 (youtube-report, updated
   *   2026-11-15 04:01 — qa 도구가 contentType=youtube-report 카드 검사 면제로 정정된 현행
   *   버전). 검토 대상 스냅샷: workflow_run_definitions run 2b122d31-a47a-4cc0-aeef-9ef9e582846f
   *   (stepsHash 아래, 9스텝). 스텝 구성·도구는 2026-10-22 검토 정책(위 d0b3eca4 엔트리)과
   *   동일하고 toolArgs/서술만 갱신됐다(qa contentType 추가 등) — 스텝 효과 판정을 그대로
   *   계승하고 바인딩만 2026-11-15 현재 행으로 재확인했다(전부 불변, verify 통과).
   *   - collect-youtube-evidence read_only / summarize-select-scenes none / stage-youtube-video
   *     external / capture-youtube-frames read_only / build-youtube-report-content read_only /
   *     validate-youtube-report-content none / qa-youtube-report-content none / publish-
   *     onboarding-manual external + publication / verify-onboarding-manual-publish read_only.
   *   (스텝별 상세 근거는 위 d0b3eca4 엔트리 헤더 — 2026-10-22 사람 검토 원문.)
   *   requiredGateStepIds 비움: 위 두 초안과 동일한 dsh-purge 2026-10-23 정정 논리. 기존
   *     d0b3eca4 엔트리의 게이트 REQUIRED 는 그대로 유지(사람 검토 원문 존중) — 현행 형태에
   *     대한 최종 정책은 사람 검토에서 확정한다.
   *   generationStepIds: 2026-10-22 검토와 동일(장면 구성·프레임 추출·보고서 초안).
   * [바인딩 채취] 2026-11-15 scripts/resume-policy-bindings.ts collect 로 live DB 에서 채취
   *   (6개 도구 행 모두 2026-10-22 검토 시점과 불변 — configHash·updatedAt·enabled 일치).
   *   [2026-11-26 바인딩 재채취] showk.ing → insightflo.si 도메인 이전 및 inputSchema PATCH
   *   반영(사용자 승인): collect-youtube-source-evidence(6090651e)·stage-youtube-video(84d0ca94)
   *   updatedAt/configHash 갱신(effect 불변).
   */
  {
    schemaVersion: 1,
    companyId: "ff3e3efd-e30c-45c2-b893-497164405629",
    definitionHash: "a7367c27f29888e3888368992e21c8ab80075d9312adc6f79c640bc6e33c12a8",
    stepsHash: "b1f937ca9c92fa6186475397798134355ffd47d9d10bfa7bdd2e83231b7e2e43",
    steps: {
      "collect-youtube-evidence": {
        effect: "read_only",
        toolBindings: [{
          id: "6090651e-f710-4c53-b874-2706a083bccd",
          updatedAt: "2026-11-26T03:58:10.820Z",
          configHash: "09e50e670033688ef93ec4c57af18dbda183fca25807866e1e3eb7bffd311482",
        }],
      },
      "summarize-select-scenes": { effect: "none", toolBindings: [] },
      "stage-youtube-video": {
        effect: "external",
        toolBindings: [{
          // [전사 검증] id 세그먼트는 6b26(2026-11-15 수집·재확인 — 7b26 로 오기하면
          // verify 가 registry 행 없음으로 즉시 잡는다).
          id: "84d0ca94-6b26-4903-995a-4292e62f5dcf",
          updatedAt: "2026-11-26T03:58:10.866Z",
          configHash: "65e3e4ae45fd3a8281a6c92d6b3e086e11dd9278d5c1295efe6225e3e38d012d",
        }],
      },
      "capture-youtube-frames": {
        effect: "read_only",
        toolBindings: [{
          id: "1238c3f7-7bba-4f85-ba02-4dec3519e14b",
          updatedAt: "2026-08-28T13:12:54.623Z",
          configHash: "af15397063aa980988491878739bb90b8a53a43fbb9cbb4b03f5ae57f9f8f3c8",
        }],
      },
      "build-youtube-report-content": { effect: "read_only", toolBindings: [] },
      "validate-youtube-report-content": { effect: "none", toolBindings: [] },
      "qa-youtube-report-content": {
        effect: "none",
        toolBindings: [{
          id: "9512da2f-46af-4ddb-86e4-21bd1c152094",
          updatedAt: "2026-10-02T00:02:12.308Z",
          configHash: "91be83e8546bf63c2b11c37873d6f0b5b7940f60e3ea02748b300f0822473f50",
        }],
      },
      "publish-onboarding-manual": {
        effect: "external",
        toolBindings: [{
          id: "db36b402-5e7c-4efe-a6d9-ee9bfa1fde43",
          updatedAt: "2026-10-03T07:21:49.187Z",
          configHash: "ec9bd5eda6af5c3e6db2c2f342e4899290f00cebf2d62b05c1056488589cb993",
        }],
      },
      "verify-onboarding-manual-publish": {
        effect: "read_only",
        toolBindings: [{
          id: "2523e587-77a8-4a93-ba2f-b1cac07bb777",
          updatedAt: "2026-10-02T00:02:12.723Z",
          configHash: "4f16e4ad1884ae70782afe12baf91075e066cef41187ef2fe373c5e16504eb3d",
        }],
      },
    },
    requiredGateStepIds: [],
    publicationStepIds: ["publish-onboarding-manual"],
    generationStepIds: [
      "summarize-select-scenes",
      "capture-youtube-frames",
      "build-youtube-report-content",
    ],
  },
];
