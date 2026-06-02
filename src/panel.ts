import * as path from "path";
import * as vscode from "vscode";
import { Graph } from "./graph/types";
import { GraphSource } from "./sources";

/** Manages the single Graph Viewer webview panel and its data source. */
export class GraphPanel {
  public static current: GraphPanel | undefined;
  private static readonly viewType = "graphViewer.view";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;

  private source: GraphSource | undefined;
  private graph: Graph | undefined;
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
      },
      null,
      this.disposables,
    );
  }

  private readSettings(): { physics: boolean; spacing: number; animateOnHover: boolean; motionMaxNodes: number } {
    const c = vscode.workspace.getConfiguration("graphViewer");
    return {
      physics: c.get<boolean>("physics", true),
      spacing: c.get<number>("spacing", 150),
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
    this.panel.title = `Graph: ${source.label}`;
    this.setupWatcher(source);
    await this.reload();
  }

  /** Re-load the current source and push it to the webview. */
  async reload(): Promise<void> {
    if (!this.source) return;
    try {
      this.graph = await this.source.load();
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

  private onMessage(msg: { type?: string }): void {
    if (msg?.type === "ready") {
      this.webviewReady = true;
      this.post();
    }
  }

  private post(): void {
    if (this.webviewReady && this.graph && this.source) {
      void this.panel.webview.postMessage({
        type: "setGraph",
        graph: this.graph,
        label: this.source.label,
        settings: this.readSettings(),
      });
    }
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
      <input id="search" type="search" placeholder="Search nodes…" autocomplete="off" spellcheck="false" />
      <span id="status"></span>
      <span class="spacer"></span>
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
