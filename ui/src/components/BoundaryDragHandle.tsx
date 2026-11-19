import { useEffect, useRef } from "react";
import { MoveHorizontal } from "lucide-react";
import { NAV_EXPANDED_WIDTH_PX } from "../lib/sidebar-slide-physics";

const KEYBOARD_STEP_PX = 24;

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
  lastX: number;
  lastT: number;
  velocity: number;
  current: number;
}

export function BoundaryDragHandle(props: {
  width: number;
  onPreview: (width: number) => void;
  onCommit: (width: number, velocityPxPerMs: number) => void;
  onToggle: () => void;
}) {
  const dragRef = useRef<DragState | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth: props.width,
      lastX: e.clientX,
      lastT: e.timeStamp,
      velocity: 0,
      current: props.width,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture unavailable (SSR / synthetic events) — drag still works.
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dt = e.timeStamp - drag.lastT;
    if (dt > 0) drag.velocity = drag.velocity * 0.6 + ((e.clientX - drag.lastX) / dt) * 0.4;
    drag.lastX = e.clientX;
    drag.lastT = e.timeStamp;
    drag.current = Math.min(NAV_EXPANDED_WIDTH_PX, Math.max(0, drag.startWidth + (e.clientX - drag.startX)));
    props.onPreview(drag.current);
  };

  const finishDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    props.onCommit(drag.current, drag.velocity);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      props.onCommit(Math.max(0, props.width - KEYBOARD_STEP_PX), -0.5);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      props.onCommit(Math.min(NAV_EXPANDED_WIDTH_PX, props.width + KEYBOARD_STEP_PX), 0.5);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      props.onToggle();
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="사이드바 너비 조절"
      aria-valuenow={Math.round(props.width)}
      aria-valuemin={0}
      aria-valuemax={NAV_EXPANDED_WIDTH_PX}
      title="드래그로 너비 조절 · 더블클릭 접기/펼치기"
      tabIndex={0}
      className="group relative hidden md:flex w-2 shrink-0 cursor-col-resize select-none items-stretch justify-center outline-none focus-visible:bg-accent/40"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onDoubleClick={props.onToggle}
      onKeyDown={onKeyDown}
    >
      <span
        className="my-3 w-[3px] rounded-full transition-colors group-hover:brightness-110 group-focus-visible:brightness-110"
        style={{ backgroundColor: "var(--openbot-drag-handle-bg)" }}
      />
      <span
        className="pointer-events-none absolute left-1/2 top-1/2 flex h-7 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        style={{ backgroundColor: "var(--openbot-drag-handle-hover)", color: "var(--openbot-drag-handle-fg)" }}
      >
        <MoveHorizontal className="h-3 w-3" />
      </span>
    </div>
  );
}

/** Mobile edge swipe: open sidebar by swiping right from the left edge, close by swiping left. */
export function useMobileEdgeSwipe(isMobile: boolean, sidebarOpen: boolean, setSidebarOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!isMobile || typeof document === "undefined") return;
    let startX = 0;
    let startY = 0;
    const onTouchStart = (e: TouchEvent) => {
      startX = e.touches[0]!.clientX;
      startY = e.touches[0]!.clientY;
    };
    const onTouchEnd = (e: TouchEvent) => {
      const dx = e.changedTouches[0]!.clientX - startX;
      if (Math.abs(e.changedTouches[0]!.clientY - startY) > 75) return;
      if (!sidebarOpen && startX < 30 && dx > 50) setSidebarOpen(true);
      else if (sidebarOpen && dx < -50) setSidebarOpen(false);
    };
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [isMobile, sidebarOpen, setSidebarOpen]);
}
