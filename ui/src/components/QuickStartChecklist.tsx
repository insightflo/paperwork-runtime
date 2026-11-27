import { useId, useState } from "react";
import { readMigratedStorageItem, writeMigratedStorageItem } from "../lib/storage-keys";

export interface QuickStartChecklistProps {
  hasAgent: boolean;
  hasChannel: boolean;
  hasEndpointBot: boolean;
  onNavigate?: (path: string) => void;
  storageKey?: string;
}

const defaultStorageKey = "paperwork.quickstart.dismissed";
const legacyStorageKey = "paperclip.quickstart.dismissed";

export function QuickStartChecklist({
  hasAgent,
  hasChannel,
  hasEndpointBot,
  onNavigate,
  storageKey = defaultStorageKey,
}: QuickStartChecklistProps) {
  // Custom keys stay independent; only the default key migrates legacy storage.
  const legacyKey = storageKey === defaultStorageKey ? legacyStorageKey : `${storageKey}.legacy`;
  const [dismissed, setDismissed] = useState(
    () => readMigratedStorageItem(storageKey, legacyKey) === "1",
  );
  const titleId = useId();
  const steps = [
    { label: "① 첫 에이전트 만들기", path: "/agents", action: "만들기", done: hasAgent },
    {
      label: "② 협업 채널에서 @멘션으로 일 시키기",
      path: "/channels",
      action: "채널 열기",
      done: hasChannel,
    },
    {
      label: "③ 내 PC 개인 단말 봇 연결하기 (선택)",
      path: "/enterprise-bots",
      action: "연결하기",
      done: hasEndpointBot,
    },
  ];
  const completed = steps.filter((step) => step.done).length;

  if (dismissed) return null;

  function dismiss() {
    writeMigratedStorageItem(storageKey, legacyKey, "1");
    setDismissed(true);
  }

  return (
    <section aria-labelledby={titleId} className="rounded-xl border border-border bg-card p-5 text-card-foreground">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="text-base font-semibold">빠르게 시작하기</h2>
          <p role="status" className="mt-1 text-sm text-muted-foreground">{completed} / 3 완료</p>
        </div>
        <button
          type="button"
          aria-label="닫기"
          onClick={dismiss}
          className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          닫기
        </button>
      </div>
      <ol className="space-y-3">
        {steps.map((step) => (
          <li key={step.path} className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1 text-sm">{step.label}</span>
            {step.done ? (
              <span role="img" aria-label="완료" className="text-emerald-700 dark:text-emerald-400">✓</span>
            ) : (
              <button
                type="button"
                aria-label={`${step.label} 시작`}
                onClick={() => onNavigate?.(step.path)}
                className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                {step.action}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
