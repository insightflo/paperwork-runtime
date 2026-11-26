import { useEffect } from "react";

interface ShortcutHandlers {
  onNewIssue?: () => void;
  onToggleSidebar?: () => void;
  onTogglePanel?: () => void;
  onNavigateWorkspace?: (index: 1 | 2 | 3 | 4 | 5) => void;
}

export function useKeyboardShortcuts({
  onNewIssue,
  onToggleSidebar,
  onTogglePanel,
  onNavigateWorkspace,
}: ShortcutHandlers) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      // Don't fire shortcuts when typing in inputs
      const target = e.target as HTMLElement | null;
      if (
        !target ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      ) {
        return;
      }

      // 1–5 → Primary workspace navigation
      if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4" || e.key === "5") {
          e.preventDefault();
          onNavigateWorkspace?.(Number(e.key) as 1 | 2 | 3 | 4 | 5);
          return;
        }
      }

      // C → New Issue
      if (e.key === "c" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onNewIssue?.();
      }

      // [ → Toggle Sidebar
      if (e.key === "[" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onToggleSidebar?.();
      }

      // ] → Toggle Panel
      if (e.key === "]" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onTogglePanel?.();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onNewIssue, onToggleSidebar, onTogglePanel, onNavigateWorkspace]);
}
