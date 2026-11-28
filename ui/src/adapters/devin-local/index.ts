import type { UIAdapterModule } from "../types";
import { parseDevinStdoutLine } from "./parse-stdout";
import { DevinLocalConfigFields } from "./config-fields";
import { buildDevinLocalConfig } from "./build-config";

export const devinLocalUIAdapter: UIAdapterModule = {
  type: "devin_local",
  label: "Devin (local)",
  parseStdoutLine: parseDevinStdoutLine,
  ConfigFields: DevinLocalConfigFields,
  buildAdapterConfig: buildDevinLocalConfig,
};
