import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppVersionBadge } from "./AppVersionBadge";

describe("AppVersionBadge", () => {
  it("renders the Paperwork version when health provides one", () => {
    const html = renderToStaticMarkup(<AppVersionBadge version="0.3.2" />);

    expect(html).toContain("v0.3.2");
    expect(html).toContain('aria-label="Paperwork version v0.3.2"');
  });

  it("renders nothing when the health version is missing", () => {
    const html = renderToStaticMarkup(<AppVersionBadge />);

    expect(html).toBe("");
  });
});
