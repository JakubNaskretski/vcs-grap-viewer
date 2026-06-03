import { Graph, GraphNode } from "../graph/types";
import { edgeInLabel, edgeOutLabel, typeColor } from "../graph/labels";

const CORE_KEYS = new Set(["id", "type", "label", "external", "childCount"]);

export interface DetailCtx {
  /** Are we in the container view (where expanding a node makes sense)? */
  containerMode: boolean;
  /** Containers currently drilled into. */
  expanded: Set<string>;
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

  // Actions. In the container view a node with rolled-up members can be expanded
  // in place (revealing its members + related nodes) or collapsed back; "Focus"
  // narrows the map to the node and what it connects to.
  const childCount = typeof node.childCount === "number" ? node.childCount : 0;
  const canExpand = !!ctx?.containerMode && childCount > 0;
  const actions: string[] = [];
  if (canExpand) {
    const word = childCount === 1 ? "member" : "members";
    if (ctx!.expanded.has(node.id)) {
      actions.push(
        `<button class="d-expand" data-id="${esc(node.id)}" data-action="collapse" title="Roll this node's members back into it">⊖ Collapse members</button>`,
      );
    } else {
      actions.push(
        `<button class="d-expand" data-id="${esc(node.id)}" data-action="expand" title="Reveal this node's ${childCount} ${word} and the nodes they connect to">⊕ Expand ${childCount} ${word}</button>`,
      );
    }
  }
  actions.push(
    `<button class="d-focus" data-id="${esc(node.id)}" title="Show only this node and its connections">◎ Focus on this node</button>`,
  );
  parts.push(`<div class="d-actions">${actions.join(" ")}</div>`);

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
