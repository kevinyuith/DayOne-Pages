"use client";

import { useState } from "react";
import { ChevronRightIcon, EyeOffIcon, LinkIcon } from "@/components/icons";
import type { LayerNode } from "@/lib/pages/html-editing";

/**
 * "Layers" panel: the body's element tree. Clicking selects on the canvas;
 * the selected one is highlighted. The first two levels start expanded.
 */
export function LayersPanel({ layers, selectedUid, onSelect }: { layers: LayerNode[]; selectedUid: string | null; onSelect: (uid: string) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Layers</div>
        <p className="mt-0.5 text-[11px] text-muted">Page structure. Click to select on the canvas.</p>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto p-1 font-mono text-[11px]">
        {layers.length === 0 ? <li className="px-2 py-4 text-center font-sans text-xs text-muted">No elements in the body.</li> : null}
        {layers.map((n) => (
          <LayerRow key={n.uid} node={n} depth={0} selectedUid={selectedUid} onSelect={onSelect} />
        ))}
      </ul>
    </div>
  );
}

function LayerRow({ node, depth, selectedUid, onSelect }: { node: LayerNode; depth: number; selectedUid: string | null; onSelect: (uid: string) => void }) {
  const [open, setOpen] = useState(depth < 2);
  const has = node.children.length > 0;
  const selected = node.uid === selectedUid;
  return (
    <li>
      <div
        className={`flex items-center gap-1 rounded-md pr-1 ${selected ? "bg-accent/10 text-accent" : "text-foreground hover:bg-foreground/5"} ${
          node.hidden ? "opacity-50" : ""
        }`}
        style={{ paddingLeft: depth * 12 + 2 }}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={`shrink-0 text-muted hover:text-foreground ${has ? "" : "invisible"}`}
          title={open ? "Collapse" : "Expand"}
          tabIndex={has ? 0 : -1}
        >
          <ChevronRightIcon className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        <button type="button" onClick={() => onSelect(node.uid)} className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left" title={`<${node.tag}> ${node.label}`}>
          <span className={selected ? "text-accent" : "text-muted"}>{node.tag}</span>
          {node.label ? <span className="truncate font-sans text-foreground/80">{node.label}</span> : null}
          {node.isLink ? <LinkIcon className="ml-auto size-3 shrink-0 text-muted" /> : null}
          {node.hidden ? <EyeOffIcon className={`size-3 shrink-0 text-muted ${node.isLink ? "" : "ml-auto"}`} /> : null}
        </button>
      </div>
      {has && open ? (
        <ul>
          {node.children.map((c) => (
            <LayerRow key={c.uid} node={c} depth={depth + 1} selectedUid={selectedUid} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
