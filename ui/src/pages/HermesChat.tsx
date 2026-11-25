import { HermesChatPanel } from "../components/HermesChatPanel";

const cockpitSurfaceOverrides =
  "[&>div.overflow-hidden.border.border-border.bg-background]:border-border/80 " +
  "[&>div.overflow-hidden.border.border-border.bg-background]:bg-card/60 " +
  "[&_.h-12.border-b.border-border]:border-border/80 " +
  "[&_.h-12.border-b.border-border]:bg-card/60";

export function HermesChat() {
  return (
    <div className={cockpitSurfaceOverrides}>
      <HermesChatPanel mode="page" />
    </div>
  );
}
