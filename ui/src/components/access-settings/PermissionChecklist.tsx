import { PERMISSION_KEYS, type PermissionKey } from "@paperclipai/shared";
import {
  hasGrant,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_LABELS,
  type GrantLike,
} from "./utils";

export function PermissionChecklist({
  grants,
  inheritedKeys,
  disabled,
  onToggle,
}: {
  grants: readonly GrantLike[] | undefined;
  inheritedKeys?: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (permissionKey: PermissionKey, checked: boolean) => void;
}) {
  const grantedCount = PERMISSION_KEYS.filter(
    (key) => hasGrant(grants, key) || Boolean(inheritedKeys?.has(key)),
  ).length;
  const totalCount = PERMISSION_KEYS.length;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-slate-500 dark:text-[#8b97ad]">
          Toggle permissions granted to this principal
        </span>
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-semibold tabular-nums ${
            grantedCount > 0
              ? "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#2563eb]/15 dark:text-[#60a5fa]"
              : "border-slate-200/90 bg-slate-100/80 text-slate-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8b97ad]"
          }`}
        >
          {grantedCount}/{totalCount} granted
        </span>
      </div>
      <div className="grid gap-2 xl:grid-cols-2">
        {PERMISSION_KEYS.map((permissionKey) => {
          const checked = hasGrant(grants, permissionKey);
          const inherited = Boolean(inheritedKeys?.has(permissionKey));
          const highlighted = checked || inherited;
          return (
            <label
              key={permissionKey}
              className={`flex min-h-10 items-start gap-2.5 rounded-lg border px-2.5 py-2 text-sm transition-colors ${
                disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
              } ${
                highlighted
                  ? "border-blue-500/40 bg-blue-500/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-[#60a5fa]/40 dark:bg-[#2563eb]/12 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                  : "border-slate-200/85 bg-slate-50/50 hover:border-slate-300 hover:bg-white dark:border-white/[0.07] dark:bg-[#090c12]/80 dark:hover:border-white/[0.14] dark:hover:bg-[#111724]"
              }`}
            >
              <input
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/35 focus-visible:ring-offset-1 dark:border-white/20 dark:accent-[#3b82f6] dark:focus-visible:ring-[#60a5fa]/40"
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => onToggle(permissionKey, event.target.checked)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5 font-medium text-slate-900 dark:text-[#edf2fb]">
                  <span>{PERMISSION_LABELS[permissionKey]}</span>
                  {inherited && (
                    <span
                      data-testid={`inherited-badge-${permissionKey}`}
                      className="inline-flex items-center rounded-full border border-blue-500/35 bg-blue-500/12 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-blue-700 dark:border-[#60a5fa]/40 dark:bg-[#2563eb]/20 dark:text-[#60a5fa]"
                    >
                      그룹 상속
                    </span>
                  )}
                </span>
                <span className="block text-xs text-slate-500 dark:text-[#8b97ad]">
                  {PERMISSION_DESCRIPTIONS[permissionKey]}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
