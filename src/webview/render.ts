import { Graph, GraphNode } from "../graph/types";
import { edgeInLabel, edgeOutLabel, typeColor } from "../graph/labels";
import type { ExploreSpec, ExploreTotals } from "../graph/rollup";

const CORE_KEYS = new Set(["id", "type", "label", "external", "childCount"]);

export interface DetailCtx {
  /** Are we in the container view (where revealing makes sense)? */
  containerMode: boolean;
  /** What's available to reveal around this node and how much is revealed now (from
   *  the host). Absent until the host answers the `describe` request. */
  explore?: { totals: ExploreTotals; spec: ExploreSpec };
}

/** Build the detail-panel HTML for one node: header, attributes, relationships. */
export function renderDetail(graph: Graph, byId: Map<string, GraphNode>, id: string, ctx?: DetailCtx): string {
  const node = byId.get(id);
  if (!node) {
    return `<div class="placeholder">Node not found.</div>`;
  }

  const parts: string[] = [];
  parts.push(
    `<div class="d-head"><span class="dot" style="background:${typeColor(node.type)}"></span><h2>${esc(node.label)}</h2></div>`,
  );
  const sub = [`<span class="d-type">${esc(node.type)}</span>`];
  if (node.external) {
    sub.push(`<span class="badge">external · referenced, not retrieved</span>`);
  }
  parts.push(`<div class="d-sub">${sub.join(" ")}</div>`);
  parts.push(`<div class="d-id" title="node id">${esc(node.id)}</div>`);

  // Explore: reveal more around this node — its members (children), its most-connected
  // neighbours, and the nodes that point into it (sources). Additive: reveals layer
  // onto the current map. Only in the container view, and only once the host has
  // reported what's available (ctx.explore).
  parts.push(renderExplore(ctx));

  // Attributes — everything beyond the core fields, generically rendered.
  const attrs: string[] = [];
  for (const key of Object.keys(node).sort()) {
    if (CORE_KEYS.has(key)) continue;
    const html = renderAttr(key, (node as Record<string, unknown>)[key]);
    if (html) attrs.push(html);
  }
  if (attrs.length) {
    parts.push(`<section class="d-section"><h3>Attributes</h3>${attrs.join("")}</section>`);
  }

  // Relationships — outgoing then incoming, grouped by edge type.
  const outgoing = new Map<string, GraphNode[]>();
  const incoming = new Map<string, GraphNode[]>();
  for (const e of graph.edges) {
    if (e.src === id) {
      const target = byId.get(e.dst);
      if (target) addTo(outgoing, e.type, target);
    }
    if (e.dst === id) {
      const target = byId.get(e.src);
      if (target) addTo(incoming, e.type, target);
    }
  }
  parts.push(renderGroups(outgoing, edgeOutLabel));
  parts.push(renderGroups(incoming, edgeInLabel));

  if (outgoing.size === 0 && incoming.size === 0) {
    parts.push(`<section class="d-section"><p class="muted">No relationships.</p></section>`);
  }

  return parts.join("");
}

// The "Explore" block: members toggle + neighbour/source steppers, each with a
// revealed/total count. Buttons carry data-* the webview reads to post exploreStep.
function renderExplore(ctx?: DetailCtx): string {
  if (!ctx?.containerMode || !ctx.explore) return "";
  const { totals, spec } = ctx.explore;
  if (totals.members === 0 && totals.neighbors === 0 && totals.sources === 0) return "";
  const rows: string[] = [];
  if (totals.members > 0) {
    const word = totals.members === 1 ? "member" : "members";
    rows.push(
      spec.members
        ? `<div class="x-row"><span class="x-label">Members</span><button class="x-toggle on" data-kind="members" data-val="0" title="Roll these members back in">⊖ ${totals.members} ${word}</button></div>`
        : `<div class="x-row"><span class="x-label">Members</span><button class="x-toggle" data-kind="members" data-val="1" title="Reveal this node's ${totals.members} ${word}">⊕ ${totals.members} ${word}</button></div>`,
    );
  }
  if (totals.neighbors > 0) {
    rows.push(stepper("Neighbors", "neighbors", Math.min(spec.neighbors, totals.neighbors), totals.neighbors));
  }
  if (totals.sources > 0) {
    rows.push(stepper("Sources", "sources", Math.min(spec.sources, totals.sources), totals.sources));
  }
  return `<section class="d-section x-explore"><h3>Explore</h3>${rows.join("")}</section>`;
}

function stepper(label: string, kind: string, shown: number, total: number): string {
  const minus = `<button class="x-step" data-kind="${kind}" data-dir="-1"${shown <= 0 ? " disabled" : ""} title="Show fewer">−</button>`;
  const plus = `<button class="x-step" data-kind="${kind}" data-dir="1"${shown >= total ? " disabled" : ""} title="Show more">＋</button>`;
  return `<div class="x-row"><span class="x-label">${esc(label)}</span><span class="x-stepper">${minus}<span class="x-count">${shown}/${total}</span>${plus}</span></div>`;
}

function addTo(map: Map<string, GraphNode[]>, type: string, node: GraphNode): void {
  const list = map.get(type) ?? [];
  list.push(node);
  map.set(type, list);
}

function renderGroups(map: Map<string, GraphNode[]>, label: (t: string) => string): string {
  if (map.size === 0) return "";
  const sections: string[] = [];
  for (const type of [...map.keys()].sort((a, b) => label(a).localeCompare(label(b)))) {
    const nodes = map.get(type)!.slice().sort((a, b) => a.label.localeCompare(b.label));
    const links = nodes.map((n) => nodeLink(n)).join("");
    sections.push(
      `<section class="d-section"><h3>${esc(label(type))} <span class="count">${nodes.length}</span></h3><div class="links">${links}</div></section>`,
    );
  }
  return sections.join("");
}

function nodeLink(n: GraphNode): string {
  return `<a class="node-link" data-id="${esc(n.id)}" title="${esc(n.id)}"><span class="dot sm" style="background:${typeColor(n.type)}"></span>${esc(n.label)}</a>`;
}

function renderAttr(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    if (value.every((v) => typeof v !== "object")) {
      return row(key, esc(value.join(", ")));
    }
    return details(key, value);
  }
  if (typeof value === "object") {
    if (Object.keys(value as object).length === 0) return "";
    return details(key, value);
  }
  return row(key, esc(String(value)));
}

function row(key: string, valueHtml: string): string {
  return `<div class="attr"><span class="k">${esc(key)}</span><span class="v">${valueHtml}</span></div>`;
}

function details(key: string, value: unknown): string {
  return `<details class="attr-details"><summary>${esc(key)}</summary><pre>${esc(JSON.stringify(value, null, 2))}</pre></details>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
