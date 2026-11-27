import { cn } from "../lib/utils";

interface PapercompanyLogoIconProps {
  className?: string;
}

/** Paperwork mark: folded sheet, ruled lines, and an oxblood seal. Same geometry as `public/favicon.svg`. */
export function PapercompanyLogoIcon({ className }: PapercompanyLogoIconProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={cn("block", className)}
    >
      <path d="M11 4.5h33.5L57 17v42.5H11z" fill="#f6f1e7" />
      <path d="M44.5 4.5V17H57" fill="#e4dccb" />
      <path
        d="M11 4.5h33.5L57 17v42.5H11z"
        stroke="#1f1b16"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path
        d="M44.5 4.5V17H57"
        stroke="#1f1b16"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path
        d="M19 28h26M19 36h26M19 44h14"
        stroke="#1f1b16"
        strokeOpacity=".55"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="46" cy="49" r="8" fill="#9a3b2e" />
      <circle cx="46" cy="49" r="4" stroke="#f6f1e7" strokeWidth="1.6" />
    </svg>
  );
}
