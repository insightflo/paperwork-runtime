export interface BotHealthSample {
  ts: string;
  ok: boolean;
  rttMs?: number | null;
  statusCode?: number | null;
  errorRef?: string | null;
}

export interface BotHealthSparklineProps {
  samples: BotHealthSample[];
  /** Number of bars to display (default 20). */
  slots?: number;
  width?: number;
  height?: number;
  ariaLabel?: string;
  className?: string;
}

export type SparklineBarTone = "ok" | "slow" | "error" | "empty";

export function classifySampleTone(sample: BotHealthSample | null): SparklineBarTone {
  if (!sample) return "empty";
  if (!sample.ok) return "error";
  if (sample.rttMs != null && sample.rttMs > 500) return "slow";
  return "ok";
}

function toneFill(tone: SparklineBarTone): string {
  switch (tone) {
    case "ok":
      return "var(--pw-emerald, #4f7d5a)";
    case "slow":
      return "var(--pw-amber, #a16207)";
    case "error":
      return "var(--pw-crimson, #b91c1c)";
    case "empty":
      return "var(--pw-hairline-strong, rgba(31, 27, 22, 0.24))";
  }
}

export function formatSampleTooltip(sample: BotHealthSample): string {
  const parts = [sample.ts, sample.ok ? "정상" : "오류"];
  if (sample.statusCode != null) parts.push(`HTTP ${sample.statusCode}`);
  if (sample.rttMs != null) parts.push(`${Math.round(sample.rttMs)}ms`);
  if (sample.errorRef) parts.push(`ref:${sample.errorRef}`);
  return parts.join(" · ");
}

export function BotHealthSparkline({
  samples,
  slots = 20,
  width = 160,
  height = 28,
  ariaLabel,
  className = "",
}: BotHealthSparklineProps) {
  const count = Math.max(1, slots);
  const recent = samples.slice(-count);
  const padCount = Math.max(0, count - recent.length);
  const padded: Array<BotHealthSample | null> = [
    ...Array.from({ length: padCount }, () => null),
    ...recent,
  ];

  const maxRtt = recent.reduce((acc, s) => {
    if (s.rttMs != null && Number.isFinite(s.rttMs) && s.rttMs > acc) return s.rttMs;
    return acc;
  }, 500);

  const okCount = recent.filter((s) => s.ok).length;
  const summaryLabel =
    ariaLabel ??
    (recent.length > 0
      ? `봇 상태 추이: 최근 ${recent.length}개 중 ${okCount}개 정상`
      : "봇 상태 추이: 아직 표본 없음");

  const gap = 2;
  const barWidth = Math.max(2, (width - gap * (count - 1)) / count);
  const minBarHeight = Math.max(4, Math.round(height * 0.22));
  const emptyBarHeight = 3;

  return (
    <svg
      role="img"
      aria-label={summaryLabel}
      data-health-sparkline
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`shrink-0 overflow-visible tabular-nums ${className}`.trim()}
    >
      <title>{summaryLabel}</title>
      {padded.map((sample, idx) => {
        const tone = classifySampleTone(sample);
        const x = idx * (barWidth + gap);
        let barHeight = emptyBarHeight;

        if (sample) {
          if (!sample.ok) {
            barHeight = height;
          } else if (sample.rttMs != null && Number.isFinite(sample.rttMs)) {
            const ratio = Math.min(1, Math.max(0, sample.rttMs / maxRtt));
            barHeight = Math.max(minBarHeight, Math.round(minBarHeight + ratio * (height - minBarHeight)));
          } else {
            barHeight = Math.round(height * 0.5);
          }
        }

        const y = height - barHeight;
        const tooltip = sample ? formatSampleTooltip(sample) : "표본 없음";

        return (
          <rect
            key={sample ? `${sample.ts}-${idx}` : `empty-${idx}`}
            x={Number(x.toFixed(2))}
            y={y}
            width={Number(barWidth.toFixed(2))}
            height={barHeight}
            rx={1.5}
            fill={toneFill(tone)}
            data-bar-tone={tone}
            data-rtt-ms={sample?.rttMs != null ? String(Math.round(sample.rttMs)) : undefined}
            data-error-ref={sample?.errorRef ?? undefined}
          >
            <title>{tooltip}</title>
          </rect>
        );
      })}
    </svg>
  );
}
