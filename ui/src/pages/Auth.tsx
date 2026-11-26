import { useEffect, useMemo, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { resolveAuthRedirectPath } from "../lib/auth-redirect";
import { Button } from "@/components/ui/button";
import { Fingerprint, Github, LogIn, Sparkles } from "lucide-react";

type AuthMode = "sign_in" | "sign_up" | "forgot_password" | "reset_password";
const inputClass =
  "w-full rounded-lg border border-slate-200/90 bg-white px-3 py-2 text-sm text-slate-950 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.1] dark:bg-[#07090d] dark:text-[#edf2fb] dark:placeholder:text-[#8b97ad]/60 dark:focus:border-[#60a5fa]/60 dark:focus:ring-[#60a5fa]/25";
const copy: Record<AuthMode, { title: string; body: string; submit: string }> = {
  sign_in: { title: "Sign in to Paperwork", body: "Use your email and password to access this instance.", submit: "Sign In" },
  sign_up: { title: "Create your Paperwork account", body: "Create an account for this instance. Email confirmation is not required in v1.", submit: "Create Account" },
  forgot_password: { title: "Reset your password", body: "Enter your email and we will send a password reset link if the account exists.", submit: "Send Reset Link" },
  reset_password: { title: "Choose a new password", body: "Enter a new password with at least 8 characters.", submit: "Reset Password" },
};
const brandItems = [
  { title: "Workflow orchestration", body: "Coordinate missions, approvals, and execution state in one operating layer.", accent: "border-[#a3e635]/30 bg-[#a3e635]/12 text-[#a3e635]" },
  { title: "Multi-user RBAC", body: "Give people and agents differentiated permissions inside company boundaries.", accent: "border-[#60a5fa]/30 bg-[#60a5fa]/12 text-[#60a5fa]" },
  { title: "Controlled bot terminals", body: "Operate worker terminals through centrally governed execution controls.", accent: "border-[#f59e0b]/35 bg-[#f59e0b]/12 text-[#f59e0b]" },
];

function Field({ id, label, ...props }: InputHTMLAttributes<HTMLInputElement> & { id: string; label: string }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-600 dark:text-[#8b97ad]">
        {label}
      </label>
      <input id={id} className={inputClass} {...props} />
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
  const icon = icons[id.toLowerCase()] ?? <LogIn className={iconClass} aria-hidden="true" />;
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200/90 bg-slate-50 text-slate-800 shadow-xs dark:border-white/[0.1] dark:bg-[#07090d] dark:text-[#edf2fb]">
      {icon}
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
      if (submittedMode === "sign_in") {
        await authApi.signInEmail({ email: email.trim(), password });
        return;
      }
      if (submittedMode === "sign_up") {
        await authApi.signUpEmail({ name: name.trim(), email: email.trim(), password });
        return;
      }
      if (submittedMode === "forgot_password") {
        await authApi.requestPasswordReset({ email: email.trim(), redirectTo: "/auth" });
        return;
      }
      await authApi.resetPassword({ token: resetToken, newPassword: password });
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
      setError(err instanceof Error ? err.message : "Authentication failed");
    },
  });
  const socialMutation = useMutation({
    mutationFn: (provider: string) => signInSocial({ provider, callbackURL: nextPath }),
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Could not start social sign-in");
    },
  });

  const hasRequiredFields =
    mode === "sign_in"
      ? email.trim().length > 0 && password.length > 0
      : mode === "sign_up"
        ? name.trim().length > 0 && email.trim().length > 0 && password.length > 0
        : mode === "forgot_password"
          ? email.trim().length > 0
          : password.length > 0 && confirmPassword.length > 0;
  const validate = () => {
    if (!hasRequiredFields) return "Please fill in all required fields.";
    if (mode === "sign_up" && password.length < 8) return "Password must be at least 8 characters.";
    if (mode === "reset_password") {
      if (!resetToken) return "This reset link is missing a token.";
      if (password.length < 8) return "New password must be at least 8 characters.";
      if (password !== confirmPassword) return "Passwords do not match.";
    }
    return null;
  };
  const switchMode = (nextMode: AuthMode) => {
    setError(null);
    setNotice(null);
    setMode(nextMode);
  };
  const socialProviders = socialProvidersQuery.data ?? [];
  const showSocial = (mode === "sign_in" || mode === "sign_up") && socialProviders.length > 0;

  if (isSessionLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-slate-50 dark:bg-[#07090d]">
        <div className="tactile-card inline-flex items-center gap-2.5 rounded-xl border border-slate-200/90 bg-white px-4 py-2.5 text-sm text-slate-600 shadow-xs dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#8b97ad] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-blue-500 dark:bg-[#60a5fa]" />
          <p>Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex bg-slate-50 text-slate-950 dark:bg-[#07090d] dark:text-[#edf2fb]">
      <div className="flex w-full flex-col overflow-y-auto md:w-1/2">
        <div className="mx-auto my-auto w-full max-w-md px-6 py-10 sm:px-8">
          <div className="tactile-card rounded-2xl border border-slate-200/90 bg-white p-7 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_3px_rgba(15,23,42,0.05)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_18px_48px_-20px_rgba(0,0,0,0.85)] sm:p-8">
            <div className="mb-7 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200/90 bg-slate-50 text-blue-600 dark:border-white/[0.08] dark:bg-[#07090d] dark:text-[#60a5fa]">
                  <Sparkles className="h-3.5 w-3.5" />
                </span>
                <span className="text-sm font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">Paperwork</span>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-lime-500/30 bg-lime-500/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-lime-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/12 dark:text-[#a3e635]">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-lime-500 shadow-[0_0_6px_rgba(163,230,53,0.75)] dark:bg-[#a3e635]" />
                Auth Gateway
              </span>
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">{copy[mode].title}</h1>
            <p className="mt-1.5 text-sm text-slate-600 dark:text-[#8b97ad]">{copy[mode].body}</p>
            <form
              className="mt-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (mutation.isPending) return;
                const validationError = validate();
                if (validationError) {
                  setNotice(null);
                  setError(validationError);
                  return;
                }
                mutation.mutate(mode);
              }}
            >
              {mode === "sign_up" && (
                <Field id="auth-name" label="Name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
              )}
              {mode !== "reset_password" && (
                <Field id="auth-email" label="Email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
              )}
              {mode !== "forgot_password" && (
                <Field
                  id="auth-password"
                  label={mode === "reset_password" ? "New Password" : "Password"}
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                />
              )}
              {mode === "reset_password" && (
                <Field
                  id="auth-confirm-password"
                  label="Confirm Password"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                />
              )}
              {mode === "sign_in" && (
                <div className="text-right">
                  <button
                    type="button"
                    className="text-xs font-medium text-slate-600 underline underline-offset-2 transition-colors hover:text-blue-600 dark:text-[#8b97ad] dark:hover:text-[#60a5fa]"
                    onClick={() => switchMode("forgot_password")}
                  >
                    Forgot password?
                  </button>
                </div>
              )}
              {error && (
                <p
                  role="alert"
                  className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/12 dark:text-rose-300"
                >
                  {error}
                </p>
              )}
              {notice && (
                <p
                  role="status"
                  className="rounded-lg border border-lime-500/30 bg-lime-500/10 px-3 py-2 text-xs text-emerald-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/12 dark:text-[#a3e635]"
                >
                  {notice}
                </p>
              )}
              <Button
                type="submit"
                disabled={mutation.isPending}
                aria-disabled={!hasRequiredFields || mutation.isPending}
                className={`h-10 w-full rounded-lg bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] hover:bg-blue-700 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6] ${!hasRequiredFields && !mutation.isPending ? "opacity-50" : ""}`}
              >
                {mutation.isPending ? "Working…" : copy[mode].submit}
              </Button>
            </form>
            {showSocial && (
              <div className="mt-6">
                <div className="flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500 dark:text-[#8b97ad]">
                  <span className="h-px flex-1 bg-slate-200 dark:bg-white/[0.08]" />
                  <span>or continue with</span>
                  <span className="h-px flex-1 bg-slate-200 dark:bg-white/[0.08]" />
                </div>
                <div className="mt-4 space-y-2">
                  {socialProviders.map((provider) => (
                    <Button
                      key={provider.id}
                      type="button"
                      variant="outline"
                      data-auth-provider={provider.id}
                      className="h-10 w-full justify-start rounded-lg border-border/80 bg-card/70 px-3 shadow-none transition-colors hover:border-primary/50 hover:bg-accent/60 dark:border-border/80 dark:bg-card/70 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] dark:hover:border-primary/50 dark:hover:bg-accent/60"
                      disabled={socialMutation.isPending}
                      onClick={() => socialMutation.mutate(provider.id)}
                    >
                      <ProviderBadge id={provider.id} />
                      <span className="truncate">Continue with {provider.label}</span>
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-6 border-t border-slate-200/80 pt-5 text-sm text-slate-600 dark:border-white/[0.06] dark:text-[#8b97ad]">
              {mode === "sign_in" || mode === "sign_up" ? (
                <>
                  {mode === "sign_in" ? "Need an account?" : "Already have an account?"}{" "}
                  <button
                    type="button"
                    className="font-medium text-slate-950 underline underline-offset-2 transition-colors hover:text-blue-600 dark:text-[#edf2fb] dark:hover:text-[#60a5fa]"
                    onClick={() => switchMode(mode === "sign_in" ? "sign_up" : "sign_in")}
                  >
                    {mode === "sign_in" ? "Create one" : "Sign in"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="font-medium text-slate-950 underline underline-offset-2 transition-colors hover:text-blue-600 dark:text-[#edf2fb] dark:hover:text-[#60a5fa]"
                  onClick={() => switchMode("sign_in")}
                >
                  Back to sign in
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      <div
        className="relative hidden w-1/2 overflow-hidden border-l border-white/[0.06] bg-[#07090d] text-[#edf2fb] md:flex"
        style={{
          backgroundImage:
            "radial-gradient(640px 280px at 20% 0%, rgba(163, 230, 53, 0.08), transparent 70%), radial-gradient(560px 260px at 88% 8%, rgba(96, 165, 250, 0.09), transparent 72%)",
        }}
      >
        <div className="m-auto w-full max-w-lg px-12 py-16">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] bg-[#0e131d]/90 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#c9d3e4] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#a3e635] shadow-[0_0_8px_rgba(163,230,53,0.75)]" />
            Paperwork Enterprise
          </div>
          <h2 className="mt-8 text-4xl font-semibold tracking-tight text-[#edf2fb]">Run agent work under enterprise control.</h2>
          <p className="mt-4 text-sm leading-6 text-[#8b97ad]">
            Paperwork connects human operators, AI workers, approvals, and execution systems in one governed control plane.
          </p>
          <div className="mt-10 space-y-4 tabular-nums">
            {brandItems.map((item, index) => (
              <div
                key={item.title}
                className="flex gap-4 rounded-xl border border-white/[0.08] bg-[#0e131d]/90 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_-16px_rgba(0,0,0,0.8)]"
              >
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-xs font-semibold ${item.accent}`}>
                  0{index + 1}
                </div>
                <div>
                  <h3 className="text-sm font-medium text-[#edf2fb]">{item.title}</h3>
                  <p className="mt-1 text-xs leading-5 text-[#8b97ad]">{item.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
