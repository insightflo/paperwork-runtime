import { useContext, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "../api/instanceSettings";
import { CompanyContext } from "../context/CompanyContext";
import {
  ProviderAuthPanel,
  type LoginActionPlan,
  type ProviderAuthId,
} from "./ProviderAuthPanel";
import { ProviderUsageRings } from "./ProviderUsageRings";

export function ProviderAuthSection() {
  const companyId = useContext(CompanyContext)?.selectedCompanyId ?? null;
  const query = useQuery({
    queryKey: ["instance-settings", "provider-auth"],
    queryFn: instanceSettingsApi.getProviderAuth,
    retry: false,
  });
  const [loginPlans, setLoginPlans] = useState<Partial<Record<ProviderAuthId, LoginActionPlan>>>({});
  const [selectedLoginProvider, setSelectedLoginProvider] = useState<ProviderAuthId | null>(null);
  const [loginPlanLoadingProvider, setLoginPlanLoadingProvider] = useState<ProviderAuthId | null>(null);
  const [loginPlanFailed, setLoginPlanFailed] = useState(false);
  const requestSeqRef = useRef(0);

  const handleRequestLoginPlan = (provider: ProviderAuthId) => {
    const seq = ++requestSeqRef.current;
    setSelectedLoginProvider(provider);
    setLoginPlanLoadingProvider(provider);
    setLoginPlanFailed(false);
    void instanceSettingsApi
      .getProviderLoginPlan(provider)
      .then((plan) => {
        if (seq !== requestSeqRef.current) return;
        setLoginPlans((prev) => ({ ...prev, [plan.provider]: plan }));
        setLoginPlanLoadingProvider(null);
      })
      .catch(() => {
        if (seq !== requestSeqRef.current) return;
        setLoginPlanFailed(true);
        setLoginPlanLoadingProvider(null);
      });
  };

  return (
    <>
      <ProviderAuthPanel
        providers={query.data?.providers ?? []}
        loading={query.isLoading}
        error={query.isError || loginPlanFailed ? "unavailable" : null}
        loginPlans={loginPlans}
        selectedLoginProvider={selectedLoginProvider}
        loginPlanLoadingProvider={loginPlanLoadingProvider}
        onRefresh={() => void query.refetch()}
        onRequestLoginPlan={handleRequestLoginPlan}
      />
      <ProviderUsageRings companyId={companyId} />
    </>
  );
}
