import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useNavigate } from "@/lib/router";

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Invoked when the operator chooses "홈으로 이동". When omitted, the boundary falls
   * back to a full-page navigation to "/" so the action always works, even without a router.
   */
  onNavigateHome?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

const FALLBACK_HEADING = "문제가 발생했어요";
const FALLBACK_MESSAGE =
  "페이지를 표시하는 중에 예상치 못한 오류가 발생했습니다. 작업 중인 내용은 안전하게 보존되어 있으니, 잠시 후 아래 버튼으로 다시 시도해 주세요.";

/**
 * Top-level render-error boundary. Catches any rendering error in its subtree and shows an
 * accessible recovery UI instead of a blank screen. Diagnostics (error + component stack)
 * go to the console only; raw error details are never rendered into the fallback UI.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console diagnostics only — the fallback UI stays non-technical on purpose.
    console.error("[ErrorBoundary] render error:", error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  private handleGoHome = (): void => {
    const { onNavigateHome } = this.props;
    this.setState({ hasError: false });
    if (onNavigateHome) {
      onNavigateHome();
      return;
    }
    window.location.assign("/");
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div role="alert" className="mx-auto w-full max-w-xl py-10">
          <div className="rounded-lg border border-border bg-card p-6">
            <h1 className="text-xl font-semibold">{FALLBACK_HEADING}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{FALLBACK_MESSAGE}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={this.handleRetry}>
                다시 시도
              </Button>
              <Button type="button" onClick={this.handleGoHome}>
                홈으로 이동
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Router-connected variant for the app root: "홈으로 이동" navigates inside the SPA ("/")
 * via the app router instead of a full page reload.
 */
export function ErrorBoundaryWithNavigation({ children }: { children: ReactNode }) {
  const navigate = useNavigate();

  return (
    <ErrorBoundary onNavigateHome={() => navigate("/", { replace: true })}>
      {children}
    </ErrorBoundary>
  );
}
