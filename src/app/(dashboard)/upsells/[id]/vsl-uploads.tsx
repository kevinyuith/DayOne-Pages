"use client";

import { useRef } from "react";
import type { UpsellVideo } from "@/lib/pages/upsell";
import type { UploadProgress } from "./use-upsell-videos";

const STATE_LABELS: Record<UpsellVideo["state"], string> = {
  pending: "Waiting for VTurb",
  uploading: "Sending to VTurb",
  transcoding: "Processing at VTurb",
  done: "In VTurb",
  failed: "Failed",
};

const pct = (loaded: number, total: number) => (total > 0 ? `${Math.min(100, Math.round((loaded / total) * 100))}%` : "");
const size = (bytes: number | null) => (bytes === null ? "" : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

/**
 * The VSL stage's uploads for one group: "Upload video" sends the file to VTurb
 * (Storage → dayone-main's worker → the folder Vendor) and each file shows where
 * it is; a finished one is already in the list above (its player id).
 */
export function VslUploads({
  uploads,
  videos,
  onUpload,
  onRetry,
  onDismiss,
}: {
  uploads: UploadProgress[];
  videos: UpsellVideo[];
  onUpload: (file: File) => void;
  onRetry: (id: number) => void;
  onDismiss: (key: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  // Finished ones are VSL rows already; the list shows the ones still on their way or failed.
  const open = videos.filter((v) => v.state !== "done");

  return (
    <div className="flex flex-col gap-1 px-4 py-2">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => input.current?.click()} className="min-h-10 px-1 text-sm font-semibold text-accent">
          ↑ Upload video
        </button>
        <input
          ref={input}
          type="file"
          accept="video/mp4,video/quicktime,video/webm"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) onUpload(file);
          }}
        />
      </div>
      {uploads.map((u) => (
        <div key={u.key} className="flex items-center gap-3 text-sm">
          <span className="min-w-0 truncate font-medium">{u.name}</span>
          {u.error ? (
            <>
              <span className="text-red-600 dark:text-red-400">{u.error}</span>
              <button type="button" onClick={() => onDismiss(u.key)} className="text-xs font-semibold text-muted hover:text-foreground">
                Dismiss
              </button>
            </>
          ) : (
            <>
              <span className="h-1.5 w-40 overflow-hidden rounded-full bg-foreground/10" aria-hidden="true">
                <span className="block h-full bg-accent" style={{ width: pct(u.loaded, u.total) || "0%" }} />
              </span>
              <span className="text-xs text-muted tabular-nums">
                Uploading {pct(u.loaded, u.total)} of {size(u.total)}
              </span>
            </>
          )}
        </div>
      ))}
      {open.map((v) => (
        <div key={v.id} className="flex items-center gap-3 text-sm">
          <span className="min-w-0 truncate font-medium">{v.name}</span>
          <span className={`text-xs ${v.state === "failed" ? "text-red-600 dark:text-red-400" : "text-muted"}`}>
            {STATE_LABELS[v.state]}
            {v.state === "failed" && v.error_message ? `: ${v.error_message}` : ""}
          </span>
          {v.state === "failed" ? (
            <button type="button" onClick={() => onRetry(v.id)} className="text-xs font-semibold text-accent">
              Retry
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
