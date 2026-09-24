import { createClient } from "@supabase/supabase-js";

/**
 * The service client — the ONLY Supabase client in this project.
 *
 * There's no login in Supabase or in the dashboard: every read and write goes
 * through here, with the service key.
 *
 * The service key has BYPASSRLS. In plain words, that means: the RLS of the
 * `pages` schema protects nothing this module does, and the dashboard itself
 * asks for no password. What protects the dashboard is the network in front of
 * the deploy (Cloudflare Access, IP allowlist). Without it, anyone with the URL
 * can edit everything.
 *
 * Three guards keep the key out of the browser:
 *   1. `SUPABASE_SERVICE_KEY` has no NEXT_PUBLIC_ prefix — Next doesn't inline
 *      it into the client bundle.
 *   2. The `typeof window` guard below crashes right away if this module ever
 *      ends up in a client bundle.
 *   3. `npm run check:secrets` looks for the value in `.next/static/` after the
 *      build. It's the only one of the three that is proof, not intent.
 *
 * No module-level cache: one instance per call. A client kept across requests
 * would carry one request's state into another.
 */

if (typeof window !== "undefined") {
  throw new Error("src/lib/supabase/service.ts was imported in the browser. This module is server-only.");
}

export const SERVICE_KEY_VAR = "SUPABASE_SERVICE_KEY";

/** Configured? A boolean, never the value. */
export function serviceConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env[SERVICE_KEY_VAR]);
}

/** A new client, bound to the `pages` schema, with the service key. */
export function supabaseService() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env[SERVICE_KEY_VAR];

  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is missing.");
  if (!key) throw new Error(`${SERVICE_KEY_VAR} is missing.`);

  return createClient(url, key, {
    db: { schema: "pages" },
    // There's no user on this connection, just a key: nothing to persist or refresh.
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
