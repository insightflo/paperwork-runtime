import { createContext, createElement, useContext, type ReactNode } from "react";
import { DEFAULT_COMPANY_LANGUAGE, type CompanyDefaultLanguage } from "@paperclipai/shared";
import { CompanyContext } from "../context/CompanyContext";

export function resolveCompanyLanguage(company: { defaultLanguage?: CompanyDefaultLanguage } | null | undefined): CompanyDefaultLanguage {
  return company?.defaultLanguage ?? DEFAULT_COMPANY_LANGUAGE;
}

export const CompanyLanguageContext = createContext<CompanyDefaultLanguage | undefined>(undefined);

export function CompanyLanguageProvider({ language, children }: { language: CompanyDefaultLanguage; children: ReactNode }) {
  return createElement(CompanyLanguageContext.Provider, { value: language }, children);
}

export function useCompanyLanguage(): CompanyDefaultLanguage {
  const language = useContext(CompanyLanguageContext);
  // Guard against partial test mocks of CompanyContext that only mock useCompany().
  let ctx: typeof CompanyContext | undefined;
  try {
    ctx = CompanyContext;
  } catch {
    ctx = undefined;
  }
  const company = ctx ? useContext(ctx) : null;
  return language ?? resolveCompanyLanguage(company?.selectedCompany);
}

export function L(language: CompanyDefaultLanguage, labels: { en: string; ko: string }): string {
  return language === "ko" ? labels.ko : labels.en;
}
