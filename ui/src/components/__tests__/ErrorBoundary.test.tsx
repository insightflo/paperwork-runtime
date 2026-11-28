// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "@/lib/router";
import { CompanyContext } from "@/context/CompanyContext";
import { koCompanyContext } from "@/test-utils/koCompanyContext";
import { ErrorBoundary, ErrorBoundaryWithNavigation } from "../ErrorBoundary";

let host: HTMLDivElement;
let root: Root;

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  expect(button, `button "${label}" should be rendered`).toBeDefined();
  return button!;
}

/** Component that always throws during render, emulating an unexpected render error. */
function Boom(): never {
  throw new Error("probe failure with stack details");
}

/**
 * Throws on odd renders and renders content on even renders, so the retry button can be
 * observed to actually recover: reset → child re-render → this time it succeeds.
 */
let boomRenderCount = 0;
function RecoverableBoom(): ReactNode {
  boomRenderCount += 1;
  if (boomRenderCount % 2 === 1) throw new Error("recoverable render failure");
  return <p>정상 콘텐츠</p>;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  // React 19 first attempts a concurrent render on route transitions; when the probe throws,
  // it recovers by re-rendering synchronously and lets the boundary catch. That internal
  // recovery is reported via onRecoverableError — silence it so Vitest sees no uncaught error.
  root = createRoot(host, { onRecoverableError: () => {} });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders children normally when no error occurs", async () => {
    await render(
      <ErrorBoundary>
        <p>정상 콘텐츠</p>
      </ErrorBoundary>,
    );

    expect(host.textContent).toContain("정상 콘텐츠");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("renders the role=alert fallback with accessible actions when a child throws", async () => {
    await render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelector("h1")?.textContent).toBe("문제가 발생했어요");
    expect(host.textContent).toContain("예상치 못한 오류");
    // Never leak raw error details or stack traces into the fallback UI.
    expect(host.textContent).not.toContain("probe failure");
    expect(findButton("다시 시도").getAttribute("type")).toBe("button");
    expect(findButton("홈으로 이동").getAttribute("type")).toBe("button");
  });

  it("retry button resets error state and renders children again", async () => {
    boomRenderCount = 0;
    await render(
      <ErrorBoundary>
        <RecoverableBoom />
      </ErrorBoundary>,
    );
    expect(host.querySelector('[role="alert"]')).not.toBeNull();

    await act(async () => {
      findButton("다시 시도").click();
    });

    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("정상 콘텐츠");
  });

  it("home button invokes the navigate-home action", async () => {
    const onNavigateHome = vi.fn();
    await render(
      <ErrorBoundary onNavigateHome={onNavigateHome}>
        <Boom />
      </ErrorBoundary>,
    );

    await act(async () => {
      findButton("홈으로 이동").click();
    });

    expect(onNavigateHome).toHaveBeenCalledTimes(1);
  });
});

describe("ErrorBoundaryWithNavigation", () => {
  it("routes to / when home is chosen after a render error", async () => {
    await render(
      <CompanyContext.Provider value={koCompanyContext}>
        <MemoryRouter initialEntries={["/somewhere/broken"]}>
          <ErrorBoundaryWithNavigation>
            <Routes>
              <Route path="/" element={<p>홈 도착</p>} />
              <Route path="*" element={<Boom />} />
            </Routes>
          </ErrorBoundaryWithNavigation>
        </MemoryRouter>
      </CompanyContext.Provider>,
    );
    expect(host.querySelector('[role="alert"]')).not.toBeNull();

    await act(async () => {
      findButton("홈으로 이동").click();
    });

    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("홈 도착");
  });
});
