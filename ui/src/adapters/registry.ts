import type { UIAdapterModule } from "./types";
import { claudeLocalUIAdapter } from "./claude-local";
import { codexLocalUIAdapter } from "./codex-local";
import { piLocalUIAdapter } from "./pi-local";
import { devinLocalUIAdapter } from "./devin-local";
import { commandCodeLocalUIAdapter } from "./commandcode-local";
import { processUIAdapter } from "./process";
import { httpUIAdapter } from "./http";

const uiAdapters: UIAdapterModule[] = [
  claudeLocalUIAdapter,
  codexLocalUIAdapter,
  piLocalUIAdapter,
  devinLocalUIAdapter,
  commandCodeLocalUIAdapter,
  processUIAdapter,
  httpUIAdapter,
];

const adaptersByType = new Map<string, UIAdapterModule>(
  uiAdapters.map((a) => [a.type, a]),
);

export function getUIAdapter(type: string): UIAdapterModule {
  return adaptersByType.get(type) ?? processUIAdapter;
}

export function listUIAdapters(): UIAdapterModule[] {
  return [...uiAdapters];
}
