// ui/src/components/workflows/WorkflowsHarnessHeaderStrip.tsx
//
// [파일 목적] 워크플로 헤더에 붙는 회사 단위 하네스 플릿 배너의 연결(connected) 컴포넌트.
//   useCompanyWorkflowHarnessFleet(companyId)의 { isLoading, error, data }를
//   WorkflowHarnessFleetBanner의 loading / error / ready 상태로 그대로 매핑한다.
//   - companyId가 비어 있으면 아무것도 그리지 않는다(null).
//   - error는 항상 error 배너로 표시한다. data가 null(응답이 계약과 다름)이면
//     빈 플릿으로 보이는 대신 error 배너로 실패를 드러낸다(fail-closed).
import { type WorkflowHarnessFleetSummary, useCompanyWorkflowHarnessFleet } from "@/hooks/useCompanyWorkflowHarnessFleet";
import { WorkflowHarnessFleetBanner } from "./WorkflowHarnessFleetBanner";

export const HARNESS_FLEET_MALFORMED_COPY = "하네스 플릿 응답이 계약과 다릅니다";

export interface WorkflowsHarnessHeaderStripProps {
  readonly companyId?: string | null;
  readonly className?: string;
}

export function WorkflowsHarnessHeaderStrip(props: WorkflowsHarnessHeaderStripProps) {
  const { companyId, className } = props;
  // Rules of hooks: the hook runs even when disabled so early returns never reorder hooks.
  const { data, error, isLoading } = useCompanyWorkflowHarnessFleet(companyId);
  if (!companyId?.trim()) return null;

  if (error) return <WorkflowHarnessFleetBanner status="error" error={error} fleet={data ?? null} className={className} />;
  if (isLoading) return <WorkflowHarnessFleetBanner status="loading" className={className} />;
  if (data === null || data === undefined) {
    return <WorkflowHarnessFleetBanner status="error" error={new Error(HARNESS_FLEET_MALFORMED_COPY)} className={className} />;
  }
  return <WorkflowHarnessFleetBanner status="ready" fleet={data} className={className} />;
}
