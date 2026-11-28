/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  formatDrainEtaMs,
  QueueDrainForecastCard,
  type QueueDrainForecastView,
} from "../QueueDrainForecastCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function forecast(overrides: Partial<QueueDrainForecastView> = {}): QueueDrainForecastView {
  return {
    currentSlots: 2,
    estimatedDrainMs: 600_000,
    suggestedSlots: 6,
    suggestedDrainMs: 180_000,
    speedupRatio: 3.3,
    ...overrides,
  };
}

function html(props: Parameters<typeof QueueDrainForecastCard>[0]): string {
  return renderToStaticMarkup(<QueueDrainForecastCard {...props} />);
}

describe("formatDrainEtaMs", () => {
  it.each([
    [-1, "즉시"],
    [0, "즉시"],
    [999, "1초"],
    [45_000, "45초"],
    [59_999, "60초"],
    [60_000, "1분"],
    [90_000, "2분"],
    [3_540_000, "59분"],
    [3_600_000, "1시간 0분"],
    [5_460_000, "1시간 31분"],
  ] as const)("formats %d ms as %s", (ms, expected) => {
    expect(formatDrainEtaMs(ms)).toBe(expected);
  });
});

describe("QueueDrainForecastCard", () => {
  it("returns null when the forecast is missing or already drained", () => {
    expect(html({ forecast: null })).toBe("");
    expect(html({ forecast: undefined })).toBe("");
    expect(html({ forecast: forecast({ estimatedDrainMs: 0 }) })).toBe("");
    expect(html({ forecast: forecast({ estimatedDrainMs: -5_000 }) })).toBe("");
  });

  it("renders current and suggested drain ETAs with the speedup ratio", () => {
    const markup = html({ forecast: forecast(), onApplySuggestedSlots: vi.fn() });

    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="대기열 소진 예상"');
    expect(markup).toContain('data-testid="queue-drain-forecast-card"');
    expect(markup).toContain("현재 슬롯");
    expect(markup).toContain("2개");
    expect(markup).toContain("현재 예상 소진");
    expect(markup).toContain("10분");
    expect(markup).toContain("제안 슬롯");
    expect(markup).toContain("6개");
    expect(markup).toContain("확장 시 예상");
    expect(markup).toContain("3분");
    expect(markup).toContain("3.3x 빠름");
    expect(markup).toContain('type="button"');
  });

  it("omits the suggestion when suggested slots do not exceed current slots", () => {
    const markup = html({ forecast: forecast({ suggestedSlots: 2 }), onApplySuggestedSlots: vi.fn() });

    expect(markup).toContain("현재 슬롯");
    expect(markup).not.toContain("제안 슬롯");
    expect(markup).not.toContain("3.3x 빠름");
    expect(markup).not.toContain("button");
  });

  it("fires onApplySuggestedSlots with the suggested slot count", async () => {
    const onApplySuggestedSlots = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<QueueDrainForecastCard forecast={forecast()} onApplySuggestedSlots={onApplySuggestedSlots} />);
    });

    const button = host.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.type).toBe("button");

    await act(async () => {
      button?.click();
    });

    expect(onApplySuggestedSlots).toHaveBeenCalledTimes(1);
    expect(onApplySuggestedSlots).toHaveBeenCalledWith(6);

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
