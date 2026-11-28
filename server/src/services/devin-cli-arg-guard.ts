export const RESERVED_DEVIN_FLAGS: readonly string[] = [
  "--respect-workspace-trust",
  "--process-model",
  "-p",
  "--prompt",
  "-r",
  "--resume",
  "--model",
  "--permission-mode",
  "--",
];

export interface SanitizedDevinArgsResult {
  safeArgs: string[];
  strippedArgs: string[];
}

const RESERVED_DEVIN_FLAG_SET = new Set<string>(RESERVED_DEVIN_FLAGS);
const COMPACT_SHORT_RESERVED_FLAGS = ["-p", "-r"] as const;

function isEmptyOrUnsafeToken(token: string): boolean {
  return token.trim().length === 0 || token.includes("\0");
}

function equalsFormFlag(token: string): string | null {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex <= 0) return null;
  return token.slice(0, equalsIndex);
}

function isCompactShortReservedFlag(token: string): boolean {
  if (token.length <= 2 || token.startsWith("--")) return false;
  return COMPACT_SHORT_RESERVED_FLAGS.some((flag) => token.startsWith(flag));
}

export function sanitizeDevinExtraArgs(extraArgs: readonly string[]): SanitizedDevinArgsResult {
  const safeArgs: string[] = [];
  const strippedArgs: string[] = [];

  for (let index = 0; index < extraArgs.length; index += 1) {
    const token = extraArgs[index];
    if (isEmptyOrUnsafeToken(token)) continue;

    const equalsFlag = equalsFormFlag(token);
    if ((equalsFlag !== null && RESERVED_DEVIN_FLAG_SET.has(equalsFlag)) || isCompactShortReservedFlag(token)) {
      strippedArgs.push(token);
      continue;
    }

    if (RESERVED_DEVIN_FLAG_SET.has(token)) {
      strippedArgs.push(token);
      if (token !== "--" && index + 1 < extraArgs.length) {
        index += 1;
        strippedArgs.push(extraArgs[index]);
      }
      continue;
    }

    safeArgs.push(token);
  }

  return { safeArgs, strippedArgs };
}
