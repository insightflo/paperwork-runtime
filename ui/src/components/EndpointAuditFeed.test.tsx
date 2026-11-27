// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EndpointAuditFeed, type EndpointAuditItem } from "./EndpointAuditFeed";

const item: EndpointAuditItem = {
  id: "audit-1",
  botName: "내 노트북 봇",
  kind: "read_file",
  targetPath: "/Users/me/notes.txt",
  outcome: "completed",
  summary: "메모 파일을 읽었습니다",
  createdAt: "2026-11-28T03:04:05Z",
};

function render(items: EndpointAuditItem[], maxItems?: number) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <EndpointAuditFeed items={items} maxItems={maxItems} className="audit-feed-test" />,
  );
  return host;
}

describe("EndpointAuditFeed", () => {
  it("renders a clean empty state and forwards className", () => {
    const host = render([]);
    expect(host.textContent).toBe("최근 단말 로컬 작업 기록이 없습니다");
    expect(host.querySelector('[role="listitem"]')).toBeNull();
    expect(host.querySelector(".audit-feed-test")).not.toBeNull();
    expect(host.textContent).not.toMatch(/paperclip/i);
  });

  it("renders every outcome, action label, bot, path, summary, and timestamp", () => {
    const items: EndpointAuditItem[] = [
      item,
      { ...item, id: "blocked", kind: "write_file", outcome: "denied" },
      { ...item, id: "failed", kind: "shell_exec", outcome: "failed" },
      { ...item, id: "queued", kind: "list_dir", outcome: "enqueued" },
    ];
    const host = render(items);
    expect(host.querySelector('[role="list"]')).not.toBeNull();
    const rows = host.querySelectorAll('[role="listitem"]');
    expect(rows).toHaveLength(4);
    const outcomes = ["완료", "정책 차단", "실패", "대기 중"];
    const kinds = ["파일 읽기", "파일 쓰기", "명령 실행", "폴더 목록"];
    rows.forEach((row, index) => {
      expect(row.textContent).toContain(outcomes[index]);
      expect(row.textContent).toContain(kinds[index]);
      expect(row.textContent).toContain(item.botName);
      expect(row.textContent).toContain(item.summary);
      expect(row.querySelector("code")?.textContent).toBe(item.targetPath);
      expect(row.querySelector("code")?.className).toContain("font-mono");
      expect(row.querySelector("time")?.getAttribute("datetime")).toBe(item.createdAt);
      expect(row.querySelector("time")?.textContent).toBe(
        new Date(item.createdAt).toLocaleString("ko-KR"),
      );
    });
    expect(host.textContent).not.toMatch(/paperclip/i);
    expect(host.querySelector(".audit-feed-test")).not.toBeNull();
  });

  it("limits the feed to maxItems while preserving supplied order", () => {
    const items = Array.from({ length: 4 }, (_, index) => ({
      ...item, id: `audit-${index}`, summary: `기록 ${index}`,
    }));
    const host = render(items, 2);
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    expect(host.textContent).toContain("기록 0");
    expect(host.textContent).toContain("기록 1");
    expect(host.textContent).not.toContain("기록 2");
    expect(host.textContent).not.toContain("기록 3");
  });

  it("defaults to at most 20 items", () => {
    const items = Array.from({ length: 23 }, (_, index) => ({
      ...item, id: `audit-${index}`,
    }));
    expect(render(items).querySelectorAll('[role="listitem"]')).toHaveLength(20);
  });

  it("displays no rows when maxItems is zero", () => {
    expect(render([item], 0).querySelectorAll('[role="listitem"]')).toHaveLength(0);
  });
});
