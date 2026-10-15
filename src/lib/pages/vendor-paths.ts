/**
 * Where a vendor page and its upsell funnel's steps are served (shared by the
 * screen, the actions and scripts/check-vendor.mts — no imports, so Node runs
 * it as is). The database has the same rules: pages.vendor_page_folder and the
 * aliases block of pages.upsell_config_check; the delivery server matches the
 * paths (server/src/upsell.php upsell_step_paths). Change one, change the others.
 *
 * - A vendor page's FOLDER: the platforms of one product live side by side on a
 *   domain (the root, /cp/, /bg/), so a page with no "/" slug whose slugs all
 *   share their first segment lives in that folder ("/bg"); any other page lives
 *   at the root (""). Its landing is the folder's root ("/bg", or "/").
 * - A step keeps its canonical path (/up1 … /up5, /thank-you) and is also served
 *   at its ALIASES: implicitly at <folder> + <canonical path> (/bg/up1), and at
 *   the explicit ones the config lists (`aliases`: the URLs already registered on
 *   the platforms, e.g. /bg/up1v2 → Upsell 1).
 */

/** The canonical path of each step (stepPath in upsell-types.ts). */
export const STEP_CANONICAL_PATHS = ["/up1", "/up2", "/up3", "/up4", "/up5", "/thank-you"] as const;

/** An explicit alias: a path below the root, lowercase (the same characters as a slug). */
export const ALIAS_RE = /^(\/[a-z0-9._~-]+)+$/;
export const ALIAS_MAX_LENGTH = 200;
export const MAX_ALIASES = 10;

/** The folder a vendor page lives in ("/bg"), or "" for the root: see the top of the file. */
export function vendorFolder(slugs: readonly string[]): string {
  if (slugs.length === 0 || slugs.includes("/")) return "";
  const first = new Set(slugs.map((s) => s.split("/")[1] ?? ""));
  const [only] = [...first];
  return first.size === 1 && only ? `/${only}` : "";
}

/** The landing of a vendor page: its folder's root. */
export function landingPath(folder: string): string {
  return folder || "/";
}

/**
 * Why `alias` can't be an alias of the step whose canonical path is
 * `canonical`; null = it can. It is never a step's canonical path, nor ends
 * with another step's (that one's implicit alias, or a tail the gate already
 * reads as that step).
 */
export function aliasProblem(canonical: string, alias: string): string | null {
  if (!ALIAS_RE.test(alias)) return `“${alias.slice(0, 60)}” is not a path like /bg/up1v2 (lowercase letters, digits, . _ ~ -).`;
  if (alias.length > ALIAS_MAX_LENGTH) return `An alias has at most ${ALIAS_MAX_LENGTH} characters.`;
  if (alias === canonical) return `${alias} is the step's own path.`;
  const other = STEP_CANONICAL_PATHS.find((c) => c !== canonical && alias.endsWith(c));
  if (other) return `${alias} ends with ${other}, another step's path.`;
  return null;
}

/**
 * Why a config's aliases can't be saved (each step's canonical path and its
 * aliases); null = they can. At most MAX_ALIASES per step, each valid, none in
 * two places of the funnel.
 */
export function aliasesProblem(steps: readonly { canonical: string; aliases: readonly string[] }[]): string | null {
  const seen = new Set<string>();
  for (const s of steps) {
    if (s.aliases.length > MAX_ALIASES) return `At most ${MAX_ALIASES} aliases per step.`;
    for (const a of s.aliases) {
      const problem = aliasProblem(s.canonical, a);
      if (problem) return problem;
      if (seen.has(a)) return `${a} is listed twice.`;
      seen.add(a);
    }
  }
  return null;
}

/** Every path a step is served at: its canonical path, the implicit alias in the page's folder, then the explicit ones. */
export function stepPaths(canonical: string, folder: string, aliases: readonly string[] = []): string[] {
  return [...new Set([canonical, ...(folder ? [folder + canonical] : []), ...aliases])];
}
