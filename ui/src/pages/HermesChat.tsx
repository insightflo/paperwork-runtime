import { HermesChatPanel } from "../components/HermesChatPanel";

const cockpitSurfaceOverrides =
  "[&>div.overflow-hidden.border.border-border.bg-background]:rounded-[12px] " +
  "[&>div.overflow-hidden.border.border-border.bg-background]:border-slate-200/90 " +
  "[&>div.overflow-hidden.border.border-border.bg-background]:bg-white " +
  "[&>div.overflow-hidden.border.border-border.bg-background]:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] " +
  "dark:[&>div.overflow-hidden.border.border-border.bg-background]:border-white/[0.08] " +
  "dark:[&>div.overflow-hidden.border.border-border.bg-background]:bg-[#0e131d] " +
  "dark:[&>div.overflow-hidden.border.border-border.bg-background]:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)] " +
  "[&_aside.bg-card]:border-slate-200/80 [&_aside.bg-card]:bg-slate-50/90 " +
  "dark:[&_aside.bg-card]:border-white/[0.08] dark:[&_aside.bg-card]:bg-[#090c12] " +
  "[&_.h-12.border-b.border-border]:border-slate-200/80 [&_.h-12.border-b.border-border]:bg-slate-50/90 " +
  "dark:[&_.h-12.border-b.border-border]:border-white/[0.08] dark:[&_.h-12.border-b.border-border]:bg-[#090c12] " +
  "[&_section>div:nth-child(2)]:border-slate-200/80 [&_section>div:nth-child(2)]:bg-slate-50/70 " +
  "dark:[&_section>div:nth-child(2)]:border-white/[0.08] dark:[&_section>div:nth-child(2)]:bg-[#090c12]/85 " +
  "[&_.border-border.bg-card.text-card-foreground]:rounded-[12px] [&_.border-border.bg-card.text-card-foreground]:border-slate-200/90 " +
  "[&_.border-border.bg-card.text-card-foreground]:bg-white [&_.border-border.bg-card.text-card-foreground]:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] " +
  "dark:[&_.border-border.bg-card.text-card-foreground]:border-white/[0.08] dark:[&_.border-border.bg-card.text-card-foreground]:bg-[#101722] " +
  "dark:[&_.border-border.bg-card.text-card-foreground]:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_20px_-12px_rgba(0,0,0,0.65)] " +
  "[&_.bg-primary.text-primary-foreground]:bg-blue-600 [&_.bg-primary.text-primary-foreground]:shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] " +
  "dark:[&_.bg-primary.text-primary-foreground]:bg-[#60a5fa] dark:[&_.bg-primary.text-primary-foreground]:text-[#07111f] " +
  "[&_button.w-full.border-b.border-border]:border-slate-200/70 [&_button.w-full.border-b.border-border:hover]:bg-slate-100/80 " +
  "dark:[&_button.w-full.border-b.border-border]:border-white/[0.06] dark:[&_button.w-full.border-b.border-border:hover]:bg-[#141b29] " +
  "[&_button.bg-accent.text-accent-foreground]:bg-blue-50 [&_button.bg-accent.text-accent-foreground]:text-blue-950 " +
  "[&_button.bg-accent.text-accent-foreground]:shadow-[inset_2px_0_0_#2563eb] " +
  "dark:[&_button.bg-accent.text-accent-foreground]:bg-[#60a5fa]/12 dark:[&_button.bg-accent.text-accent-foreground]:text-[#edf2fb] " +
  "dark:[&_button.bg-accent.text-accent-foreground]:shadow-[inset_2px_0_0_#60a5fa] " +
  "[&_.sticky.bottom-0.bg-card]:border-slate-200/80 [&_.sticky.bottom-0.bg-card]:bg-white/95 " +
  "dark:[&_.sticky.bottom-0.bg-card]:border-white/[0.08] dark:[&_.sticky.bottom-0.bg-card]:bg-[#090c12]/95 " +
  "[&_textarea]:rounded-[12px] [&_textarea]:border-slate-200/90 [&_textarea]:bg-white [&_textarea]:shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)] " +
  "dark:[&_textarea]:border-white/[0.09] dark:[&_textarea]:bg-[#0e131d] dark:[&_textarea]:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] " +
  "[&_textarea:focus-visible]:border-blue-500 [&_textarea:focus-visible]:ring-blue-500/20 " +
  "dark:[&_textarea:focus-visible]:border-[#60a5fa] dark:[&_textarea:focus-visible]:ring-[#60a5fa]/25 " +
  "[&_pre]:rounded-lg [&_pre]:border [&_pre]:border-slate-200/80 [&_pre]:bg-slate-100/80 " +
  "dark:[&_pre]:border-white/[0.08] dark:[&_pre]:bg-[#090c12] " +
  "[&_.max-w-4xl]:max-w-5xl";

export function HermesChat() {
  return (
    <div className={`h-full min-h-0 tabular-nums ${cockpitSurfaceOverrides}`}>
      <HermesChatPanel mode="page" />
    </div>
  );
}
