"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UpsellVideo } from "@/lib/pages/upsell";
import type { UpsellConfig } from "@/lib/pages/upsell-types";
import { MAX_VERSIONS } from "@/lib/pages/upsell-types";
import { markUpsellVideoAdded, queueUpsellVideo, refreshUpsellVideos, retryUpsellVideo, startUpsellVideoUpload } from "../actions";

/** A file on its way from the browser to Storage (before the VTurb queue takes it). */
export type UploadProgress = { key: string; step: string; group: string; name: string; loaded: number; total: number; error: string | null };

const POLL_MS = 10_000;

/** The file into its signed upload URL, as supabase-js does it (FormData), with progress. */
function putFile(url: string, file: File, onProgress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`The upload failed (HTTP ${xhr.status}).`)));
    xhr.onerror = () => reject(new Error("The upload failed (network)."));
    const body = new FormData();
    body.append("cacheControl", "3600");
    body.append("", file);
    xhr.send(body);
  });
}

/**
 * The VSL stage's uploads: the file goes to Storage, then to dayone-main's VTurb
 * worker (pages.upsell_videos), which creates the default player in the VTurb
 * folder Vendor. While one is on its way the list is polled; a finished one goes
 * into its group's VSLs once (100% when it is the group's first, else 0%).
 */
export function useUpsellVideos(funnelId: string, initial: UpsellVideo[], update: (fn: (c: UpsellConfig) => void) => void) {
  const [videos, setVideos] = useState(initial);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const adding = useRef(new Set<number>());

  // A finished video's player into its group's VSLs (once: added_at; a removed one isn't put back).
  const absorb = useCallback(
    (list: UpsellVideo[]) => {
      const ready = list.filter((v) => v.state === "done" && v.player_id && !v.added_at && !adding.current.has(v.id));
      if (ready.length === 0) return list;
      update((c) => {
        for (const v of ready) {
          const g = c.steps.find((s) => s.id === v.step)?.groups?.find((x) => x.id === v.group_id);
          const vsls = g?.vsls ?? [];
          if (!g || !v.player_id || vsls.some((x) => x.id === v.player_id) || vsls.length >= MAX_VERSIONS) continue;
          g.vsls = [...vsls, { id: v.player_id, weight: vsls.length === 0 ? 100 : 0 }];
        }
      });
      for (const v of ready) {
        adding.current.add(v.id);
        void markUpsellVideoAdded(v.id);
      }
      const now = new Date().toISOString();
      return list.map((v) => (ready.some((r) => r.id === v.id) ? { ...v, added_at: now } : v));
    },
    [update],
  );

  const refresh = useCallback(async () => {
    const r = await refreshUpsellVideos(funnelId);
    if (r.ok) setVideos(absorb(r.videos));
  }, [funnelId, absorb]);

  // While one is on its way (or finished while the editor was closed and isn't in its group yet):
  // a look right away, then every 10 s.
  const open = videos.some((v) => v.state === "pending" || v.state === "uploading" || v.state === "transcoding" || (v.state === "done" && v.player_id && !v.added_at));
  useEffect(() => {
    if (!open) return;
    const first = setTimeout(() => void refresh(), 0);
    const every = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [open, refresh]);

  // Leaving the page mid-upload loses the file: the browser asks first.
  const sending = uploads.some((u) => u.error === null);
  useEffect(() => {
    if (!sending) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [sending]);

  const upload = useCallback(
    async (step: string, group: string, file: File) => {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const name = file.name.replace(/\.[^.]+$/, "").trim().slice(0, 200) || "Upsell video";
      const patch = (p: Partial<UploadProgress>) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...p } : u)));
      setUploads((list) => [...list, { key, step, group, name, loaded: 0, total: file.size, error: null }]);
      const start = await startUpsellVideoUpload(funnelId, file.size, file.type);
      if (!start.ok) return patch({ error: start.reason });
      try {
        await putFile(start.url, file, (loaded) => patch({ loaded }));
      } catch (e) {
        return patch({ error: e instanceof Error ? e.message : "The upload failed." });
      }
      const queued = await queueUpsellVideo(funnelId, { step, group, name, path: start.path, size: file.size, type: file.type });
      if (!queued.ok) return patch({ error: queued.reason });
      setUploads((list) => list.filter((u) => u.key !== key));
      await refresh();
    },
    [funnelId, refresh],
  );

  const retry = useCallback(
    async (id: number) => {
      const r = await retryUpsellVideo(id);
      if (r.ok) await refresh();
    },
    [refresh],
  );

  const dismiss = useCallback((key: string) => setUploads((list) => list.filter((u) => u.key !== key)), []);

  return { videos, uploads, upload, retry, dismiss };
}
