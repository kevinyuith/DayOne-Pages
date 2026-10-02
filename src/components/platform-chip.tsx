/**
 * A platform chip: the traffic source a rule is about (TikTok, Facebook,
 * Google, Taboola…), drawn as a small brand-colored tile with the platform's
 * logo plus its name. The value is a rule's `tags` entry — the Rules screen's
 * Platform column shows one chip per tag, and the filter bar one icon per tag.
 *
 * The logo is the platform's official mark, referenced from Simple Icons
 * (cdn.simpleicons.org), tinted white over the brand-colored tile — not redrawn
 * here. A platform without a logo there (or a tag that isn't a platform, e.g.
 * "Crawler") falls back to its initial on a neutral tile.
 */

/** label = how it's spelled; color = the tile; slug = the Simple Icons slug (null = no logo, use the initial). */
const PLATFORMS: Record<string, { label: string; color: string; slug: string | null }> = {
  tiktok: { label: "TikTok", color: "#111418", slug: "tiktok" },
  facebook: { label: "Facebook", color: "#1877f2", slug: "facebook" },
  meta: { label: "Meta", color: "#1877f2", slug: "meta" },
  google: { label: "Google", color: "#4285f4", slug: "google" },
  youtube: { label: "YouTube", color: "#ff0000", slug: "youtube" },
  snapchat: { label: "Snapchat", color: "#111418", slug: "snapchat" },
  taboola: { label: "Taboola", color: "#0a66c2", slug: null },
  outbrain: { label: "Outbrain", color: "#ee6513", slug: null },
  newsbreak: { label: "NewsBreak", color: "#e5484d", slug: null },
  bing: { label: "Bing", color: "#008373", slug: null },
};

/** The platform a tag names: its display label, tile color and logo slug (unknown tag → its own text, neutral, no logo). */
export function platformMeta(tag: string): { label: string; color: string; slug: string | null } {
  return PLATFORMS[tag.trim().toLowerCase()] ?? { label: tag, color: "#64748b", slug: null };
}

/** The brand tile only (the colored square with the logo or initial) — used on its own in the filter bar. */
export function PlatformTile({ tag }: { tag: string }) {
  const { label, color, slug } = platformMeta(tag);
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-md ring-1 ring-inset ring-white/15"
      style={{ backgroundColor: color }}
    >
      {slug ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`https://cdn.simpleicons.org/${slug}/ffffff`} alt="" width={13} height={13} className="size-[13px]" loading="lazy" />
      ) : (
        <span className="text-[11px] font-bold leading-none text-white">{label.charAt(0).toUpperCase()}</span>
      )}
    </span>
  );
}

export function PlatformChip({ tag }: { tag: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium">
      <PlatformTile tag={tag} />
      {platformMeta(tag).label}
    </span>
  );
}
