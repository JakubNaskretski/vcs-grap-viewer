import * as path from "path";
import * as vscode from "vscode";
import { Graph } from "./graph/types";
import { containerId, exploreView, isNestedId, isNestedType, rollupToContainers, topConnectedSlice } from "./graph/rollup";
import { GraphSource } from "./sources";

const BIG_GRAPH = 2500; // above this many nodes, default to the container-level view

/** Manages the single Graph Viewer webview panel and its data source. */
export class GraphPanel {
  public static current: GraphPanel | undefined;
  private static readonly viewType = "graphViewer.view";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;

  private source: GraphSource | undefined;
  private fullGraph: Graph | undefined;
  private rolledGraph: Graph | undefined; // cached container-level view
  private viewMode: "auto" | "containers" | "all" = "auto";
  private expanded = new Set<string>(); // containers drilled into (container view only)
  private webviewReady = false;

  static async createOrShow(context: vscode.ExtensionContext, source: GraphSource): Promise<void> {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal(column);
      await GraphPanel.current.setSource(source);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      "Graph Viewer",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist"), vscode.Uri.joinPath(context.extensionUri, "media")],
      },
    );
    GraphPanel.current = new GraphPanel(panel, context.extensionUri);
    await GraphPanel.current.setSource(source);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.panel.webview.html = this.html();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.onMessage(msg),
      null,
      this.disposables,
    );
    // Push appearance settings (spacing / physics / hover) to the webview live,
    // without reloading the graph, whenever they change.
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (
          e.affectsConfiguration("graphViewer.physics") ||
          e.affectsConfiguration("graphViewer.spacing") ||
          e.affectsConfiguration("graphViewer.animateOnHover") ||
          e.affectsConfiguration("graphViewer.motionMaxNodes")
        ) {
          this.postSettings();
        }
        // The related-node cap changes the current drill-in, so re-render it.
        if (e.affectsConfiguration("graphViewer.maxRelatedNodes") && this.expanded.size > 0) {
          this.post();
        }
      },
      null,
      this.disposables,
    );
  }

  private readSettings(): { physics: boolean; spacing: number; animateOnHover: boolean; motionMaxNodes: number } {
    const c = vscode.workspace.getConfiguration("graphViewer");
    return {
      physics: c.get<boolean>("physics", true),
      spacing: c.get<number>("spacing", 220),
      animateOnHover: c.get<boolean>("animateOnHover", true),
      motionMaxNodes: c.get<number>("motionMaxNodes", 800),
    };
  }

  private postSettings(): void {
    if (this.webviewReady) {
      void this.panel.webview.postMessage({ type: "updateSettings", settings: this.readSettings() });
    }
  }

  /** Point the panel at a new source: load, retitle, watch, and render. */
  async setSource(source: GraphSource): Promise<void> {
    this.source = source;
    this.viewMode = "auto"; // a new graph picks its own default (size-based)
    this.expanded.clear();
    this.panel.title = `Graph: ${source.label}`;
    this.setupWatcher(source);
    await this.reload();
  }

  /** Re-load the current source and push it to the webview. */
  async reload(): Promise<void> {
    if (!this.source) return;
    try {
      this.fullGraph = await this.source.load();
      this.rolledGraph = undefined;
      this.expanded.clear(); // ids may have changed; start from the overview
      this.post();
    } catch (err) {
      void vscode.window.showErrorMessage(`Graph Viewer: ${(err as Error).message}`);
    }
  }

  private setupWatcher(source: GraphSource): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    if (!source.watchPath) return;
    const dir = path.dirname(source.watchPath);
    const base = path.basename(source.watchPath);
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, base));
    const onChange = () => {
      if (vscode.workspace.getConfiguration("graphViewer").get<boolean>("reloadOnChange", true)) {
        void this.reload();
      }
    };
    this.watcher.onDidChange(onChange, null, this.disposables);
    this.watcher.onDidCreate(onChange, null, this.disposables);
    this.disposables.push(this.watcher);
  }

  private onMessage(msg: { type?: string; mode?: "containers" | "all"; id?: string; query?: string }): void {
    if (msg?.type === "ready") {
      this.webviewReady = true;
      this.post();
    } else if (msg?.type === "setViewMode") {
      void this.setViewMode(msg.mode);
    } else if (msg?.type === "expand" && msg.id) {
      this.expanded.add(msg.id);
      this.post(msg.id);
    } else if (msg?.type === "collapse" && msg.id) {
      this.expanded.delete(msg.id);
      this.post();
    } else if (msg?.type === "resetExploration") {
      this.expanded.clear();
      this.post();
    } else if (msg?.type === "find" && msg.query) {
      this.findInFullGraph(msg.query);
    }
  }

  /** Host-assisted search: the webview may only hold a capped slice, so when its
   *  local search misses, look the term up in the FULL graph and drill in to the
   *  hit (expanding its container so a nested hit becomes visible). */
  private findInFullGraph(query: string): void {
    if (!this.fullGraph) return;
    const term = query.trim().toLowerCase();
    if (!term) return;
    let partial: string | undefined;
    let hit: string | undefined;
    for (const n of this.fullGraph.nodes) {
      const label = (n.label || "").toLowerCase();
      if (label === term) {
        hit = n.id;
        break;
      }
      if (!partial && (label.includes(term) || n.id.toLowerCase().includes(term))) partial = n.id;
    }
    hit ??= partial;
    if (!hit) {
      void this.panel.webview.postMessage({ type: "findResult", found: false, query });
      return;
    }
    // Drill in to the hit: expand its container (or itself, if it is a main node)
    // and echo the hit id so the webview selects it.
    this.expanded.add(isNestedId(hit) ? containerId(hit) : hit);
    this.post(hit);
  }

  /** Switch between the container-level map and the full graph. Showing the full
   *  graph on a large dataset is gated behind an explicit, modal confirmation. */
  private async setViewMode(mode?: "containers" | "all"): Promise<void> {
    if (!this.fullGraph || (mode !== "containers" && mode !== "all")) return;
    if (mode === "all" && this.fullGraph.nodes.length > BIG_GRAPH) {
      const choice = await vscode.window.showWarningMessage(
        `This graph has ${this.fullGraph.nodes.length.toLocaleString()} nodes and ` +
          `${this.fullGraph.edges.length.toLocaleString()} edges. Rendering everything at once ` +
          `can be very slow or freeze the editor. Show all anyway?`,
        { modal: true },
        "Show all",
      );
      if (choice !== "Show all") return;
    }
    this.viewMode = mode;
    this.expanded.clear(); // overview / full are their own thing; drop the drill-in
    this.post();
  }

  private maxRelated(): number {
    return Math.max(0, vscode.workspace.getConfiguration("graphViewer").get<number>("maxRelatedNodes", 10));
  }

  /** Push the current view to the webview. `expandRoot` (the container just
   *  expanded) is echoed back so the webview can keep it selected and report any
   *  related nodes dropped past the cap. */
  private post(expandRoot?: string): void {
    if (!this.webviewReady || !this.fullGraph || !this.source) return;
    const total = this.fullGraph.nodes.length;
    const mode = this.viewMode === "auto" ? (total > BIG_GRAPH ? "containers" : "all") : this.viewMode;
    const exploring = mode === "containers" && this.expanded.size > 0;
    let graph = this.fullGraph;
    let truncatedRoot = 0;
    if (mode === "containers") {
      if (exploring) {
        const res = exploreView(this.fullGraph, this.expanded, this.maxRelated());
        graph = res.graph;
        if (expandRoot) truncatedRoot = res.truncated.get(expandRoot) ?? 0;
      } else {
        this.rolledGraph ??= rollupToContainers(this.fullGraph);
        graph = this.rolledGraph;
      }
    }
    // Hard render cap on the container overview: it can be huge despite the
    // rollup (graphs dominated by types that don't roll up — labels, custom
    // metadata records, objects). Rendering tens of thousands of nodes crashes
    // the webview, so the default landing view never exceeds the cap; drill-in
    // is per-step bounded already, and "Show all" stays modal-confirmed.
    let capDropped = 0;
    if (mode === "containers" && !exploring) {
      const cap = Math.max(
        100,
        vscode.workspace.getConfiguration("graphViewer").get<number>("maxRenderNodes", 1500),
      );
      // Edge budget rides the node cap: the top-connected slice is the densest
      // part of the graph, and edges (not nodes) are what freeze the layout.
      const sliced = topConnectedSlice(graph, cap, cap * 4);
      graph = sliced.graph;
      capDropped = sliced.dropped;
    }
    void this.panel.webview.postMessage({
      type: "setGraph",
      graph,
      label: this.source.label,
      settings: this.readSettings(),
      expandRoot,
      meta: {
        mode,
        totalNodes: total,
        totalEdges: this.fullGraph.edges.length,
        shownNodes: graph.nodes.length,
        shownEdges: graph.edges.length,
        hasNested: this.fullGraph.nodes.some((n) => isNestedType(n.type)),
        exploring,
        expanded: [...this.expanded],
        expandedCount: this.expanded.size,
        truncatedRoot,
        capDropped,
      },
    });
  }

  private html(): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "style.css"));
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Graph Viewer</title>
</head>
<body>
  <div id="app">
    <div id="toolbar">
      <input id="search" type="search" placeholder="Search nodes… (Enter to focus)" autocomplete="off" spellcheck="false" />
      <span id="status"></span>
      <button id="mode" class="mode-btn" hidden></button>
      <span id="focus-bar" class="focus-bar" hidden>
        <span class="focus-tag">focus</span>
        <span id="focus-label" class="focus-label"></span>
        <label class="focus-depth">depth
          <select id="focus-depth">
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </label>
        <button id="focus-clear" title="Show the whole graph again">✕ clear</button>
      </span>
      <span id="explore-bar" class="focus-bar" hidden>
        <span class="focus-tag">exploring</span>
        <span id="explore-count" class="focus-label"></span>
        <button id="explore-reset" title="Collapse everything and return to the overview">✕ reset</button>
      </span>
      <span class="spacer"></span>
      <button id="layout-mode" class="layout-btn" title="Toggle layout: force-directed vs grouped by type">Layout: Force</button>
      <button id="relayout" title="Re-run layout">Re-layout</button>
      <button id="fit" title="Fit graph to view">Fit</button>
      <button id="toggle-filters" title="Show/hide filters">Filters</button>
    </div>
    <aside id="filters">
      <section>
        <h3>Node types</h3>
        <div class="filter-actions"><a data-all="node-on">all</a> · <a data-all="node-off">none</a></div>
        <div id="node-filters"></div>
      </section>
      <section>
        <h3>Edge types</h3>
        <div class="filter-actions"><a data-all="edge-on">all</a> · <a data-all="edge-off">none</a></div>
        <div id="edge-filters"></div>
      </section>
    </aside>
    <div id="cy"></div>
    <aside id="detail"><div class="placeholder">Select a node to see its details.</div></aside>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    GraphPanel.current = undefined;
    this.watcher?.dispose();
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
