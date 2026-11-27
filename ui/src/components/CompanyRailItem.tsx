import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Company } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CompanyPatternIcon } from "./CompanyPatternIcon";

export const COMPANY_ORDER_STORAGE_KEY = "paperclip.companyOrder";

export function getStoredCompanyOrder(): string[] {
  try {
    const raw = localStorage.getItem(COMPANY_ORDER_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // Ignore storage read errors in sandboxed contexts.
  }
  return [];
}

export function saveCompanyOrder(ids: string[]) {
  try {
    localStorage.setItem(COMPANY_ORDER_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Ignore storage write errors.
  }
}

export function sortCompaniesByStoredOrder(companies: Company[]): Company[] {
  const order = getStoredCompanyOrder();
  if (order.length === 0) return companies;

  const byId = new Map(companies.map((c) => [c.id, c]));
  const sorted: Company[] = [];
  for (const id of order) {
    const c = byId.get(id);
    if (c) {
      sorted.push(c);
      byId.delete(id);
    }
  }
  for (const c of byId.values()) {
    sorted.push(c);
  }
  return sorted;
}

export function SortableCompanyItem({
  company,
  isSelected,
  hasLiveAgents,
  hasUnreadInbox,
  onSelect,
}: {
  company: Company;
  isSelected: boolean;
  hasLiveAgents: boolean;
  hasUnreadInbox: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: company.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.8 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="overflow-visible">
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <a
            href={`/${company.issuePrefix}/missions`}
            onClick={(e) => {
              e.preventDefault();
              onSelect();
            }}
            className="relative flex w-full items-center justify-center group overflow-visible"
          >
            <div
              className={cn(
                "absolute left-[-8px] w-[3px] rounded-r-[3px] transition-[height,background-color,box-shadow] duration-150",
                isSelected
                  ? "h-5 bg-primary"
                  : "h-0 group-hover:h-2 bg-primary/60",
              )}
            />
            <div
              className={cn(
                "relative flex h-9 w-9 items-center justify-center rounded-[8px] border overflow-visible transition-all duration-150",
                isSelected
                  ? "border-primary/35 bg-primary/10 text-primary dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]"
                  : "border-transparent bg-transparent hover:border-slate-300/70 hover:bg-slate-200/60 dark:hover:border-white/[0.065] dark:hover:bg-white/[0.04]",
                isDragging && "scale-105 shadow-lg",
              )}
            >
              <CompanyPatternIcon
                companyName={company.name}
                logoUrl={company.logoUrl}
                brandColor={company.brandColor}
                className={cn(
                  "h-7 w-7 rounded-[6px] text-xs",
                  isDragging && "shadow-lg",
                )}
              />
              {hasLiveAgents && (
                <span className="pointer-events-none absolute -right-0.5 -top-0.5 z-10">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-[var(--pw-lime)] opacity-80" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--pw-lime)] ring-2 ring-[var(--pw-rail)]" />
                  </span>
                </span>
              )}
              {hasUnreadInbox && (
                <span className="pointer-events-none absolute -bottom-0.5 -right-0.5 z-10 h-2 w-2 rounded-full bg-red-500 ring-2 ring-[var(--pw-rail)]" />
              )}
            </div>
          </a>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          <p>{company.name}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
