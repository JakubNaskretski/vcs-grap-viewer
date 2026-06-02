import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { Graph } from "./graph/types";
import { normalizeGraph } from "./graph/validate";

/** One stored graph's metadata (the library index entry). */
export interface GraphEntry {
  id: string; // unique slug; also the on-disk filename stem
  name: string; // friendly display name
  nodeCount: number;
  edgeCount: number;
  source?: string; // where it came from (imported path / generated source)
  createdAt: number; // epoch ms
}

/**
 * The graph library — persists graphs in the extension's private global storage
 * (`context.globalStorageUri`), which lives outside any workspace. Generated and
 * imported graphs therefore never touch the repo and need no gitignore.
 *
 * Layout: `<globalStorage>/graphs/<id>.json` for each graph, plus a
 * `library.json` index of {@link GraphEntry} records.
 */
export class GraphLibrary {
  private readonly graphsDir: string;
  private readonly indexPath: string;

  constructor(context: vscode.ExtensionContext) {
    const base = context.globalStorageUri.fsPath;
    this.graphsDir = path.join(base, "graphs");
    this.indexPath = path.join(base, "library.json");
  }

  pathFor(id: string): string {
    return path.join(this.graphsDir, `${id}.json`);
  }

  async list(): Promise<GraphEntry[]> {
    try {
      const data = JSON.parse(await fs.readFile(this.indexPath, "utf8"));
      return Array.isArray(data) ? (data as GraphEntry[]) : [];
    } catch {
      return []; // missing/corrupt index → empty library
    }
  }

  /** Save a graph under a friendly name; returns its new index entry. */
  async add(name: string, graph: Graph, source?: string): Promise<GraphEntry> {
    await fs.mkdir(this.graphsDir, { recursive: true });
    const entries = await this.list();
    const entry: GraphEntry = {
      id: this.uniqueId(name, entries),
      name: name || "graph",
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      source,
      createdAt: Date.now(),
    };
    await fs.writeFile(this.pathFor(entry.id), JSON.stringify(toDisk(graph), null, 2), "utf8");
    entries.push(entry);
    await this.writeIndex(entries);
    return entry;
  }

  async remove(id: string): Promise<void> {
    await this.writeIndex((await this.list()).filter((e) => e.id !== id));
    try {
      await fs.unlink(this.pathFor(id));
    } catch {
      /* already gone */
    }
  }

  /** Import an external graph.json file into the library. */
  async importFile(uri: vscode.Uri): Promise<GraphEntry> {
    const graph = normalizeGraph(JSON.parse(await fs.readFile(uri.fsPath, "utf8")));
    const name = path.basename(uri.fsPath).replace(/\.json$/i, "");
    return this.add(name, graph, uri.fsPath);
  }

  private async writeIndex(entries: GraphEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    await fs.writeFile(this.indexPath, JSON.stringify(entries, null, 2), "utf8");
  }

  private uniqueId(name: string, entries: GraphEntry[]): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "graph";
    const taken = new Set(entries.map((e) => e.id));
    let id = slug;
    let i = 2;
    while (taken.has(id)) id = `${slug}-${i++}`;
    return id;
  }
}

function toDisk(graph: Graph) {
  return {
    version: graph.version ?? 1,
    nodes: graph.nodes,
    edges: graph.edges,
    unresolved: graph.unresolved ?? [],
    errors: graph.errors ?? [],
  };
}

/** TreeView backing the "Graphs" side panel — the stored graphs list. Actions
 *  (generate / import / refresh) live as icon buttons in the view's title bar. */
export class GraphLibraryProvider implements vscode.TreeDataProvider<GraphEntry> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly library: GraphLibrary) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(entry: GraphEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
    item.description = `${entry.nodeCount} nodes · ${entry.edgeCount} edges`;
    item.tooltip = entry.source ? `${entry.name}\nfrom ${entry.source}` : entry.name;
    item.contextValue = "graphEntry";
    item.iconPath = new vscode.ThemeIcon("type-hierarchy-sub");
    item.command = { command: "graphViewer.openStored", title: "Open Graph", arguments: [entry] };
    return item;
  }

  async getChildren(element?: GraphEntry): Promise<GraphEntry[]> {
    if (element) return [];
    return (await this.library.list()).sort((a, b) => b.createdAt - a.createdAt);
  }
}
