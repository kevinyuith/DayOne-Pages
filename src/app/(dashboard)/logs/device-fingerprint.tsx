"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

/** The five blocks of pages.hits.device_fingerprint (eval_device_fingerprint). */
type Fp = Record<string, unknown>;

const BLOCKS: { key: string; label: string }[] = [
  { key: "ua", label: "User-Agent" },
  { key: "hw", label: "Hardware" },
  { key: "env", label: "Environment" },
  { key: "bot", label: "Bot tells" },
  { key: "consist", label: "Consistency" },
];

/** Human labels for the fingerprint keys (the short "sg"-style names). */
const KEY_LABEL: Record<string, string> = {
  brands: "UA-CH brands",
  mobile: "Mobile (UA-CH)",
  platform: "Platform",
  cores: "CPU cores",
  mem: "Device memory (GB)",
  touch_points: "Touch points",
  touch_capable: "Touch capable",
  pointer: "Pointer",
  mobile_hint: "Mobile hint",
  dpr: "Device pixel ratio",
  screen: "Screen",
  viewport: "Viewport",
  outer: "Window outer",
  color_depth: "Color depth",
  orientation: "Orientation",
  tz: "Timezone",
  tz_off: "TZ offset (min)",
  langs: "Languages",
  lang: "Primary language",
  chrome_rt: "chrome.runtime",
  mime: "MIME types",
  plugins: "Plugins",
  voices: "Speech voices",
  cke: "Cookies enabled",
  storage_ok: "Storage OK",
  net_type: "Network type",
  net_rtt: "Network RTT (Chrome)",
  net_downlink: "Downlink (Mbps)",
  nav_connect_ms: "Nav connect (ms)",
  nav_ttfb_ms: "Nav TTFB (ms)",
  conn_reused: "Connection reused",
  battery: "Battery (%)",
  charging: "Charging",
  wd: "Webdriver",
  wd_getter: "Webdriver getter",
  aut: "Automation",
  headless_ua: "Headless UA",
  chrome_obj: "window.chrome",
  cdp_stack: "CDP in stack",
  iframe: "In iframe",
  proto_poisoned: "Prototype poisoned",
  uact_ok: "userActivation OK",
  no_webrtc: "No WebRTC",
  os_match: "OS match (UA vs platform)",
  chrome_ver: "Chrome version",
  canvas_2x: "Canvas 2× consistent",
  env_ok: "Env consistent",
  media_api: "Media devices API",
  gl: "WebGL renderer",
  gl_sw: "Software WebGL",
  touch_vs_dev: "Touch vs device",
};

/** Bit fields shown as yes/no badges instead of raw 0/1. */
const BIT_KEYS = new Set([
  "mobile", "touch_capable", "mobile_hint", "chrome_rt", "cke", "storage_ok", "conn_reused", "charging", "wd", "headless_ua", "chrome_obj", "cdp_stack",
  "iframe", "proto_poisoned", "uact_ok", "no_webrtc", "os_match", "canvas_2x", "env_ok", "media_api", "gl_sw", "touch_vs_dev",
]);
/** Tells where 1 is the suspicious value (shown in red); the rest are neutral. */
const ALERT_KEYS = new Set(["wd", "headless_ua", "cdp_stack", "iframe", "proto_poisoned", "no_webrtc", "gl_sw"]);

function Row({ k, v }: { k: string; v: unknown }) {
  const label = KEY_LABEL[k] ?? k;
  if (typeof v === "number" && BIT_KEYS.has(k)) {
    const on = v === 1;
    const alert = ALERT_KEYS.has(k);
    const tone = alert ? (on ? "danger" : "success") : "neutral";
    const text = alert ? (on ? "yes" : "no") : on ? "yes" : "no";
    return (
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="text-xs text-muted">{label}</span>
        <Badge tone={tone as "danger" | "success" | "neutral"}>{text}</Badge>
      </div>
    );
  }
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="shrink-0 text-xs text-muted">{label}</span>
      <span className="break-all text-right font-mono text-xs">{typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v)}</span>
    </div>
  );
}

/**
 * The Logs' Device column: a button that opens the hit's device fingerprint
 * (pages.hits.device_fingerprint, the checkpoint's structured signals) in a
 * dialog, grouped in the five blocks. Only a checkpoint POST's hit has one.
 */
export function DeviceFingerprint({ fp }: { fp: Fp | null }) {
  const [open, setOpen] = useState(false);
  if (!fp || typeof fp !== "object") return <span className="text-muted">—</span>;

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        View
      </Button>
      <Dialog open={open} title="Device fingerprint" description="What the checkpoint read from the browser (informational only)." onClose={() => setOpen(false)} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <div className="grid gap-4 sm:grid-cols-2">
          {BLOCKS.map(({ key, label }) => {
            const block = fp[key];
            if (!block || typeof block !== "object" || Array.isArray(block)) return null;
            const entries = Object.entries(block as Record<string, unknown>);
            if (entries.length === 0) return null;
            return (
              <section key={key} className="min-w-0 rounded-lg border border-border p-3">
                <h3 className="px-0 text-xs font-semibold uppercase tracking-wide text-muted">{label}</h3>
                <div className="mt-1 divide-y divide-border/60">
                  {entries.map(([k, v]) => (
                    <Row key={k} k={k} v={v} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-muted">Raw JSON</summary>
          <pre className="mt-2 overflow-auto rounded-lg border border-border bg-foreground/[0.03] p-3 text-[11px] leading-relaxed">{JSON.stringify(fp, null, 2)}</pre>
        </details>
      </Dialog>
    </>
  );
}
