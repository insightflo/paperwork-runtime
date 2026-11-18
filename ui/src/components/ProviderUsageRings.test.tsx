import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProviderUsageRingItem, sortQuotaProvidersByDepletion } from "./ProviderUsageRings";

const qw = (label: string, usedPercent: number): QuotaWindow => ({
  label,
  usedPercent,
  resetsAt: null,
  valueLabel: null,
});

describe("ProviderUsageRings", () => {
  it("sorts providers by highest usedPercent descending and skips failed/empty entries", () => {
    const input: ProviderQuotaResult[] = [
      { provider: "claude", source: "oauth", ok: true, windows: [qw("5h", 32)] },
      { provider: "empty", source: "api", ok: true, windows: [] },
      { provider: "down", source: "api", ok: false, error: "timeout", windows: [qw("1d", 99)] },
      {
        provider: "antigravity",
        source: "oauth",
        ok: true,
        windows: [qw("7d", 85), qw("5h", 18)],
      },
    ];

    const sorted = sortQuotaProvidersByDepletion(input);
    expect(sorted.map((item) => item.provider)).toEqual(["antigravity", "claude"]);
    expect(sorted[0]?.maxUsedPercent).toBe(85);
  });

  it("renders concentric SVG rings (2 windows = 4 circles) with [data-provider] and warning/danger colors", () => {
    const [warnEntry] = sortQuotaProvidersByDepletion([
      {
        provider: "antigravity_local",
        source: "oauth",
        ok: true,
        windows: [qw("7d", 85), qw("5h", 96)],
      },
    ]);

    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ProviderUsageRingItem entry={warnEntry!} />
      </TooltipProvider>,
    );

    expect(html).toContain('data-provider="antigravity_local"');
    expect(html).toContain('stroke-dasharray="15 100"');
    expect(html).toContain('stroke-dasharray="4 100"');
    expect(html).toContain("var(--openbot-warning)");
    expect(html).toContain("var(--openbot-danger)");
    expect(html.match(/<circle /g)?.length).toBe(4);
  });
});
