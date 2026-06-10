import Graphology from "graphology";
import Sigma from "sigma";
import type { NodeDisplayData, EdgeDisplayData } from "sigma/types";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { Graph as GraphData, GraphNode } from "../graph/types";
import { typeColor } from "../graph/labels";
import { renderDetail } from "./render";

interface SetGraphMsg {
  type: "setGraph";
  graph: GraphData;
  settings?: Settings;
  meta?: Meta;
  expandRoot?: string;
}

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
// Faded fills for dimmed nodes/edges — sigma has no per-node opacity, so we blend
// the color toward the dark background instead.
const NODE_DIM = "rgba(130,130,130,0.12)";
const EDGE_BASE = "#5a5a5a";
const EDGE_DIM = "rgba(90,90,90,0.07)";

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
const layoutModeEl = $<HTMLButtonElement>("#layout-mode");

// Overlay for grouped-mode island halos + type labels. sigma has no native group
// hulls, so we draw them as HTML over the canvas and keep them aligned with the
// graph on every camera update. Lives inside #cy (position:relative), so its
// origin matches sigma's rendered (0,0).
const groupOverlayEl = document.createElement("div");
groupOverlayEl.id = "group-overlay";
cyEl.appendChild(groupOverlayEl);

// ---- state ----
let renderer: Sigma | undefined; // the sigma WebGL renderer
let model: Graphology | undefined; // the graphology graph model (nodes/edges + attrs)
let graph: GraphData | undefined; // the host's data graph
let byId = new Map<string, GraphNode>();
const enabledNodeTypes = new Set<string>(); // node types currently shown
const enabledEdgeTypes = new Set<string>();
const hiddenNodeIds = new Set<string>(); // individually unticked nodes (within shown types)
let nodesByType = new Map<string, GraphNode[]>(); // type -> its nodes, for the expandable filter tree
let selectedId: string | undefined;
let settings: Settings = { physics: true, spacing: 220, animateOnHover: true, motionMaxNodes: 800 };
let currentMeta: Meta | undefined;
let expandedIds = new Set<string>(); // containers drilled into (mirrors host state)
// Focus: when set, the map is narrowed to this node and its k-hop neighborhood.
let focusId: string | undefined;
let focusDepth = 1;

// ---- per-frame render state (read by the reducers; mutate then refresh()) ----
// Visibility is the single source of truth that used to be cytoscape's display
// flag: applyFilters() computes it, the node reducer + status/fit helpers read it.
let visibleIds = new Set<string>();
let hoverId: string | undefined;
let hoverSet: Set<string> | undefined; // hovered node + its neighbors (enlarge/highlight)
let selSet: Set<string> | undefined; // selected node + its neighbors (label-on)
let selEdges: Set<string> | undefined; // edges incident to the selection (accent)
let searchTerm = ""; // lowercased; non-matching nodes dim

// Layout mode: "force" = force-directed (forceAtlas2); "grouped" = one island per
// node type. Grouped trades intra-group connectivity for clean separation by color.
type LayoutMode = "force" | "grouped";
let layoutMode: LayoutMode = "force";
// One per type in grouped mode: the island's centre, radius and color, used to
// draw the overlay halo + label and keep them in sync with the camera.
interface Island {
  type: string;
  cx: number;
  cy: number;
  R: number;
  color: string;
  count: number;
}
let groupedIslands: Island[] = [];

// Node sizing: base radius mapped from degree, like the old mapData(deg,0,maxDeg,14,52).
const SIZE_MIN = 4;
const SIZE_MAX = 20;
const HOVER_SCALE = 1.6;

// ---- gentle-drift animation state ----
let driftRAF: number | undefined;
const driftHomes = new Map<string, { x: number; y: number }>();
const driftParams = new Map<string, { ax: number; ay: number; fx: number; fy: number; px: number; py: number }>();
let driftT0 = 0;
let draggedNode: string | undefined; // node under an active drag (don't drift it)

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
function build(g: GraphData): void {
  byId = new Map(g.nodes.map((n) => [n.id, n]));
  selectedId = undefined;
  focusId = undefined;
  hoverId = hoverSet = selSet = selEdges = undefined;
  searchTerm = "";
  updateFocusUI();
  clearDetail();

  const degree = new Map<string, number>();
  for (const e of g.edges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }
  let maxDeg = 1;
  for (const d of degree.values()) maxDeg = Math.max(maxDeg, d);

  // Build the graphology model. Multi/self-loops mirror what cytoscape tolerated.
  const m = new Graphology({ type: "directed", multi: true, allowSelfLoops: true });
  const N = g.nodes.length;
  g.nodes.forEach((n, i) => {
    if (m.hasNode(n.id)) return; // ignore accidental duplicate ids (cytoscape errored)
    const deg = degree.get(n.id) ?? 0;
    const size = SIZE_MIN + (maxDeg > 0 ? (deg / maxDeg) * (SIZE_MAX - SIZE_MIN) : 0);
    const base = typeColor(n.type);
    // Seed positions on a circle so forceAtlas2 has something to push apart (it
    // can't separate coincident nodes) and nothing renders stacked at (0,0).
    const a = (2 * Math.PI * i) / Math.max(1, N);
    m.addNode(n.id, {
      x: Math.cos(a),
      y: Math.sin(a),
      size,
      baseSize: size,
      label: n.label,
      type: n.type,
      deg,
      color: n.external ? hexToRgba(base, 0.55) : base,
      external: n.external ? 1 : 0,
    });
  });
  g.edges.forEach((e, i) => {
    // Skip dangling edges (endpoint not present) — applyFilters would hide them
    // anyway, and addEdge would throw.
    if (!m.hasNode(e.src) || !m.hasNode(e.dst)) return;
    m.addEdgeWithKey(`e${i}`, e.src, e.dst, { type: e.type });
  });

  // Edges, not nodes, are what make rendering heavy — the capped view is the
  // densest slice of the graph, so both counts gate the cheap-render paths.
  const bigRender = g.nodes.length > 1500 || g.edges.length > 8000;

  stopDrift();
  renderer?.kill();
  model = m;
  renderer = new Sigma(m, cyEl, {
    renderLabels: true,
    // Labels are culled below a readable on-screen size — zoomed out you see
    // shapes/colors, text appears as you zoom in. Bigger threshold = fewer labels
    // on dense maps. Hover/selection force their label on regardless (reducers).
    labelRenderedSizeThreshold: bigRender ? 14 : 9,
    labelColor: { color: "#e6e6e6" },
    labelDensity: 0.6,
    defaultNodeColor: "#888",
    defaultEdgeColor: EDGE_BASE,
    zIndex: true,
    enableEdgeEvents: false,
    // Keep pan/zoom fast on big maps by dropping edges mid-gesture (replaces the
    // old hideEdgesOnViewport / texture-on-viewport tricks).
    hideEdgesOnMove: bigRender,
    allowInvalidContainer: true, // headless harness has a zero-size container at first
    nodeReducer,
    edgeReducer,
  });

  // Dev-only global handles for the headless harness (see dev/). esbuild folds the
  // condition to `false` in production builds and dead-code-eliminates the block.
  if (process.env.NODE_ENV !== "production") {
    (window as unknown as Record<string, unknown>).__sigma = renderer;
    (window as unknown as Record<string, unknown>).__graph = m;
    (window as unknown as Record<string, unknown>).__fit = fitToNodeIds;
  }

  // ---- events ----
  renderer.on("clickNode", ({ node }) => select(node));
  renderer.on("clickStage", () => clearSelection());
  renderer.on("enterNode", ({ node }) => onHover(node));
  renderer.on("leaveNode", () => offHover());
  // Drag a node to reposition it; remember its new resting spot so it drifts there.
  renderer.on("downNode", ({ node }) => {
    draggedNode = node;
  });
  renderer.getMouseCaptor().on("mousemovebody", (e) => {
    if (!draggedNode || !renderer || !model) return;
    const p = renderer.viewportToGraph(e);
    model.setNodeAttribute(draggedNode, "x", p.x);
    model.setNodeAttribute(draggedNode, "y", p.y);
    driftHomes.set(draggedNode, { x: p.x, y: p.y });
    // Stop the camera from panning while we drag a node.
    e.preventSigmaDefault();
    e.original.preventDefault();
    e.original.stopPropagation();
  });
  const endDrag = () => {
    draggedNode = undefined;
  };
  renderer.getMouseCaptor().on("mouseup", endDrag);
  // Keep the grouped-mode halos/labels glued to the graph as the camera moves.
  renderer.getCamera().on("updated", positionGroupOverlay);
  renderer.on("resize", positionGroupOverlay);

  buildFilters(g);
  applyFilters();
  runLayout();
  updateStatus();
}

// ---- reducers: per-frame appearance, computed from the render state above ----
// Sigma REPLACES a node's render data with whatever this returns (it does not merge
// onto the graph attributes), so we mutate the per-frame `data` copy in place — it
// already carries x/y/size/color/label — and override on top. Returning a bare
// partial would drop x/y and Sigma throws "could not find a valid position". We also
// clear `type`: the model keeps it for grouping/filtering, but Sigma reads a node's
// `type` as its render *program* name and we register none, so every node must fall
// back to the default circle program (else "could not find a suitable program").
function nodeReducer(node: string, data: Record<string, unknown>): Partial<NodeDisplayData> {
  const res = data as Partial<NodeDisplayData> & { type?: unknown };
  res.type = undefined;
  if (!visibleIds.has(node)) {
    res.hidden = true;
    return res;
  }
  const baseSize = (data.baseSize as number) ?? (data.size as number) ?? SIZE_MIN;
  if (hoverSet) {
    // Hover: enlarge + label the node and its neighbors; dim everything else.
    if (hoverSet.has(node)) {
      res.highlighted = true;
      res.forceLabel = true;
      res.size = baseSize * HOVER_SCALE;
      res.zIndex = 2;
    } else {
      res.color = NODE_DIM;
      res.label = "";
      res.zIndex = 0;
    }
    return res;
  }
  if (selectedId) {
    if (node === selectedId) {
      res.highlighted = true;
      res.forceLabel = true;
      res.zIndex = 2;
    } else if (selSet?.has(node)) {
      res.forceLabel = true;
      res.zIndex = 1;
    }
  }
  // Search dims non-matches (independent of selection).
  if (searchTerm && !String(data.label ?? "").toLowerCase().includes(searchTerm)) {
    res.color = NODE_DIM;
    res.label = "";
  }
  return res;
}

function edgeReducer(edge: string, data: Record<string, unknown>): Partial<EdgeDisplayData> {
  if (!model) return { hidden: true };
  if (!enabledEdgeTypes.has(data.type as string)) return { hidden: true };
  const s = model.source(edge);
  const t = model.target(edge);
  if (!visibleIds.has(s) || !visibleIds.has(t)) return { hidden: true };
  if (hoverSet) {
    if (hoverSet.has(s) && hoverSet.has(t)) return { color: accent, size: 2, zIndex: 2 };
    return { color: EDGE_DIM, zIndex: 0 };
  }
  if (selEdges?.has(edge)) return { color: accent, size: 2, zIndex: 1 };
  return {};
}

function refresh(): void {
  renderer?.refresh({ skipIndexation: true });
}

// ---- layout & motion ----
function runLayout(): void {
  if (!renderer || !model) return;
  stopDrift();
  if (layoutMode === "grouped") {
    runGroupedLayout();
    return;
  }
  // Leaving grouped mode: tear down the island overlay.
  groupedIslands = [];
  renderGroupOverlay();
  runForceLayout();
  // Land zoomed-in, centered on the selected node (e.g. a search hit the host just
  // drilled in to) or else the most-connected (and largest) node. The host caps how
  // much is rendered, so fitting "everything" is never the right landing.
  const focal = selectedId && model.hasNode(selectedId) ? selectedId : maxDegreeNode();
  if (focal) centerOn(focal, { ratio: 0.4 });
  if (driftEligible()) startDrift();
}

// Force layout via forceAtlas2 (synchronous, on the main thread). The default view
// is render-capped (graphViewer.maxRenderNodes = 1500), where this is ~0.4s. Only
// the opt-in "Show all" path feeds tens of thousands of nodes; there FA2 is steered
// down to a few iterations to bound the main-thread block (grouped mode, which is
// O(n) and instant, is the recommended layout for big graphs). A web-worker FA2
// supervisor — the real fix for async big-graph force — is future work (needs a CSP
// `worker-src blob:` allowance; see the migration plan).
function runForceLayout(): void {
  if (!model) return;
  const nodes = model.order;
  const edges = model.size;
  const iterations =
    nodes <= 200 ? 400 : nodes <= 2000 ? 120 : edges > 6000 || nodes > 6000 ? (nodes > 15000 ? 12 : 30) : 60;
  const spacing = settings.spacing;
  forceAtlas2.assign(model, {
    iterations,
    settings: {
      // Spread harder: weak gravity so things don't pile into one clump, high
      // repulsion (scalingRatio) to push neighbors apart, Barnes-Hut to stay cheap
      // on big/dense slices. Maps the old fcose spread knobs onto FA2.
      gravity: 0.4,
      scalingRatio: 8 + spacing / 18,
      slowDown: 1 + nodes / 5000,
      barnesHutOptimize: nodes > 1000,
      barnesHutTheta: 0.6,
      edgeWeightInfluence: 0,
    },
  });
  refreshIndexed();
}

// Grouped scatter: lay each node TYPE out as its own island, so the map reads as
// separated, color-coded clusters instead of one stacked hairball. Within an island
// the nodes spread on a phyllotaxis (sunflower) disc — even, gap-free, deterministic,
// and O(n), so it stays cheap even on the full "Show all" graph. Edge connectivity
// isn't honored inside an island (that's the trade for clean separation), but
// cross-island edges still draw the inter-type relationships.
function runGroupedLayout(): void {
  if (!model) return;
  if (model.order === 0) return;

  // Bucket nodes by type; largest islands first (then alphabetical) so the big ones
  // anchor the shelf-packing and the arrangement is stable across runs.
  const groups = new Map<string, string[]>();
  model.forEachNode((id, attr) => {
    const t = String(attr.type);
    const list = groups.get(t);
    if (list) list.push(id);
    else groups.set(t, [id]);
  });
  const entries = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );

  const gap = Math.max(140, settings.spacing * 1.6); // empty space between islands
  const step = Math.max(34, settings.spacing * 0.35); // ~nearest-neighbor spacing within an island
  const golden = Math.PI * (3 - Math.sqrt(5));

  // Each island's disc radius grows with its node count (phyllotaxis: R ≈ step·√n).
  const radii = entries.map(([, list]) => step * Math.sqrt(list.length) + step);
  // Shelf-pack the discs into rows, wrapping at a target width chosen to keep the
  // whole archipelago roughly square (√ of the summed cell areas).
  const cellArea = radii.reduce((s, r) => s + (2 * r + gap) ** 2, 0);
  const widest = Math.max(...radii) * 2 + gap;
  // Aim a bit wider than square so islands of very different sizes pack into a
  // landscape block (suits a wide editor viewport) rather than a tall column.
  const targetRowWidth = Math.max(widest, Math.sqrt(cellArea) * 1.4);

  const positions = new Map<string, { x: number; y: number }>();
  const islands: Island[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  entries.forEach(([type, list], gi) => {
    const R = radii[gi];
    const d = 2 * R;
    if (x > 0 && x + d > targetRowWidth) {
      y += rowH + gap; // wrap to the next shelf
      x = 0;
      rowH = 0;
    }
    const cx = x + R;
    const cyc = y + R;
    // Hubs to the middle: place the most-connected nodes near the island centre
    // (phyllotaxis index 0 is the centre), so each type's key nodes are easy to find
    // and the long-tail leaves fan out around them.
    const ordered = [...list].sort(
      (mId, nId) =>
        (Number(model!.getNodeAttribute(nId, "deg")) || 0) -
          (Number(model!.getNodeAttribute(mId, "deg")) || 0) || mId.localeCompare(nId),
    );
    ordered.forEach((id, k) => {
      const r = step * Math.sqrt(k + 0.5);
      const a = k * golden;
      positions.set(id, { x: cx + r * Math.cos(a), y: cyc + r * Math.sin(a) });
    });
    islands.push({ type, cx, cy: cyc, R, color: typeColor(type), count: list.length });
    x += d + gap;
    rowH = Math.max(rowH, d);
  });

  model.forEachNode((id) => {
    const p = positions.get(id);
    if (p) {
      model!.setNodeAttribute(id, "x", p.x);
      model!.setNodeAttribute(id, "y", p.y);
    }
  });
  groupedIslands = islands;
  refreshIndexed();

  // Frame the whole archipelago when it's small enough to draw at once; on a huge
  // "Show all" map, land zoomed on the biggest hub like the force layout.
  if (visibleIds.size > 0 && visibleIds.size <= 3000) {
    fitToNodeIds([...visibleIds], { padding: 80, duration: 0 });
  } else {
    const focal = maxDegreeNode();
    if (focal) centerOn(focal, { ratio: 0.6 });
  }
  renderGroupOverlay();
  if (driftEligible()) startDrift();
}

// Rebuild the grouped-mode overlay DOM (one halo + label per island), then place it.
// Empties the overlay whenever we're not in grouped mode.
function renderGroupOverlay(): void {
  groupOverlayEl.textContent = "";
  if (layoutMode !== "grouped") return;
  for (const is of groupedIslands) {
    const halo = document.createElement("div");
    halo.className = "group-halo";
    halo.style.borderColor = is.color;
    halo.style.background = `${is.color}14`; // ~8% alpha tint
    const label = document.createElement("div");
    label.className = "group-label";
    label.textContent = `${is.type} · ${is.count.toLocaleString()}`;
    label.style.color = is.color;
    groupOverlayEl.append(halo, label);
  }
  positionGroupOverlay();
}

// Project each island's model-space centre/radius to rendered pixels and move its
// halo + label there. Cheap (a handful of elements), so it runs on every camera move.
function positionGroupOverlay(): void {
  if (!renderer || layoutMode !== "grouped" || groupedIslands.length === 0) return;
  const halos = groupOverlayEl.querySelectorAll<HTMLElement>(".group-halo");
  const labels = groupOverlayEl.querySelectorAll<HTMLElement>(".group-label");
  groupedIslands.forEach((is, i) => {
    const centre = renderer!.graphToViewport({ x: is.cx, y: is.cy });
    const edge = renderer!.graphToViewport({ x: is.cx + is.R, y: is.cy });
    const rPx = Math.hypot(edge.x - centre.x, edge.y - centre.y);
    const halo = halos[i];
    if (halo) {
      halo.style.width = `${2 * rPx}px`;
      halo.style.height = `${2 * rPx}px`;
      halo.style.transform = `translate(${centre.x}px, ${centre.y}px) translate(-50%, -50%)`;
    }
    const label = labels[i];
    if (label) {
      label.style.fontSize = `${Math.max(12, Math.min(46, 0.17 * rPx))}px`;
      label.style.transform = `translate(${centre.x}px, ${centre.y - rPx}px) translate(-50%, -120%)`;
    }
  });
}

// ---- camera helpers (sigma has no cy.fit(eles)) ----
// Centre the camera on one node, optionally setting an absolute zoom (sigma ratio:
// smaller = closer). Used for landings and detail-panel "focus on this node".
function centerOn(id: string, opts: { ratio?: number; duration?: number } = {}): void {
  if (!renderer) return;
  const d = renderer.getNodeDisplayData(id);
  if (!d) return;
  const cam = renderer.getCamera();
  const state: { x: number; y: number; ratio?: number } = { x: d.x, y: d.y };
  if (opts.ratio !== undefined) state.ratio = opts.ratio;
  cam.animate(state, { duration: opts.duration ?? 300 });
}

// Fit the camera to a set of nodes with padding. Derives the zoom from the nodes'
// current pixel bbox (exact for the live camera) and recentres on their framed-graph
// centroid (camera x/y live in that normalized space).
function fitToNodeIds(ids: string[], opts: { padding?: number; duration?: number } = {}): void {
  if (!renderer || !model || ids.length === 0) return;
  const cam = renderer.getCamera();
  const { width, height } = renderer.getDimensions();
  const pad = opts.padding ?? 60;
  let minVX = Infinity;
  let maxVX = -Infinity;
  let minVY = Infinity;
  let maxVY = -Infinity;
  let minFX = Infinity;
  let maxFX = -Infinity;
  let minFY = Infinity;
  let maxFY = -Infinity;
  let any = false;
  for (const id of ids) {
    const d = renderer.getNodeDisplayData(id);
    if (!d) continue;
    any = true;
    const v = renderer.graphToViewport({ x: model.getNodeAttribute(id, "x"), y: model.getNodeAttribute(id, "y") });
    minVX = Math.min(minVX, v.x);
    maxVX = Math.max(maxVX, v.x);
    minVY = Math.min(minVY, v.y);
    maxVY = Math.max(maxVY, v.y);
    minFX = Math.min(minFX, d.x);
    maxFX = Math.max(maxFX, d.x);
    minFY = Math.min(minFY, d.y);
    maxFY = Math.max(maxFY, d.y);
  }
  if (!any) return;
  const bw = Math.max(maxVX - minVX, 1);
  const bh = Math.max(maxVY - minVY, 1);
  const scale = Math.min((width - 2 * pad) / bw, (height - 2 * pad) / bh);
  // Don't zoom in past a sane limit when fitting a tiny set (e.g. one node).
  const ratio = Math.max(cam.ratio / scale, 0.08);
  cam.animate(
    { x: (minFX + maxFX) / 2, y: (minFY + maxFY) / 2, ratio },
    { duration: opts.duration ?? 300 },
  );
}

function maxDegreeNode(): string | undefined {
  if (!model || model.order === 0) return undefined;
  let best: string | undefined;
  let bestDeg = -1;
  model.forEachNode((id, attr) => {
    const d = Number(attr.deg) || 0;
    if (d > bestDeg) {
      bestDeg = d;
      best = id;
    }
  });
  return best;
}

// Re-index sigma after a layout move (positions changed → spatial index stale).
function refreshIndexed(): void {
  renderer?.refresh();
}

// Gentle continuous drift: each node bobs a few px on its own slow sine wave around
// its resting spot (stable — always returns home; cheap math). Auto-disabled above
// `motionMaxNodes`.
function driftEligible(): boolean {
  return !!model && settings.physics && !document.hidden && model.order <= settings.motionMaxNodes;
}

function startDrift(): void {
  if (!renderer || !model || !driftEligible()) return;
  stopDrift();
  driftHomes.clear();
  driftParams.clear();
  model.forEachNode((id, attr) => {
    driftHomes.set(id, { x: Number(attr.x), y: Number(attr.y) });
    driftParams.set(id, {
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
    if (!renderer || !model || driftRAF === undefined) return;
    const t = (performance.now() - driftT0) / 1000;
    model.forEachNode((id) => {
      if (id === draggedNode) return; // don't fight an active drag
      const home = driftHomes.get(id);
      const pr = driftParams.get(id);
      if (!home || !pr) return;
      model!.setNodeAttribute(id, "x", home.x + pr.ax * Math.sin(t * pr.fx + pr.px));
      model!.setNodeAttribute(id, "y", home.y + pr.ay * Math.sin(t * pr.fy + pr.py));
    });
    refresh();
    driftRAF = requestAnimationFrame(tick);
  };
  driftRAF = requestAnimationFrame(tick);
}

function stopDrift(): void {
  if (driftRAF !== undefined) cancelAnimationFrame(driftRAF);
  driftRAF = undefined;
}

// ---- hover ----
// Hover dims everything else and enlarges + highlights the hovered node and its
// neighbors. It never moves anything (the gentle drift keeps running underneath).
function onHover(node: string): void {
  if (!settings.animateOnHover || !model) return;
  hoverId = node;
  hoverSet = new Set<string>([node, ...model.neighbors(node)]);
  refresh();
}

function offHover(): void {
  hoverId = undefined;
  hoverSet = undefined;
  refresh();
}

// ---- selection ----
function select(id: string): void {
  if (!model || !model.hasNode(id)) return;
  selectedId = id;
  selSet = new Set<string>([id, ...model.neighbors(id)]);
  selEdges = new Set<string>(model.edges(id));
  refresh();
  if (graph) {
    detailEl.innerHTML = renderDetail(graph, byId, id, {
      containerMode: currentMeta?.mode === "containers",
      expanded: expandedIds,
    });
  }
}

function focusNode(id: string): void {
  if (!model || !model.hasNode(id)) return;
  centerOn(id, { duration: 200 });
  select(id);
}

function clearSelection(): void {
  selectedId = undefined;
  selSet = undefined;
  selEdges = undefined;
  refresh();
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
  if (!renderer) return;
  if (prev.spacing !== next.spacing) {
    runLayout(); // re-space everything, then resume drift
  } else if (prev.physics !== next.physics || prev.motionMaxNodes !== next.motionMaxNodes) {
    if (driftEligible()) startDrift();
    else stopDrift();
  }
}

// Pause the drift while the tab is hidden so it doesn't burn CPU in the background;
// resume when shown again.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopDrift();
  else if (driftEligible()) startDrift();
});

// ---- filters ----
function buildFilters(g: GraphData): void {
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

// Cap on member rows drawn per expanded type — keeps the DOM small even when a type
// has tens of thousands of nodes; the per-type search narrows past it.
const MEMBER_CAP = 250;

// One expandable type group: header (twisty + on/off checkbox + name + count), and a
// lazily-built, searchable, individually-checkable list of its nodes.
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

  // Header checkbox toggles the whole type: if anything of it is visible, hide all;
  // otherwise show all (works whether it was off or just all-hidden).
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

// Render (up to MEMBER_CAP of) a type's nodes matching the search term, each with a
// visibility checkbox and a name you can click to jump to it on the map.
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

// Recompute the visibility set (the single source of truth the reducers read) and
// repaint. Replaces cytoscape's per-element display flag.
function applyFilters(): void {
  if (!renderer || !model) return;
  const focusSet = focusVisibleIds(); // undefined = no focus restriction
  const next = new Set<string>();
  model.forEachNode((id, attr) => {
    const show =
      enabledNodeTypes.has(String(attr.type)) &&
      !hiddenNodeIds.has(id) &&
      (!focusSet || focusSet.has(id));
    if (show) next.add(id);
  });
  visibleIds = next;
  refresh();
  updateStatus();
}

// ---- focus (isolate one node + its neighborhood) ----
// The set of node ids reachable from the focused node within `focusDepth` hops,
// traversing only type-enabled nodes/edges. Returns undefined when there's no focus
// (or the focused node is itself hidden by a type filter) — i.e. no restriction.
// Computed from the graph data, so it's independent of render state.
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
  if (!model || !model.hasNode(id)) return;
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
  if (visibleIds.size === 0) return;
  fitToNodeIds([...visibleIds], { padding: 50, duration });
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
// Enter focuses the best match: exact label wins, otherwise the first partial — the
// quick path to "narrow to this one object/class and its connections".
searchEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const id = bestSearchMatch();
  if (id) {
    focusOnNode(id);
  } else if (searchEl.value.trim()) {
    // Not in the rendered slice — the host holds the full graph; ask it to find the
    // node and drill in to it (it answers with a new setGraph).
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
  if (!renderer) return;
  searchTerm = searchEl.value.trim().toLowerCase();
  refresh();
  updateStatus();
}

// ---- toolbar ----
// Layout toggle: flip between force-directed and grouped-by-type, then re-lay out.
layoutModeEl.addEventListener("click", () => {
  layoutMode = layoutMode === "force" ? "grouped" : "force";
  updateLayoutModeUI();
  runLayout();
});
function updateLayoutModeUI(): void {
  const grouped = layoutMode === "grouped";
  layoutModeEl.textContent = grouped ? "Layout: Grouped" : "Layout: Force";
  layoutModeEl.title = grouped
    ? "Grouped by type (one island per node type). Click for force-directed."
    : "Force-directed (connected nodes attract). Click to group by type.";
  layoutModeEl.classList.toggle("active", grouped);
}
updateLayoutModeUI();
$<HTMLButtonElement>("#relayout").addEventListener("click", () => runLayout());
$<HTMLButtonElement>("#fit").addEventListener("click", () => renderer?.getCamera().animatedReset({ duration: 300 }));
$<HTMLButtonElement>("#toggle-filters").addEventListener("click", () => {
  document.getElementById("app")?.classList.toggle("filters-hidden");
  setTimeout(() => renderer?.resize(), 0);
});

// ---- helpers ----
function updateStatus(): void {
  if (!model || !graph) return;
  const drawn = graph.nodes.length;
  const visibleNodes = visibleIds.size;
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

// Blend a #rrggbb toward transparency (for external/dimmed fills).
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(v.slice(0, 2), 16) || 0;
  const g = parseInt(v.slice(2, 4), 16) || 0;
  const b = parseInt(v.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
