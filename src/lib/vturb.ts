import { supabaseService } from "@/lib/supabase/service";

/**
 * VTurb control API — server-only client for the funnels' A/B tests.
 *
 * Base https://api.vturb.com/vturb (VTurb's own web app API; not a public,
 * documented one). Auth: Bearer JWT (12 h) from pages.vturb_token(). Never
 * sent to the browser.
 *
 * A funnel's A/B test is a "comparison group": its players (one per video,
 * `traffic_percentage`) and a `tree` that carries the same % again
 * (`children[].weight` and its child's `weight`). The PUT replaces the whole
 * group, so a write is always GET → change → PUT of the full object. VTurb
 * refuses a group whose % don't add up to exactly 100.
 */

const BASE = "https://api.vturb.com/vturb";
const ID_RE = /^[0-9a-f]{24}$/;
export const isVturbId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

type RawPlayer = { player_id: string; traffic_percentage: number; details?: { name?: string | null; [k: string]: unknown }; [k: string]: unknown };
type RawNode = { player_id: string; weight: number; children?: RawNode[]; [k: string]: unknown };
type RawGroup = { id: string; name?: string; players?: RawPlayer[]; tree?: { children?: RawNode[]; [k: string]: unknown }; [k: string]: unknown };

/** The replica kept in pages.funnels.vsl: { player id: { weight, name } }. */
export type VslReplica = Record<string, { weight: number; name: string | null }>;

async function token(): Promise<string> {
  const { data, error } = await supabaseService().rpc("vturb_token");
  if (error) throw new Error(`VTurb token: ${error.message}`);
  if (typeof data !== "string" || !data) throw new Error("There is no VTurb token.");
  return data;
}

/** A call to the API, retrying 429/5xx (up to 3 times, with backoff). */
async function call(method: "GET" | "PUT", path: string, body?: unknown): Promise<unknown> {
  const jwt = await token();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (res.status === 401) throw new Error("VTurb refused the token (it may have expired). Try again in a few minutes.");
    if (res.status === 404) throw new Error("VTurb didn't find it.");
    throw new Error(`VTurb answered ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function getGroup(groupId: string): Promise<RawGroup> {
  const j = (await call("GET", `/v2/comparisons_groups/${groupId}`)) as Record<string, unknown>;
  return (j.comparison_group ?? j.comparisons_group ?? j) as RawGroup;
}

/** The replica of a group: each player's % and name. */
function replicaOf(group: RawGroup): VslReplica {
  return Object.fromEntries(
    (group.players ?? []).map((p) => [p.player_id, { weight: Number(p.traffic_percentage) || 0, name: p.details?.name ?? null }]),
  );
}

/** The funnel's A/B test as VTurb has it now. */
export async function readTest(groupId: string): Promise<VslReplica> {
  return replicaOf(await getGroup(groupId));
}

/** A video (player) by id: its name, to show before adding it to a test. */
export async function findVideo(playerId: string): Promise<{ id: string; name: string | null }> {
  const j = (await call("GET", `/v2/players/${playerId}`)) as Record<string, unknown>;
  const p = (j.player ?? j) as Record<string, unknown>;
  return { id: String(p.id ?? playerId), name: typeof p.name === "string" ? p.name : null };
}

/** The entry and tree node of a player that joins the group (as VTurb's own app builds them). */
async function newArm(playerId: string): Promise<{ player: RawPlayer; node: RawNode }> {
  const pj = (await call("GET", `/v2/players/${playerId}`)) as Record<string, unknown>;
  const pl = (pj.player ?? pj) as Record<string, unknown>;
  const videoId = typeof pl.video_id === "string" ? pl.video_id : "";
  const vj = videoId ? ((await call("GET", `/v2/videos/${videoId}`)) as Record<string, unknown>) : null;
  const video = vj ? ((vj.video ?? vj) as Record<string, unknown>) : null;
  const orgId = typeof pl.org_id === "string" ? pl.org_id : "";
  return {
    player: {
      player_id: playerId,
      traffic_percentage: 0,
      started_at: null,
      locked: false,
      details: {
        name: typeof pl.name === "string" ? pl.name : "",
        poster: videoId && orgId ? `https://cdn.converteai.net/${orgId}/${videoId}/poster.jpg` : null,
        duration: video && typeof video.duration === "number" ? video.duration : null,
        created_at: typeof pl.created_at === "string" ? pl.created_at : null,
        pitch_time: (pl.pitch_time as number | undefined) ?? (pl.pitch as number | undefined) ?? null,
      },
    },
    node: {
      player_id: `${playerId}_Player`,
      step: 1,
      step_name: "Player",
      variant_name: null,
      element_type: "Player",
      weight: 0,
      children: [{ player_id: playerId, step: 5, step_name: "Final", variant_name: null, element_type: "Player", weight: 0, children: [] }],
    },
  };
}

export class VturbChanged extends Error {}

/**
 * Sets the test's %: `weights` has every video of the test (integers adding
 * up to 100; a video that isn't in the group yet joins it, if above 0). When
 * `expected` is given and VTurb's current % differ from it (someone changed
 * the test elsewhere since it was loaded), nothing is written: VturbChanged.
 * Returns the test as saved.
 */
export async function writeTest(groupId: string, weights: Record<string, number>, expected?: Record<string, number>): Promise<VslReplica> {
  const group = await getGroup(groupId);
  group.players = group.players ?? [];
  group.tree = group.tree ?? {};
  group.tree.children = group.tree.children ?? [];

  if (expected) {
    const now = replicaOf(group);
    const ids = new Set([...Object.keys(now), ...Object.keys(expected)]);
    for (const id of ids) {
      if (Math.abs((now[id]?.weight ?? 0) - (expected[id] ?? 0)) > 0.001) throw new VturbChanged("The test changed in VTurb since this screen loaded.");
    }
  }

  for (const [id, w] of Object.entries(weights)) {
    if (w > 0 && !group.players.some((p) => p.player_id === id)) {
      const arm = await newArm(id);
      group.players.push(arm.player);
      group.tree.children.push(arm.node);
    }
  }
  for (const p of group.players) p.traffic_percentage = weights[p.player_id] ?? 0;
  for (const node of group.tree.children) {
    const final = node.children?.[0];
    const id = final?.player_id ?? String(node.player_id).replace(/_Player$/, "");
    node.weight = weights[id] ?? 0;
    if (final) final.weight = node.weight;
  }

  await call("PUT", `/v2/comparisons_groups/${groupId}`, { comparison_group: group });
  return replicaOf(group);
}
