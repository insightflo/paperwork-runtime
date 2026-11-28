import { useEffect, useMemo, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi, authErrorMessage } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { resolveAuthRedirectPath } from "../lib/auth-redirect";
import { Button } from "@/components/ui/button";
import { Fingerprint, Github, LogIn } from "lucide-react";
import { PapercompanyLogoIcon } from "@/components/PapercompanyLogoIcon";

type AuthMode = "sign_in" | "sign_up" | "forgot_password" | "reset_password";
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_HINT = "Use at least 10 characters.";
const RESET_PASSWORD_LENGTH_ERROR = "New password must be at least 10 characters.";
const inputClass =
  "w-full rounded-lg border border-[#1f1b16]/12 bg-[#faf7f0] px-3 py-2 text-sm text-[#1f1b16] outline-none transition-colors placeholder:text-[#9a9184] focus:border-[#9a3b2e]/60 focus:ring-2 focus:ring-[#9a3b2e]/20 dark:border-[#f3eee4]/12 dark:bg-[#171412] dark:text-[#f3eee4] dark:placeholder:text-[#a89f93]/70 dark:focus:border-[#c85a48]/60 dark:focus:ring-[#c85a48]/25";
const copy: Record<AuthMode, { title: string; body: string; submit: string }> = {
  sign_in: { title: "Sign in to Paperwork", body: "Use your email and password to access this instance.", submit: "Sign In" },
  sign_up: { title: "Create your Paperwork account", body: "Create an account for this instance. Email confirmation is not required in v1.", submit: "Create Account" },
  forgot_password: { title: "Reset your password", body: "Enter your email and we will send a password reset link if the account exists.", submit: "Send Reset Link" },
  reset_password: { title: "Choose a new password", body: "Enter a new password with at least 10 characters.", submit: "Reset Password" },
};
const brandItems = [
  { title: "Workflow orchestration", body: "Coordinate missions, approvals, and execution state in one operating layer.", accent: "border-[#9a3b2e]/50 bg-[#9a3b2e]/20 text-[#e29a8a]" },
  { title: "Multi-user RBAC", body: "Give people and agents differentiated permissions inside company boundaries.", accent: "border-[#4f7d5a]/50 bg-[#4f7d5a]/20 text-[#9cc7a6]" },
  { title: "Controlled bot terminals", body: "Operate worker terminals through centrally governed execution controls.", accent: "border-[#b8863b]/50 bg-[#b8863b]/20 text-[#dcb67a]" },
];

function Field({ id, label, hint, invalid, ...props }: InputHTMLAttributes<HTMLInputElement> & { id: string; label: string; hint?: string; invalid?: boolean }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#6b6257] dark:text-[#a89f93]">{label}</label>
      <input id={id} name={id} className={inputClass} aria-invalid={invalid || undefined}
        aria-describedby={[hint ? `${id}-hint` : null, invalid ? "auth-error" : null].filter(Boolean).join(" ") || undefined} {...props} />
      {hint && <p id={`${id}-hint`} className="mt-1.5 text-xs text-[#6b6257] dark:text-[#a89f93]">{hint}</p>}
    </div>
  );
}

function ProviderBadge({ id }: { id: string }) {
  const iconClass = "h-4 w-4";
  const icons: Record<string, ReactNode> = {
    google: <svg viewBox="0 0 24 24" className={iconClass} aria-hidden="true"><path fill="currentColor" d="M12.545 10.239v3.821h5.445c-.712 2.315-2.647 3.972-5.445 3.972-3.332 0-6.033-2.701-6.033-6.032s2.701-6.032 6.033-6.032c1.498 0 2.866.549 3.921 1.453l2.814-2.814C17.503 2.988 15.139 2 12.545 2 7.021 2 2.543 6.477 2.543 12s4.478 10 10.002 10c8.396 0 10.249-7.85 9.426-11.761L12.545 10.239z"/></svg>,
    github: <Github className={iconClass} aria-hidden="true" />,
    microsoft: <svg viewBox="0 0 24 24" className={iconClass} aria-hidden="true"><path fill="currentColor" d="M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z"/></svg>,
    oidc: <Fingerprint className={iconClass} aria-hidden="true" />,
  };
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#1f1b16]/12 bg-[#f6f1e7] text-[#1f1b16] shadow-xs dark:border-[#f3eee4]/12 dark:bg-[#171412] dark:text-[#f3eee4]">
      {icons[id.toLowerCase()] ?? <LogIn className={iconClass} aria-hidden="true" />}
    </span>
  );
}

type AuthApiWithSocialSignIn = typeof authApi & { signInSocial?: typeof authApi.startSocialSignIn };
const signInSocial = (input: Parameters<typeof authApi.startSocialSignIn>[0]) =>
  ((authApi as AuthApiWithSocialSignIn).signInSocial ?? authApi.startSocialSignIn)(input);

export function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const resetToken = searchParams.get("token")?.trim() ?? "";
  const [mode, setMode] = useState<AuthMode>(resetToken ? "reset_password" : "sign_in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [invalidFields, setInvalidFields] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const nextPath = useMemo(() => resolveAuthRedirectPath(searchParams.get("next")), [searchParams]);
  const { data: session, isLoading: isSessionLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const socialProvidersQuery = useQuery({
    queryKey: queryKeys.auth.providers,
    queryFn: () => authApi.getSocialProviders(),
    retry: false,
  });

  useEffect(() => {
    if (resetToken) setMode("reset_password");
  }, [resetToken]);
  useEffect(() => {
    if (session) navigate(nextPath, { replace: true });
  }, [session, navigate, nextPath]);

  const mutation = useMutation({
    mutationFn: async (submittedMode: AuthMode) => {
      if (submittedMode === "sign_in") return authApi.signInEmail({ email: email.trim(), password });
      if (submittedMode === "sign_up") return authApi.signUpEmail({ name: name.trim(), email: email.trim(), password });
      if (submittedMode === "forgot_password") return authApi.requestPasswordReset({ email: email.trim(), redirectTo: "/auth" });
      return authApi.resetPassword({ token: resetToken, newPassword: password });
    },
    onSuccess: async (_data, submittedMode) => {
      setError(null);
      if (submittedMode === "forgot_password") {
        setNotice("If an account exists for that email, a password reset link has been sent.");
        return;
      }
      if (submittedMode === "reset_password") {
        setNotice("Password updated. Sign in with your new password.");
        setMode("sign_in");
        setPassword("");
        setConfirmPassword("");
        return;
      }
      setNotice(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      navigate(nextPath, { replace: true });
    },
    onError: (err) => {
      setNotice(null);
      setError(authErrorMessage(err, "Authentication failed"));
    },
  });
  const socialMutation = useMutation({
    mutationFn: (provider: string) => signInSocial({ provider, callbackURL: nextPath }),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (err) => { setInvalidFields([]); setError(authErrorMessage(err, "Could not start social sign-in")); },
  });

  const missingFields = Object.entries({
    "auth-name": mode !== "sign_up" || name.trim().length > 0,
    "auth-email": mode === "reset_password" || email.trim().length > 0,
    "auth-password": mode === "forgot_password" || password.length > 0,
    "auth-confirm-password": mode !== "reset_password" || confirmPassword.length > 0,
  }).filter(([, valid]) => !valid).map(([id]) => id);
  const hasRequiredFields = missingFields.length === 0;
  const validate = () => {
    if (!hasRequiredFields) return { message: "Please fill in all required fields.", fields: missingFields };
    if (mode === "sign_up" && password.length < PASSWORD_MIN_LENGTH) return { message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`, fields: ["auth-password"] };
    if (mode === "reset_password") {
      if (!resetToken) return { message: "This reset link is missing a token.", fields: [] };
      if (password.length < PASSWORD_MIN_LENGTH) return { message: RESET_PASSWORD_LENGTH_ERROR, fields: ["auth-password"] };
      if (password !== confirmPassword) return { message: "Passwords do not match.", fields: ["auth-confirm-password"] };
    }
    return null;
  };
  const switchMode = (nextMode: AuthMode) => {
    setError(null);
    setInvalidFields([]);
    setNotice(null);
    setMode(nextMode);
  };
  const socialProviders = socialProvidersQuery.data ?? [];
  const showSocial = (mode === "sign_in" || mode === "sign_up") && socialProviders.length > 0;
  const isNewPasswordMode = mode === "sign_up" || mode === "reset_password";

  if (isSessionLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[#f3eee4] dark:bg-[#171412]">
        <div className="tactile-card inline-flex items-center gap-2.5 rounded-xl border border-[#1f1b16]/10 bg-[#faf7f0] px-4 py-2.5 text-sm text-[#6b6257] shadow-xs dark:border-[#f3eee4]/10 dark:bg-[#1f1b16] dark:text-[#a89f93] dark:shadow-[inset_0_1px_0_rgba(243,238,228,0.06)]">
          <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-[#4f7d5a] dark:bg-[#7fae8a]" />
          <p>Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex bg-[#f3eee4] text-[#1f1b16] dark:bg-[#171412] dark:text-[#f3eee4]">
      <div className="flex w-full flex-col overflow-y-auto md:w-1/2">
        <div className="mx-auto my-auto w-full max-w-md px-6 py-10 sm:px-8">
          <div className="tactile-card rounded-2xl border border-[#1f1b16]/10 bg-[#faf7f0] p-7 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_3px_rgba(31,27,22,0.06)] dark:border-[#f3eee4]/10 dark:bg-[#1f1b16] dark:shadow-[inset_0_1px_0_rgba(243,238,228,0.06),0_18px_48px_-20px_rgba(0,0,0,0.85)] sm:p-8">
            <div className="mb-7 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <PapercompanyLogoIcon className="h-7 w-7" />
                <span className="text-sm font-semibold tracking-tight text-[#1f1b16] dark:text-[#f3eee4]">Paperwork</span>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#4f7d5a]/35 bg-[#4f7d5a]/12 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#3f6a4c] dark:border-[#7fae8a]/35 dark:bg-[#7fae8a]/12 dark:text-[#a9d2b3]">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#4f7d5a] shadow-[0_0_6px_rgba(79,125,90,0.75)] dark:bg-[#7fae8a]" />
                Auth Gateway
              </span>
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-[#1f1b16] dark:text-[#f3eee4]">{copy[mode].title}</h1>
            <p className="mt-1.5 text-sm text-[#6b6257] dark:text-[#a89f93]">{copy[mode].body}</p>
            <form
              className="mt-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (mutation.isPending) return;
                const validationError = validate();
                if (validationError) {
                  setNotice(null);
                  setError(validationError.message);
                  setInvalidFields(validationError.fields);
                  return;
                }
                setInvalidFields([]);
                mutation.mutate(mode);
              }}
            >
              {mode === "sign_up" && <Field id="auth-name" label="Name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" invalid={invalidFields.includes("auth-name")} />}
              {mode !== "reset_password" && <Field id="auth-email" label="Email" type="email" inputMode="email" spellCheck={false} value={email} onChange={(event) => setEmail(event.target.value)} autoComplete={mode === "sign_in" ? "username" : "email"} invalid={invalidFields.includes("auth-email")} />}
              {mode !== "forgot_password" && (
                <Field
                  id="auth-password"
                  label={mode === "reset_password" ? "New Password" : "Password"}
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                  minLength={isNewPasswordMode ? PASSWORD_MIN_LENGTH : undefined}
                  hint={isNewPasswordMode ? PASSWORD_HINT : undefined}
                  invalid={invalidFields.includes("auth-password")}
                />
              )}
              {mode === "reset_password" && (
                <Field id="auth-confirm-password" label="Confirm Password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} invalid={invalidFields.includes("auth-confirm-password")} />
              )}
              {mode === "sign_in" && (
                <div className="text-right">
                  <button type="button" className="text-xs font-medium text-[#6b6257] underline underline-offset-2 transition-colors hover:text-[#9a3b2e] dark:text-[#a89f93] dark:hover:text-[#e29a8a]" onClick={() => switchMode("forgot_password")}>Forgot password?</button>
                </div>
              )}
              {error && <p id="auth-error" role="alert" className="rounded-lg border border-[#9a3b2e]/35 bg-[#9a3b2e]/10 px-3 py-2 text-xs text-[#8a3327] dark:border-[#c85a48]/40 dark:bg-[#c85a48]/12 dark:text-[#e8a090]">{error}</p>}
              {notice && <p role="status" aria-live="polite" className="rounded-lg border border-[#4f7d5a]/35 bg-[#4f7d5a]/12 px-3 py-2 text-xs text-[#3f6a4c] dark:border-[#7fae8a]/35 dark:bg-[#7fae8a]/12 dark:text-[#a9d2b3]">{notice}</p>}
              <Button
                type="submit"
                disabled={mutation.isPending}
                aria-disabled={!hasRequiredFields || mutation.isPending}
                className={`h-10 w-full rounded-lg bg-[#9a3b2e] text-[#faf7f0] shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] hover:bg-[#c85a48] ${!hasRequiredFields && !mutation.isPending ? "opacity-50" : ""}`}
              >
                {mutation.isPending ? "Working…" : copy[mode].submit}
              </Button>
            </form>
            {showSocial && (
              <div className="mt-6">
                <div className="flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.12em] text-[#6b6257] dark:text-[#a89f93]">
                  <span className="h-px flex-1 bg-[#1f1b16]/12 dark:bg-[#f3eee4]/10" /><span>or continue with</span><span className="h-px flex-1 bg-[#1f1b16]/12 dark:bg-[#f3eee4]/10" />
                </div>
                <div className="mt-4 space-y-2">
                  {socialProviders.map((provider) => (
                    <Button key={provider.id} type="button" variant="outline" data-auth-provider={provider.id} className="h-10 w-full justify-start rounded-lg border-border/80 bg-card/70 px-3 shadow-none transition-colors hover:border-primary/50 hover:bg-accent/60 dark:border-border/80 dark:bg-card/70 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] dark:hover:border-primary/50 dark:hover:bg-accent/60" disabled={socialMutation.isPending} onClick={() => socialMutation.mutate(provider.id)}>
                      <ProviderBadge id={provider.id} /><span className="truncate">Continue with {provider.label}</span>
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-6 border-t border-[#1f1b16]/10 pt-5 text-sm text-[#6b6257] dark:border-[#f3eee4]/8 dark:text-[#a89f93]">
              {mode === "sign_in" || mode === "sign_up" ? (
                <>
                  {mode === "sign_in" ? "Need an account?" : "Already have an account?"}{" "}
                  <button type="button" className="font-medium text-[#1f1b16] underline underline-offset-2 transition-colors hover:text-[#9a3b2e] dark:text-[#f3eee4] dark:hover:text-[#e29a8a]" onClick={() => switchMode(mode === "sign_in" ? "sign_up" : "sign_in")}>{mode === "sign_in" ? "Create one" : "Sign in"}</button>
                </>
              ) : (
                <button type="button" className="font-medium text-[#1f1b16] underline underline-offset-2 transition-colors hover:text-[#9a3b2e] dark:text-[#f3eee4] dark:hover:text-[#e29a8a]" onClick={() => switchMode("sign_in")}>Back to sign in</button>
              )}
            </div>
          </div>
        </div>
      </div>
      <div
        className="relative hidden w-1/2 overflow-hidden border-l border-[#1f1b16]/10 bg-[#171412] text-[#f3eee4] md:flex"
        style={{ backgroundImage: "radial-gradient(640px 280px at 20% 0%, rgba(154, 59, 46, 0.16), transparent 70%), radial-gradient(560px 260px at 88% 8%, rgba(79, 125, 90, 0.14), transparent 72%)" }}
      >
        <div className="m-auto w-full max-w-lg px-12 py-16">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#f3eee4]/12 bg-[#1f1b16]/90 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#d9d1c3] shadow-[inset_0_1px_0_rgba(243,238,228,0.06)]">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#7fae8a] shadow-[0_0_8px_rgba(127,174,138,0.7)]" />
            Paperwork Enterprise
          </div>
          <h2 className="mt-8 text-4xl font-semibold tracking-tight text-[#f3eee4]">Run agent work under enterprise control.</h2>
          <p className="mt-4 text-sm leading-6 text-[#a89f93]">Paperwork connects human operators, AI workers, approvals, and execution systems in one governed control plane.</p>
          <div className="mt-10 space-y-4 tabular-nums">
            {brandItems.map((item, index) => (
              <div key={item.title} className="flex gap-4 rounded-xl border border-[#f3eee4]/10 bg-[#1f1b16]/90 p-4 shadow-[inset_0_1px_0_rgba(243,238,228,0.06),0_10px_28px_-16px_rgba(0,0,0,0.8)]">
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-xs font-semibold ${item.accent}`}>0{index + 1}</div>
                <div>
                  <h3 className="text-sm font-medium text-[#f3eee4]">{item.title}</h3>
                  <p className="mt-1 text-xs leading-5 text-[#a89f93]">{item.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
