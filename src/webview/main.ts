import cytoscape, { Core, ElementDefinition, NodeSingular } from "cytoscape";
import fcose from "cytoscape-fcose";
import { Graph, GraphNode } from "../graph/types";
import { typeColor } from "../graph/labels";
import { renderDetail } from "./render";

interface SetGraphMsg {
  type: "setGraph";
  graph: Graph;
  settings?: Settings;
  meta?: Meta;
  expandRoot?: string;
}

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

// Sent by the host alongside each graph: which view we're in (container-level vs
// full) and the counts behind the "Show all / Collapse" toggle.
interface Meta {
  mode: "containers" | "all";
  totalNodes: number;
  totalEdges: number;
  shownNodes: number;
  shownEdges: number;
  hasNested: boolean;
  // Drill-in state: which containers are expanded, and (for the one just
  // expanded) how many related mains were dropped past the maxRelatedNodes cap.
  exploring: boolean;
  expanded: string[];
  expandedCount: number;
  truncatedRoot: number;
  // How many nodes the maxRenderNodes cap dropped from this view (0 = uncapped).
  capDropped: number;
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
const modeEl = $<HTMLButtonElement>("#mode");
const focusBarEl = $<HTMLSpanElement>("#focus-bar");
const focusLabelEl = $<HTMLSpanElement>("#focus-label");
const focusDepthEl = $<HTMLSelectElement>("#focus-depth");
const focusClearEl = $<HTMLButtonElement>("#focus-clear");
const exploreBarEl = $<HTMLSpanElement>("#explore-bar");
const exploreCountEl = $<HTMLSpanElement>("#explore-count");
const exploreResetEl = $<HTMLButtonElement>("#explore-reset");

// ---- state ----
let cy: Core | undefined;
let graph: Graph | undefined;
let byId = new Map<string, GraphNode>();
const enabledNodeTypes = new Set<string>(); // node types currently shown
const enabledEdgeTypes = new Set<string>();
const hiddenNodeIds = new Set<string>(); // individually unticked nodes (within shown types)
let nodesByType = new Map<string, GraphNode[]>(); // type -> its nodes, for the expandable filter tree
let selectedId: string | undefined;
let settings: Settings = { physics: true, spacing: 150, animateOnHover: true, motionMaxNodes: 800 };
let currentMeta: Meta | undefined;
let expandedIds = new Set<string>(); // containers drilled into (mirrors host state)
// Focus: when set, the map is narrowed to this node and its k-hop neighborhood.
let focusId: string | undefined;
let focusDepth = 1;

// ---- gentle-drift animation state ----
let driftRAF: number | undefined;
const driftHomes = new Map<string, { x: number; y: number }>();
const driftParams = new Map<string, { ax: number; ay: number; fx: number; fy: number; px: number; py: number }>();
let driftT0 = 0;

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg?.type === "setGraph") {
    const m = msg as SetGraphMsg;
    if (m.settings) settings = m.settings;
    currentMeta = m.meta;
    expandedIds = new Set(m.meta?.expanded ?? []);
    graph = m.graph;
    build(graph);
    updateModeUI();
    updateExploreUI();
    // Keep the just-expanded node selected so its detail panel stays open (and its
    // button flips to "Collapse"); flag any related nodes dropped past the cap.
    if (m.expandRoot && byId.has(m.expandRoot)) {
      select(m.expandRoot);
      if (m.meta && m.meta.truncatedRoot > 0) {
        detailEl.insertAdjacentHTML(
          "beforeend",
          `<p class="muted" style="margin-top:10px">+${m.meta.truncatedRoot} more related node${
            m.meta.truncatedRoot === 1 ? "" : "s"
          } hidden — raise “Max Related Nodes” in settings to widen each step.</p>`,
        );
      }
    }
  } else if (msg?.type === "updateSettings") {
    applySettings(msg.settings as Settings);
  } else if (msg?.type === "findResult" && msg.found === false) {
    statusEl.textContent = `no match for “${String(msg.query ?? "")}” in the full graph`;
  }
});

vscodeApi.postMessage({ type: "ready" });

// "Show all" / "Collapse to containers" toggle. The host owns the data and the
// (modal) confirmation for showing a huge graph; we just request the switch.
modeEl.addEventListener("click", () => {
  const target = modeEl.dataset.target;
  if (target) vscodeApi.postMessage({ type: "setViewMode", mode: target });
});

function updateModeUI(): void {
  // While drilling in, the container/full toggle doesn't apply — the explore
  // pill (with its reset) is the way out.
  if (!currentMeta || !currentMeta.hasNested || currentMeta.exploring) {
    modeEl.hidden = true;
    return;
  }
  modeEl.hidden = false;
  if (currentMeta.mode === "containers") {
    modeEl.textContent = `Show all (${currentMeta.totalNodes.toLocaleString()})`;
    modeEl.title = "Show every node, including fields/methods/elements (may be slow on large graphs)";
    modeEl.dataset.target = "all";
  } else {
    modeEl.textContent = "Collapse to containers";
    modeEl.title = "Roll fields/methods/elements up into their parent objects/classes/flows";
    modeEl.dataset.target = "containers";
  }
}

// ---- build ----
function build(g: Graph): void {
  byId = new Map(g.nodes.map((n) => [n.id, n]));
  selectedId = undefined;
  focusId = undefined;
  updateFocusUI();
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

  const bigRender = g.nodes.length > 1500;
  stopDrift();
  cy?.destroy();
  cy = cytoscape({
    container: cyEl,
    elements,
    wheelSensitivity: 0.2,
    textureOnViewport: true, // faster pan/zoom on big graphs
    hideEdgesOnViewport: bigRender, // don't redraw every edge mid pan/zoom
    style: buildStyle(maxDeg, bigRender),
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
      // Land zoomed-in, centered on the selected node (e.g. a search hit the host
      // just drilled in to) or else the most-connected (and largest) node — at
      // every size. The host caps how much is rendered, so fitting "everything"
      // (the old big-map behavior) is never the right landing: it draws the whole
      // sea of nodes at once. The Fit button still does a full fit on demand.
      cy.zoom(1.5);
      const sel = selectedId ? cy.getElementById(selectedId) : undefined;
      if (sel && sel.nonempty()) cy.center(sel);
      else if (cy.nodes().length > 0) cy.center(cy.nodes().max((d) => Number(d.data("deg")) || 0).ele);
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
  // "draft" skips the expensive force-iteration refinement — essential to keep a
  // multi-thousand-node container map from locking up during layout.
  const big = count > 1200;
  return {
    name: "fcose",
    quality: big ? "draft" : "default",
    animate: count <= 200,
    randomize: true,
    fit: true,
    padding: 40,
    samplingType: true,
    nodeRepulsion: 4500 + spacing * 30,
    idealEdgeLength: spacing,
    nodeSeparation: Math.max(20, spacing * 0.85),
    packComponents: true,
  } as unknown as cytoscape.LayoutOptions;
}

function buildStyle(maxDeg: number, bigRender = false): cytoscape.StylesheetStyle[] {
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
        // On big maps only draw labels once zoomed in fairly close — labelling
        // thousands of nodes at once is a major render cost.
        "min-zoomed-font-size": bigRender ? 14 : 8,
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
        // Big maps use "haystack" — the cheapest edge renderer (no bezier/arrow
        // math), at the cost of arrowheads. Small graphs keep directional arrows.
        "curve-style": bigRender ? "haystack" : "straight",
        "target-arrow-shape": bigRender ? "none" : "triangle",
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
  if (graph) {
    detailEl.innerHTML = renderDetail(graph, byId, id, {
      containerMode: currentMeta?.mode === "containers",
      expanded: expandedIds,
    });
  }
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

// Detail-panel interactions (event delegation): "Focus on this node" button, and
// related-node links (which recentre + select the clicked node).
detailEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  // Expand / collapse a container: the host owns the data, so just ask it to
  // re-render the drill-in with this node added to / removed from the set.
  const expandBtn = target.closest(".d-expand") as HTMLElement | null;
  if (expandBtn?.dataset.id) {
    e.preventDefault();
    const type = expandBtn.dataset.action === "collapse" ? "collapse" : "expand";
    vscodeApi.postMessage({ type, id: expandBtn.dataset.id });
    return;
  }
  const focusBtn = target.closest(".d-focus") as HTMLElement | null;
  if (focusBtn?.dataset.id) {
    e.preventDefault();
    focusOnNode(focusBtn.dataset.id);
    return;
  }
  const link = target.closest(".node-link") as HTMLElement | null;
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
  const edgeCounts = countBy(g.edges.map((e) => e.type));

  // Group nodes by type (sorted by label) so each type can expand into a
  // searchable, individually-selectable list of its own nodes.
  nodesByType = new Map();
  for (const n of g.nodes) {
    const list = nodesByType.get(n.type);
    if (list) list.push(n);
    else nodesByType.set(n.type, [n]);
  }
  for (const list of nodesByType.values()) list.sort((a, b) => a.label.localeCompare(b.label));

  enabledNodeTypes.clear();
  enabledEdgeTypes.clear();
  hiddenNodeIds.clear();
  for (const t of nodesByType.keys()) enabledNodeTypes.add(t);
  for (const t of edgeCounts.keys()) enabledEdgeTypes.add(t);

  nodeFiltersEl.innerHTML = "";
  for (const type of [...nodesByType.keys()].sort((a, b) => a.localeCompare(b))) {
    nodeFiltersEl.appendChild(typeGroup(type, nodesByType.get(type)!, typeColor(type)));
  }
  edgeFiltersEl.innerHTML = "";
  for (const [type, count] of sortedEntries(edgeCounts)) {
    edgeFiltersEl.appendChild(filterRow(type, count, undefined, enabledEdgeTypes, type, applyFilters));
  }
}

// Cap on member rows drawn per expanded type — keeps the DOM small even when a
// type has tens of thousands of nodes; the per-type search narrows past it.
const MEMBER_CAP = 250;

// One expandable type group: header (twisty + on/off checkbox + name + count),
// and a lazily-built, searchable, individually-checkable list of its nodes.
function typeGroup(type: string, nodes: GraphNode[], color: string): HTMLElement {
  const group = document.createElement("div");
  group.className = "type-group";
  group.dataset.type = type;

  const head = document.createElement("div");
  head.className = "type-head";

  const twisty = document.createElement("span");
  twisty.className = "twisty";
  twisty.textContent = "▸";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "type-cb";
  cb.checked = true;

  const dot = document.createElement("span");
  dot.className = "dot sm";
  dot.style.background = color;

  const name = document.createElement("span");
  name.className = "type-name";
  name.textContent = type;

  const cnt = document.createElement("span");
  cnt.className = "count";
  cnt.textContent = String(nodes.length);

  head.append(twisty, cb, dot, name, cnt);

  const members = document.createElement("div");
  members.className = "type-members";
  members.hidden = true;

  const search = document.createElement("input");
  search.type = "search";
  search.className = "member-search";
  search.placeholder = `search ${type} by name…`;
  search.autocomplete = "off";

  const actions = document.createElement("div");
  actions.className = "member-actions";
  const allLink = document.createElement("a");
  allLink.textContent = "all";
  const noneLink = document.createElement("a");
  noneLink.textContent = "none";
  const sep = document.createElement("span");
  sep.textContent = " · ";
  actions.append(allLink, sep, noneLink);

  const list = document.createElement("div");
  list.className = "member-list";
  const more = document.createElement("div");
  more.className = "member-more muted";

  members.append(search, actions, list, more);
  group.append(head, members);

  const draw = () => renderMembers(type, list, more, color, search.value);

  const toggleExpand = () => {
    const opening = members.hidden;
    members.hidden = !opening;
    twisty.textContent = opening ? "▾" : "▸";
    if (opening && list.childElementCount === 0) draw();
  };
  twisty.addEventListener("click", toggleExpand);
  name.addEventListener("click", toggleExpand);

  // Header checkbox toggles the whole type: if anything of it is visible, hide
  // all; otherwise show all (works whether it was off or just all-hidden).
  cb.addEventListener("change", () => {
    const total = nodesByType.get(type)?.length ?? 0;
    const anyVisible = enabledNodeTypes.has(type) && hiddenCountOfType(type) < total;
    if (anyVisible) {
      enabledNodeTypes.delete(type);
    } else {
      enabledNodeTypes.add(type);
      unhideType(type);
    }
    if (!members.hidden) draw();
    updateTypeCheckbox(type);
    applyFilters();
  });

  // Per-type "all / none" — the practical way to then tick just a few.
  allLink.addEventListener("click", () => {
    enabledNodeTypes.add(type);
    unhideType(type);
    if (!members.hidden) draw();
    updateTypeCheckbox(type);
    applyFilters();
  });
  noneLink.addEventListener("click", () => {
    for (const n of nodesByType.get(type) ?? []) hiddenNodeIds.add(n.id);
    if (!members.hidden) draw();
    updateTypeCheckbox(type);
    applyFilters();
  });

  search.addEventListener("input", draw);
  return group;
}

// Render (up to MEMBER_CAP of) a type's nodes matching the search term, each with
// a visibility checkbox and a name you can click to jump to it on the map.
function renderMembers(type: string, list: HTMLElement, more: HTMLElement, color: string, term: string): void {
  const all = nodesByType.get(type) ?? [];
  const t = term.trim().toLowerCase();
  const matches = t ? all.filter((n) => n.label.toLowerCase().includes(t)) : all;
  const shown = matches.slice(0, MEMBER_CAP);
  const typeOn = enabledNodeTypes.has(type);

  list.innerHTML = "";
  for (const n of shown) {
    const row = document.createElement("div");
    row.className = "member-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "member-cb";
    cb.checked = typeOn && !hiddenNodeIds.has(n.id);
    cb.addEventListener("change", () => {
      if (cb.checked) showMember(n, type);
      else hiddenNodeIds.add(n.id);
      updateTypeCheckbox(type);
      applyFilters();
    });

    const dot = document.createElement("span");
    dot.className = "dot sm";
    dot.style.background = color;

    const label = document.createElement("span");
    label.className = "member-name";
    label.textContent = n.label;
    label.title = `${n.id} — click to show & jump to it`;
    label.addEventListener("click", () => {
      if (!cb.checked) {
        cb.checked = true;
        showMember(n, type);
        updateTypeCheckbox(type);
        applyFilters();
      }
      focusNode(n.id); // centre + select (does not isolate)
    });

    row.append(cb, dot, label);
    list.appendChild(row);
  }

  more.textContent =
    matches.length === 0
      ? "no matches"
      : matches.length > MEMBER_CAP
        ? `showing ${MEMBER_CAP} of ${matches.length.toLocaleString()} — refine the search`
        : "";
}

function unhideType(type: string): void {
  for (const id of [...hiddenNodeIds]) if (byId.get(id)?.type === type) hiddenNodeIds.delete(id);
}

// Reflect a type's aggregate state on its header checkbox: checked = all shown,
// indeterminate = some hidden, unchecked = type off.
function updateTypeCheckbox(type: string): void {
  const cb = nodeFiltersEl.querySelector<HTMLInputElement>(
    `.type-group[data-type="${cssAttr(type)}"] .type-cb`,
  );
  if (!cb) return;
  const enabled = enabledNodeTypes.has(type);
  const hidden = hiddenCountOfType(type);
  const total = nodesByType.get(type)?.length ?? 0;
  cb.checked = enabled && hidden === 0;
  cb.indeterminate = enabled && hidden > 0 && hidden < total;
}

function hiddenCountOfType(type: string): number {
  let c = 0;
  for (const id of hiddenNodeIds) if (byId.get(id)?.type === type) c++;
  return c;
}

// Make a single node visible. If its type was entirely off, switch that type into
// "only-selected" mode (hide all its nodes) so this one shows on its own.
function showMember(n: GraphNode, type: string): void {
  if (!enabledNodeTypes.has(type)) {
    enabledNodeTypes.add(type);
    for (const m of nodesByType.get(type) ?? []) hiddenNodeIds.add(m.id);
  }
  hiddenNodeIds.delete(n.id);
}

function refreshNodeGroups(): void {
  nodeFiltersEl.querySelectorAll<HTMLElement>(".type-group").forEach((group) => {
    const type = group.dataset.type;
    if (!type) return;
    updateTypeCheckbox(type);
    const members = group.querySelector<HTMLElement>(".type-members");
    if (members && !members.hidden) {
      const list = group.querySelector<HTMLElement>(".member-list")!;
      const more = group.querySelector<HTMLElement>(".member-more")!;
      const search = group.querySelector<HTMLInputElement>(".member-search")!;
      renderMembers(type, list, more, typeColor(type), search.value);
    }
  });
}

function cssAttr(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
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
  const focusSet = focusVisibleIds(); // undefined = no focus restriction
  cy.batch(() => {
    const visible = new Set<string>();
    cy!.nodes().forEach((n) => {
      const show =
        enabledNodeTypes.has(n.data("type")) &&
        !hiddenNodeIds.has(n.id()) &&
        (!focusSet || focusSet.has(n.id()));
      if (show) visible.add(n.id());
      n.style("display", show ? "element" : "none");
    });
    cy!.edges().forEach((e) => {
      const ok =
        enabledEdgeTypes.has(e.data("type")) && visible.has(e.source().id()) && visible.has(e.target().id());
      e.style("display", ok ? "element" : "none");
    });
  });
  applySearch();
  updateStatus();
}

// ---- focus (isolate one node + its neighborhood) ----
// The set of node ids reachable from the focused node within `focusDepth` hops,
// traversing only type-enabled nodes/edges. Returns undefined when there's no
// focus (or the focused node is itself hidden by a type filter) — i.e. no
// restriction. Computed from the graph data, so it's independent of render state.
function focusVisibleIds(): Set<string> | undefined {
  if (!focusId || !graph) return undefined;
  const nodeOk = (id: string): boolean => {
    const n = byId.get(id);
    return !!n && enabledNodeTypes.has(n.type) && !hiddenNodeIds.has(id);
  };
  if (!nodeOk(focusId)) return undefined;

  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (const e of graph.edges) {
    if (!enabledEdgeTypes.has(e.type) || !nodeOk(e.src) || !nodeOk(e.dst)) continue;
    link(e.src, e.dst);
    link(e.dst, e.src);
  }

  const seen = new Set<string>([focusId]);
  let frontier = [focusId];
  for (let hop = 0; hop < focusDepth; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          next.push(nb);
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return seen;
}

function focusOnNode(id: string): void {
  if (!cy || cy.getElementById(id).empty()) return;
  focusId = id;
  applyFilters();
  updateFocusUI();
  select(id);
  fitVisible(260);
}

function clearFocus(): void {
  if (!focusId) return;
  focusId = undefined;
  applyFilters();
  updateFocusUI();
  fitVisible(220);
}

function fitVisible(duration: number): void {
  if (!cy) return;
  const vis = cy.nodes().filter((n) => n.style("display") !== "none");
  if (vis.nonempty()) cy.animate({ fit: { eles: vis, padding: 50 }, duration });
}

function updateFocusUI(): void {
  if (!focusId) {
    focusBarEl.hidden = true;
    return;
  }
  focusBarEl.hidden = false;
  const n = byId.get(focusId);
  focusLabelEl.textContent = n ? n.label : focusId;
  focusLabelEl.title = focusId;
}

focusDepthEl.addEventListener("change", () => {
  focusDepth = Math.max(1, Number(focusDepthEl.value) || 1);
  if (focusId) {
    applyFilters();
    fitVisible(220);
  }
});
focusClearEl.addEventListener("click", () => clearFocus());

// ---- drill-in (expand containers) ----
exploreResetEl.addEventListener("click", () => vscodeApi.postMessage({ type: "resetExploration" }));

function updateExploreUI(): void {
  const exploring = !!currentMeta?.exploring;
  exploreBarEl.hidden = !exploring;
  if (exploring) {
    const n = currentMeta?.expandedCount ?? expandedIds.size;
    exploreCountEl.textContent = `${n} expanded`;
  }
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
      hiddenNodeIds.clear();
      if (nodeOn) for (const t of nodesByType.keys()) enabledNodeTypes.add(t);
      refreshNodeGroups();
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
// Enter focuses the best match: exact label wins, otherwise the first partial —
// the quick path to "narrow to this one object/class and its connections".
searchEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const id = bestSearchMatch();
  if (id) {
    focusOnNode(id);
  } else if (searchEl.value.trim()) {
    // Not in the rendered slice — the host holds the full graph; ask it to find
    // the node and drill in to it (it answers with a new setGraph).
    vscodeApi.postMessage({ type: "find", query: searchEl.value.trim() });
  }
});

function bestSearchMatch(): string | undefined {
  if (!graph) return undefined;
  const term = searchEl.value.trim().toLowerCase();
  if (!term) return undefined;
  let partial: string | undefined;
  for (const n of graph.nodes) {
    const label = n.label.toLowerCase();
    if (label === term) return n.id;
    if (!partial && label.includes(term)) partial = n.id;
  }
  return partial;
}

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
  const drawn = graph.nodes.length;
  const visibleNodes = cy.nodes().filter((n) => n.style("display") !== "none").length;
  const nodePart = visibleNodes === drawn ? `${fmt(drawn)} nodes` : `${fmt(visibleNodes)}/${fmt(drawn)} nodes`;
  let prefix = "";
  let suffix = "";
  if (currentMeta) {
    prefix = currentMeta.exploring ? "exploring · " : currentMeta.mode === "containers" ? "containers · " : "full · ";
    if (currentMeta.capDropped > 0) {
      suffix = ` — top ${fmt(drawn)} of ${fmt(currentMeta.totalNodes)} by connectivity; search reaches the rest`;
    } else if (currentMeta.mode === "containers" && currentMeta.totalNodes > drawn) {
      suffix = ` (of ${fmt(currentMeta.totalNodes)})`;
    }
  }
  statusEl.textContent = `${prefix}${nodePart} · ${fmt(graph.edges.length)} edges${suffix}`;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function countBy(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return m;
}

function sortedEntries(m: Map<string, number>): [string, number][] {
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
