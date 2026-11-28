import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageJson {
  bin?: Record<string, string>;
}

function readCliPackageJson(): PackageJson {
  const packageJsonUrl = new URL("../../package.json", import.meta.url);
  return JSON.parse(readFileSync(packageJsonUrl, "utf8")) as PackageJson;
}

describe("cli package.json bin aliases", () => {
  it("exposes paperwork as a bin entry pointing at the CLI entrypoint", () => {
    const pkg = readCliPackageJson();
    expect(pkg.bin?.paperwork).toBe("./dist/index.js");
  });

  it("keeps the legacy paperclipai bin entry for backward compatibility", () => {
    const pkg = readCliPackageJson();
    expect(pkg.bin?.paperclipai).toBe("./dist/index.js");
  });

  it("points both bin aliases at the same entrypoint", () => {
    const pkg = readCliPackageJson();
    expect(pkg.bin?.paperwork).toBe(pkg.bin?.paperclipai);
  });
});
