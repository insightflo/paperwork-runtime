import { useRef, useState } from "react";

type OperatingSystem = "macOS" | "Linux" | "Windows";

const DEFAULT_NAMES: Record<OperatingSystem, string> = {
  macOS: "my-mac",
  Linux: "my-linux",
  Windows: "my-windows",
};

function quoteBash(value: string) {
  return /^[A-Za-z0-9_./:~+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function quoteBashFolder(value: string) {
  return value.startsWith("~/") ? `~/${quoteBash(value.slice(2))}` : quoteBash(value);
}

function quotePowerShell(value: string) {
  return /^[A-Za-z0-9_./:~+-]+$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
}

export function EndpointBotPairingCard() {
  const [os, setOs] = useState<OperatingSystem>("macOS");
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("~/Projects");
  const [copied, setCopied] = useState<{ command: string; version: number } | null>(null);
  const [copyError, setCopyError] = useState<{ command: string; version: number } | null>(null);
  const revision = useRef({ command: "", version: 0 });
  const attempt = useRef(0);

  const effectiveName = name.trim() || DEFAULT_NAMES[os];
  const effectiveFolder = folder.trim() || "~/Projects";
  const origin = window.location.origin;
  const command = os === "Windows"
    ? `paperwork-bot init --server ${quotePowerShell(origin)} --name ${quotePowerShell(effectiveName)} --folder ${quotePowerShell(effectiveFolder)}`
    : `bash scripts/install-paperwork-bot.sh --server ${quoteBash(origin)} --name ${quoteBash(effectiveName)} --folder ${quoteBashFolder(effectiveFolder)}`;

  if (revision.current.command !== command) {
    revision.current = { command, version: revision.current.version + 1 };
  }

  const copyCommand = async () => {
    const version = revision.current.version;
    const request = ++attempt.current;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(command);
      if (revision.current.version === version && attempt.current === request) {
        setCopied({ command, version });
        setCopyError(null);
      }
    } catch {
      if (revision.current.version === version && attempt.current === request) {
        setCopyError({ command, version });
        setCopied(null);
      }
    }
  };

  const isCopied = copied?.command === command && copied.version === revision.current.version;
  const hasCopyError = copyError?.command === command && copyError.version === revision.current.version;

  return (
    <section aria-label="개인 단말 봇 설치 · 연결" className="rounded-xl border border-border bg-card p-4 text-foreground shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">개인 단말 봇 설치 · 연결 (Rust 네이티브)</h2>
          <p className="mt-1 text-sm text-muted-foreground">운영체제를 고르고 설치 명령을 복사해 단말에서 실행하세요.</p>
        </div>
        <div aria-label="운영체제 선택" className="flex gap-1 rounded-lg bg-muted p-1">
          {(["macOS", "Linux", "Windows"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-label={option}
              aria-pressed={os === option}
              onClick={() => setOs(option)}
              className={`rounded-md px-3 py-1.5 text-sm ${os === option ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium">
          단말 이름
          <input aria-label="단말 이름" value={name} placeholder={DEFAULT_NAMES[os]} onChange={(event) => setName(event.target.value)} className="h-9 rounded-md border border-border bg-background px-3 text-foreground placeholder:text-muted-foreground" />
        </label>
        <label className="grid gap-1 text-sm font-medium">
          허용 작업 폴더
          <input aria-label="허용 작업 폴더" value={folder} onChange={(event) => setFolder(event.target.value)} className="h-9 rounded-md border border-border bg-background px-3 text-foreground" />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-start gap-2">
        <pre aria-label="설치 명령" className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-muted p-3 text-xs text-foreground"><code>{command}</code></pre>
        <button type="button" aria-label="명령 복사" onClick={copyCommand} className="inline-flex h-9 shrink-0 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90">
          {isCopied ? "복사됨" : "명령 복사"}
        </button>
      </div>
      {os === "Windows" && <p className="mt-2 text-xs text-muted-foreground">Windows PowerShell에서 실행하세요.</p>}
      {hasCopyError && <p role="alert" className="mt-2 text-sm text-destructive">클립보드를 사용할 수 없습니다. 명령을 직접 선택해 복사해 주세요.</p>}

      <ol className="mt-4 grid gap-1 text-sm text-muted-foreground">
        <li>① 단말에 봇을 설치합니다.</li>
        <li>② 봇이 접근할 수 있는 허용 폴더를 지정합니다.</li>
        <li>③ 스레드 채널에서 @단말명 호출로 로컬 작업을 실행합니다.</li>
      </ol>
    </section>
  );
}
