import cytoscape, { Core, ElementDefinition, NodeSingular } from "cytoscape";
import fcose from "cytoscape-fcose";
import { Graph, GraphNode } from "../graph/types";
import { typeColor } from "../graph/labels";
import { renderDetail } from "./render";

cytoscape.use(fcose);

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscodeApi = acquireVsCodeApi();

interface Settings {
  physics: boolean;
  spacing: number;
  animateOnHover: boolean;
  motionMaxNodes: number;
}

const accent =
  getComputedStyle(document.body).getPropertyValue("--vscode-focusBorder").trim() || "#4C8DFF";

// ---- DOM handles ----
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const cyEl = $<HTMLDivElement>("#cy");
const detailEl = $<HTMLElement>("#detail");
const nodeFiltersEl = $<HTMLDivElement>("#node-filters");
const edgeFiltersEl = $<HTMLDivElement>("#edge-filters");
const searchEl = $<HTMLInputElement>("#search");
const statusEl = $<HTMLSpanElement>("#status");

// ---- state ----
let cy: Core | undefined;
let graph: Graph | undefined;
let byId = new Map<string, GraphNode>();
const enabledNodeTypes = new Set<string>();
const enabledEdgeTypes = new Set<string>();
let selectedId: string | undefined;
let settings: Settings = { physics: true, spacing: 150, animateOnHover: true, motionMaxNodes: 800 };

// ---- gentle-drift animation state ----
let driftRAF: number | undefined;
const driftHomes = new Map<string, { x: number; y: number }>();
const driftParams = new Map<string, { ax: number; ay: number; fx: number; fy: number; px: number; py: number }>();
let driftT0 = 0;

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg?.type === "setGraph") {
    if (msg.settings) settings = msg.settings as Settings;
    graph = msg.graph as Graph;
    build(graph);
  } else if (msg?.type === "updateSettings") {
    applySettings(msg.settings as Settings);
  }
});

vscodeApi.postMessage({ type: "ready" });

// ---- build ----
function build(g: Graph): void {
  byId = new Map(g.nodes.map((n) => [n.id, n]));
  selectedId = undefined;
  clearDetail();

  const degree = new Map<string, number>();
  for (const e of g.edges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }
  let maxDeg = 1;
  for (const d of degree.values()) maxDeg = Math.max(maxDeg, d);

  const elements: ElementDefinition[] = [];
  for (const n of g.nodes) {
    elements.push({
      data: {
        id: n.id,
        label: n.label,
        type: n.type,
        color: typeColor(n.type),
        deg: degree.get(n.id) ?? 0,
        external: n.external ? 1 : 0,
      },
    });
  }
  g.edges.forEach((e, i) => {
    elements.push({ data: { id: `e${i}`, source: e.src, target: e.dst, type: e.type } });
  });

  stopDrift();
  cy?.destroy();
  cy = cytoscape({
    container: cyEl,
    elements,
    wheelSensitivity: 0.2,
    textureOnViewport: true, // faster pan/zoom on big graphs
    style: buildStyle(maxDeg),
  });

  cy.on("tap", "node", (evt) => select((evt.target as NodeSingular).id()));
  cy.on("tap", (evt) => {
    if (evt.target === cy) clearSelection();
  });
  cy.on("mouseover", "node", (evt) => onHover(evt.target as NodeSingular));
  cy.on("mouseout", "node", (evt) => offHover(evt.target as NodeSingular));
  // Dragging repositions a node; remember its new resting spot so it drifts there.
  cy.on("dragfree", "node", (evt) => {
    const n = evt.target as NodeSingular;
    const p = n.position();
    driftHomes.set(n.id(), { x: p.x, y: p.y });
  });

  buildFilters(g);
  applyFilters();
  runLayout();
  updateStatus();
}

// ---- layout & motion ----
function runLayout(): void {
  if (!cy) return;
  stopDrift();
  const count = cy.nodes().length;
  const layout = cy.layout(fcoseOptions(settings.spacing, count));
  layout.one("layoutstop", () => {
    // Defer one frame so the container has its real size, then land zoomed-in
    // centered on the most-connected node (the natural focal point, and the
    // biggest one since nodes are sized by degree). Absolute zoom — no reliance
    // on reading container pixels (that was the bug).
    requestAnimationFrame(() => {
      if (!cy) return;
      cy.resize();
      cy.zoom(1.5);
      if (cy.nodes().length > 0) {
        cy.center(cy.nodes().max((n) => Number(n.data("deg")) || 0).ele);
      }
      if (driftEligible()) startDrift();
    });
  });
  layout.run();
}

// Gentle continuous drift: each node bobs a few px on its own slow sine wave
// around its resting spot (stable — always returns home; cheap math). The hovered
// node + neighbors bob bigger. Auto-disabled above `motionMaxNodes`.
function driftEligible(): boolean {
  return !!cy && settings.physics && !document.hidden && cy.nodes().length <= settings.motionMaxNodes;
}

function startDrift(): void {
  if (!cy || !driftEligible()) return;
  stopDrift();
  driftHomes.clear();
  driftParams.clear();
  cy.nodes().forEach((n) => {
    const p = n.position();
    driftHomes.set(n.id(), { x: p.x, y: p.y });
    driftParams.set(n.id(), {
      ax: 2.5 + Math.random() * 3,
      ay: 2.5 + Math.random() * 3,
      fx: 0.3 + Math.random() * 0.5,
      fy: 0.3 + Math.random() * 0.5,
      px: Math.random() * Math.PI * 2,
      py: Math.random() * Math.PI * 2,
    });
  });
  driftT0 = performance.now();
  const tick = () => {
    if (!cy || driftRAF === undefined) return;
    const t = (performance.now() - driftT0) / 1000;
    cy.batch(() => {
      cy!.nodes().forEach((n) => {
        if (n.grabbed()) return; // don't fight an active drag
        const home = driftHomes.get(n.id());
        const pr = driftParams.get(n.id());
        if (!home || !pr) return;
        n.position({
          x: home.x + pr.ax * Math.sin(t * pr.fx + pr.px),
          y: home.y + pr.ay * Math.sin(t * pr.fy + pr.py),
        });
      });
    });
    driftRAF = requestAnimationFrame(tick);
  };
  driftRAF = requestAnimationFrame(tick);
}

function stopDrift(): void {
  if (driftRAF !== undefined) cancelAnimationFrame(driftRAF);
  driftRAF = undefined;
}

function fcoseOptions(spacing: number, count: number): cytoscape.LayoutOptions {
  return {
    name: "fcose",
    quality: "default",
    animate: count <= 200,
    randomize: true,
    fit: true,
    padding: 40,
    nodeRepulsion: 4500 + spacing * 30,
    idealEdgeLength: spacing,
    nodeSeparation: Math.max(20, spacing * 0.85),
    packComponents: true,
  } as unknown as cytoscape.LayoutOptions;
}

function buildStyle(maxDeg: number): cytoscape.StylesheetStyle[] {
  return [
    {
      selector: "node",
      style: {
        "background-color": "data(color)",
        label: "data(label)",
        width: `mapData(deg, 0, ${maxDeg}, 14, 52)`,
        height: `mapData(deg, 0, ${maxDeg}, 14, 52)`,
        "font-size": 7,
        color: "#c8c8c8",
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": 2,
        "min-zoomed-font-size": 8,
        "border-width": 0,
        "transition-property": "width height border-width border-color background-blacken opacity",
        "transition-duration": 130,
      } as cytoscape.Css.Node,
    },
    {
      selector: "node[external = 1]",
      style: { "background-opacity": 0.5, "border-width": 1, "border-style": "dashed", "border-color": "#888" },
    },
    {
      selector: "edge",
      style: {
        width: 1,
        "line-color": "#5a5a5a",
        "line-opacity": 0.5,
        "curve-style": "straight",
        "target-arrow-shape": "triangle",
        "target-arrow-color": "#5a5a5a",
        "arrow-scale": 0.6,
      },
    },
    {
      selector: "node.hover",
      style: {
        width: `mapData(deg, 0, ${maxDeg}, 24, 76)`,
        height: `mapData(deg, 0, ${maxDeg}, 24, 76)`,
        "border-width": 3,
        "border-color": accent,
        "border-opacity": 1,
        "background-blacken": -0.2,
        "z-index": 20,
      },
    },
    { selector: "node.sel", style: { "border-width": 3, "border-color": accent, "border-style": "solid", "border-opacity": 1 } },
    { selector: "node.hl", style: { "border-width": 2, "border-color": accent, "border-style": "solid", "border-opacity": 1 } },
    { selector: "edge.hl", style: { "line-color": accent, "target-arrow-color": accent, "line-opacity": 1, width: 2, "z-index": 9 } },
    { selector: ".dim", style: { opacity: 0.12 } },
    { selector: ".unfocused", style: { opacity: 0.12 } },
  ];
}

// ---- hover ----
// Hover dims everything else and enlarges + highlights the hovered node and its
// neighbors. It never moves anything (the gentle drift keeps running underneath).
function onHover(node: NodeSingular): void {
  if (!settings.animateOnHover || !cy) return;
  const focus = node.closedNeighborhood(); // the node + neighbor nodes + connecting edges
  cy.elements().addClass("unfocused");
  focus.removeClass("unfocused");
  node.addClass("hover");
  node.neighborhood("node").addClass("hover");
}

function offHover(_node: NodeSingular): void {
  cy?.elements().removeClass("unfocused hover");
}

// ---- selection ----
function select(id: string): void {
  if (!cy) return;
  selectedId = id;
  cy.batch(() => {
    cy!.elements().removeClass("sel hl");
    const node = cy!.getElementById(id);
    if (node.empty()) return;
    node.addClass("sel");
    const incident = node.connectedEdges();
    incident.addClass("hl");
    incident.connectedNodes().not(node).addClass("hl");
  });
  if (graph) detailEl.innerHTML = renderDetail(graph, byId, id);
}

function focusNode(id: string): void {
  if (!cy) return;
  const node = cy.getElementById(id);
  if (node.empty()) return;
  cy.animate({ center: { eles: node }, duration: 200 });
  select(id);
}

function clearSelection(): void {
  selectedId = undefined;
  cy?.elements().removeClass("sel hl");
  clearDetail();
}

function clearDetail(): void {
  detailEl.innerHTML = `<div class="placeholder">Select a node to see its details.</div>`;
}

// Detail-panel link navigation (event delegation).
detailEl.addEventListener("click", (e) => {
  const link = (e.target as HTMLElement).closest(".node-link") as HTMLElement | null;
  if (link?.dataset.id) {
    e.preventDefault();
    focusNode(link.dataset.id);
  }
});

// ---- settings ----
function applySettings(next: Settings): void {
  const prev = settings;
  settings = next;
  if (!cy) return;
  if (prev.spacing !== next.spacing) {
    runLayout(); // re-space everything, then resume drift
  } else if (prev.physics !== next.physics || prev.motionMaxNodes !== next.motionMaxNodes) {
    if (driftEligible()) startDrift();
    else stopDrift();
  }
}

// Pause the drift while the tab is hidden so it doesn't burn CPU in the
// background; resume when shown again.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopDrift();
  else if (driftEligible()) startDrift();
});

// ---- filters ----
function buildFilters(g: Graph): void {
  const nodeCounts = countBy(g.nodes.map((n) => n.type));
  const edgeCounts = countBy(g.edges.map((e) => e.type));

  enabledNodeTypes.clear();
  enabledEdgeTypes.clear();
  for (const t of nodeCounts.keys()) enabledNodeTypes.add(t);
  for (const t of edgeCounts.keys()) enabledEdgeTypes.add(t);

  nodeFiltersEl.innerHTML = "";
  for (const [type, count] of sortedEntries(nodeCounts)) {
    nodeFiltersEl.appendChild(filterRow(type, count, typeColor(type), enabledNodeTypes, type, applyFilters));
  }
  edgeFiltersEl.innerHTML = "";
  for (const [type, count] of sortedEntries(edgeCounts)) {
    edgeFiltersEl.appendChild(filterRow(type, count, undefined, enabledEdgeTypes, type, applyFilters));
  }
}

function filterRow(
  label: string,
  count: number,
  color: string | undefined,
  set: Set<string>,
  key: string,
  onChange: () => void,
): HTMLElement {
  const row = document.createElement("label");
  row.className = "filter-row";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = set.has(key);
  cb.addEventListener("change", () => {
    if (cb.checked) set.add(key);
    else set.delete(key);
    onChange();
  });
  row.appendChild(cb);
  if (color) {
    const dot = document.createElement("span");
    dot.className = "dot sm";
    dot.style.background = color;
    row.appendChild(dot);
  }
  const name = document.createElement("span");
  name.className = "filter-name";
  name.textContent = label;
  row.appendChild(name);
  const cnt = document.createElement("span");
  cnt.className = "count";
  cnt.textContent = String(count);
  row.appendChild(cnt);
  return row;
}

function applyFilters(): void {
  if (!cy) return;
  cy.batch(() => {
    cy!.nodes().forEach((n) => {
      n.style("display", enabledNodeTypes.has(n.data("type")) ? "element" : "none");
    });
    cy!.edges().forEach((e) => {
      const ok =
        enabledEdgeTypes.has(e.data("type")) &&
        enabledNodeTypes.has(e.source().data("type")) &&
        enabledNodeTypes.has(e.target().data("type"));
      e.style("display", ok ? "element" : "none");
    });
  });
  applySearch();
  updateStatus();
}

// "all / none" quick toggles.
document.querySelectorAll<HTMLElement>("[data-all]").forEach((el) => {
  el.addEventListener("click", () => {
    const action = el.dataset.all;
    const nodeOn = action === "node-on";
    const nodeOff = action === "node-off";
    const edgeOn = action === "edge-on";
    if (nodeOn || nodeOff) {
      enabledNodeTypes.clear();
      if (nodeOn && graph) graph.nodes.forEach((n) => enabledNodeTypes.add(n.type));
      syncChecks(nodeFiltersEl, nodeOn);
    } else if (graph) {
      enabledEdgeTypes.clear();
      if (edgeOn) graph.edges.forEach((e) => enabledEdgeTypes.add(e.type));
      syncChecks(edgeFiltersEl, edgeOn);
    }
    applyFilters();
  });
});

function syncChecks(container: HTMLElement, checked: boolean): void {
  container.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => {
    cb.checked = checked;
  });
}

// ---- search ----
searchEl.addEventListener("input", () => applySearch());

function applySearch(): void {
  if (!cy) return;
  const term = searchEl.value.trim().toLowerCase();
  cy.batch(() => {
    if (!term) {
      cy!.nodes().removeClass("dim");
      return;
    }
    cy!.nodes().forEach((n) => {
      const hit = String(n.data("label")).toLowerCase().includes(term);
      if (hit) n.removeClass("dim");
      else n.addClass("dim");
    });
  });
  updateStatus();
}

// ---- toolbar ----
$<HTMLButtonElement>("#relayout").addEventListener("click", () => runLayout());
$<HTMLButtonElement>("#fit").addEventListener("click", () => cy?.fit(undefined, 30));
$<HTMLButtonElement>("#toggle-filters").addEventListener("click", () => {
  document.getElementById("app")?.classList.toggle("filters-hidden");
  setTimeout(() => cy?.resize(), 0);
});

// ---- helpers ----
function updateStatus(): void {
  if (!cy || !graph) return;
  const visibleNodes = cy.nodes().filter((n) => n.style("display") !== "none").length;
  const total = graph.nodes.length;
  const shown = visibleNodes === total ? `${total} nodes` : `${visibleNodes}/${total} nodes`;
  statusEl.textContent = `${shown} · ${graph.edges.length} edges`;
}

function countBy(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return m;
}

function sortedEntries(m: Map<string, number>): [string, number][] {
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
