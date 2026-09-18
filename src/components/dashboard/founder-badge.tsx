import { CrownIcon } from "@/components/icons";

/**
 * O selo circular decorativo do canto do cabeçalho (como o "Founding Member"
 * do layout de referência). Texto em volta via <textPath>, coroa no centro.
 * Puramente visual.
 */
export function FounderBadge() {
  return (
    <div className="relative hidden size-24 shrink-0 sm:block">
      <svg viewBox="0 0 100 100" className="size-full animate-spin text-muted [animation-duration:18s]">
        <defs>
          <path id="founder-ring" d="M50,50 m-37,0 a37,37 0 1,1 74,0 a37,37 0 1,1 -74,0" />
        </defs>
        <text className="fill-current text-[10px] font-semibold uppercase tracking-[0.28em]">
          <textPath href="#founder-ring" startOffset="0%">
            DayOne Pages · Founding Member ·
          </textPath>
        </text>
      </svg>
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-accent/15 text-accent">
          <CrownIcon className="size-5" />
        </span>
      </span>
    </div>
  );
}
