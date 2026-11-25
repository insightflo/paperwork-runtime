import { useEffect, useMemo, useState, type InputHTMLAttributes } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { resolveAuthRedirectPath } from "../lib/auth-redirect";
import { Button } from "@/components/ui/button";
import { LogIn, Sparkles } from "lucide-react";

type AuthMode = "sign_in" | "sign_up" | "forgot_password" | "reset_password";
const inputClass = "w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50";
const copy: Record<AuthMode, { title: string; body: string; submit: string }> = {
  sign_in: { title: "Sign in to Paperwork", body: "Use your email and password to access this instance.", submit: "Sign In" },
  sign_up: { title: "Create your Paperwork account", body: "Create an account for this instance. Email confirmation is not required in v1.", submit: "Create Account" },
  forgot_password: { title: "Reset your password", body: "Enter your email and we will send a password reset link if the account exists.", submit: "Send Reset Link" },
  reset_password: { title: "Choose a new password", body: "Enter a new password with at least 8 characters.", submit: "Reset Password" },
};
const brandItems = [
  { title: "Workflow orchestration", body: "Coordinate missions, approvals, and execution state in one operating layer." },
  { title: "Multi-user RBAC", body: "Give people and agents differentiated permissions inside company boundaries." },
  { title: "Controlled bot terminals", body: "Operate worker terminals through centrally governed execution controls." },
];

function Field({ id, label, ...props }: InputHTMLAttributes<HTMLInputElement> & { id: string; label: string }) {
  return (
    <div>
      <label htmlFor={id} className="text-xs text-muted-foreground mb-1 block">{label}</label>
      <input id={id} className={inputClass} {...props} />
    </div>
  );
}

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
    mutationFn: (provider: string) => authApi.startSocialSignIn({ provider, callbackURL: nextPath }),
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
      <div className="fixed inset-0 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex bg-background">
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Paperwork</span>
          </div>
          <h1 className="text-xl font-semibold">{copy[mode].title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{copy[mode].body}</p>
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
                <button type="button" className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => switchMode("forgot_password")}>
                  Forgot password?
                </button>
              </div>
            )}
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            {notice && <p role="status" className="text-xs text-emerald-600">{notice}</p>}
            <Button
              type="submit"
              disabled={mutation.isPending}
              aria-disabled={!hasRequiredFields || mutation.isPending}
              className={`w-full ${!hasRequiredFields && !mutation.isPending ? "opacity-50" : ""}`}
            >
              {mutation.isPending ? "Working…" : copy[mode].submit}
            </Button>
          </form>
          {showSocial && (
            <div className="mt-6">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>or continue with</span>
                <span className="h-px flex-1 bg-border" />
              </div>
              <div className="mt-4 space-y-2">
                {socialProviders.map((provider) => (
                  <Button key={provider.id} type="button" variant="outline" className="w-full" disabled={socialMutation.isPending} onClick={() => socialMutation.mutate(provider.id)}>
                    <LogIn className="h-4 w-4" aria-hidden="true" />
                    Continue with {provider.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <div className="mt-5 text-sm text-muted-foreground">
            {mode === "sign_in" || mode === "sign_up" ? (
              <>
                {mode === "sign_in" ? "Need an account?" : "Already have an account?"}{" "}
                <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => switchMode(mode === "sign_in" ? "sign_up" : "sign_in")}>
                  {mode === "sign_in" ? "Create one" : "Sign in"}
                </button>
              </>
            ) : (
              <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => switchMode("sign_in")}>
                Back to sign in
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="hidden md:flex w-1/2 overflow-hidden bg-slate-950 text-white">
        <div className="m-auto w-full max-w-lg px-12 py-16">
          <div className="inline-flex rounded-full border border-white/15 px-3 py-1 text-xs uppercase tracking-[0.24em] text-white/70">Paperwork Enterprise</div>
          <h2 className="mt-8 text-4xl font-semibold tracking-tight">Run agent work under enterprise control.</h2>
          <p className="mt-4 text-sm leading-6 text-white/65">
            Paperwork connects human operators, AI workers, approvals, and execution systems in one governed control plane.
          </p>
          <div className="mt-10 space-y-5">
            {brandItems.map((item, index) => (
              <div key={item.title} className="flex gap-4 rounded-xl border border-white/10 bg-white/[0.04] p-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-semibold">{index + 1}</div>
                <div>
                  <h3 className="text-sm font-medium">{item.title}</h3>
                  <p className="mt-1 text-xs leading-5 text-white/60">{item.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
