import { useEffect } from "react";
import { Link, useLocation } from "@/lib/router";
import { AlertTriangle, Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";

const PANEL =
  "tactile-card rounded-[12px] border-slate-200/90 bg-white/95 dark:bg-none dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)]";
const INSET =
  "rounded-[10px] border border-slate-200/80 bg-slate-50/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] dark:border-white/[0.07] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";
const PRIMARY_ACTION =
  "border border-blue-600 bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] hover:border-blue-500 hover:bg-blue-500 dark:border-[#60a5fa] dark:bg-[#60a5fa] dark:text-[#07111f] dark:hover:border-[#93c5fd] dark:hover:bg-[#93c5fd]";
const SECONDARY_ACTION =
  "border-slate-200/90 bg-white text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] hover:border-blue-500/35 hover:bg-slate-50 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#eef2f8] dark:hover:border-[#60a5fa]/35 dark:hover:bg-[#141b29]";

type NotFoundScope = "board" | "invalid_company_prefix" | "global";

interface NotFoundPageProps {
  scope?: NotFoundScope;
  requestedPrefix?: string;
}

export function NotFoundPage({ scope = "global", requestedPrefix }: NotFoundPageProps) {
  const location = useLocation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { companies, selectedCompany } = useCompany();

  useEffect(() => {
    setBreadcrumbs([{ label: "Not Found" }]);
  }, [setBreadcrumbs]);

  const fallbackCompany = selectedCompany ?? companies[0] ?? null;
  const dashboardHref = fallbackCompany ? `/${fallbackCompany.issuePrefix}/dashboard` : "/";
  const currentPath = `${location.pathname}${location.search}${location.hash}`;
  const normalizedPrefix = requestedPrefix?.toUpperCase();

  const title = scope === "invalid_company_prefix" ? "Company not found" : "Page not found";
  const description =
    scope === "invalid_company_prefix"
      ? `No company matches prefix "${normalizedPrefix ?? "unknown"}".`
      : "This route does not exist.";

  return (
    <div className="mx-auto w-full max-w-3xl py-10 tabular-nums">
      <div className={`cockpit-strip h-8 w-full gap-0 overflow-hidden ${PANEL}`} role="group" aria-label="Route telemetry">
        <span className="cockpit-cell shrink-0 font-mono font-semibold text-slate-900 dark:text-[#edf2fb]">404</span>
        <span className="cockpit-cell min-w-0 flex-1 justify-center uppercase tracking-wide">route telemetry</span>
        <span className="cockpit-cell shrink-0">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.45)] dark:bg-[#f59e0b]" />
          {scope.replaceAll("_", " ")}
        </span>
      </div>

      <section className={`mt-3 p-6 ${PANEL}`}>
        <div className="flex items-center gap-3">
          <div className="rounded-[10px] border border-amber-500/25 bg-amber-500/10 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] dark:border-[#f59e0b]/30 dark:bg-[#f59e0b]/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
            <AlertTriangle className="h-5 w-5 text-amber-700 dark:text-[#f59e0b]" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-slate-950 dark:text-[#edf2fb]">{title}</h1>
            <p className="text-sm text-slate-500 dark:text-[#8b97ad]">{description}</p>
          </div>
        </div>

        <div className={`mt-5 px-3 py-2 text-xs text-slate-500 dark:text-[#8b97ad] ${INSET}`}>
          <span className="font-semibold uppercase tracking-[0.14em]">Requested path: </span>
          <code className="ml-1 break-all font-mono text-slate-900 dark:text-[#edf2fb]">{currentPath}</code>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button asChild className={PRIMARY_ACTION}>
            <Link to={dashboardHref}>
              <Compass className="mr-1.5 h-4 w-4" />
              Open dashboard
            </Link>
          </Button>
          <Button variant="outline" asChild className={SECONDARY_ACTION}>
            <Link to="/">Go home</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
