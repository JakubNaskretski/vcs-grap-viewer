import * as path from "path";
import { Worker } from "worker_threads";
import * as vscode from "vscode";
import { GROUP_CATALOG } from "./builder/groupCatalog";
import { normalizeGraph } from "./graph/validate";
import { GraphEntry, GraphLibrary, GraphLibraryProvider } from "./library";
import { GraphPanel } from "./panel";
import { FileGraphSource, resolveGraphSource } from "./sources";

export function activate(context: vscode.ExtensionContext): void {
  const library = new GraphLibrary(context);
  const libraryView = new GraphLibraryProvider(library);
  const log = vscode.window.createOutputChannel("Graph Viewer");
  context.subscriptions.push(log);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("graphViewer.library", libraryView),

    // --- open an ad-hoc file (not in the library) ---
    vscode.commands.registerCommand("graphViewer.open", async (uri?: vscode.Uri) => {
      const source = await resolveGraphSource(uri instanceof vscode.Uri ? uri : undefined);
      if (source) await GraphPanel.createOrShow(context, source);
    }),

    vscode.commands.registerCommand("graphViewer.selectFile", async () => {
      const source = await resolveGraphSource(undefined, { forcePick: true });
      if (source) await GraphPanel.createOrShow(context, source);
    }),

    vscode.commands.registerCommand("graphViewer.reload", async () => {
      await GraphPanel.current?.reload();
    }),

    // --- the library (stored in global storage) ---
    vscode.commands.registerCommand("graphViewer.import", async (uri?: vscode.Uri) => {
      const target =
        uri instanceof vscode.Uri
          ? uri
          : (
              await vscode.window.showOpenDialog({
                title: "Import a graph.json into the library",
                canSelectMany: false,
                filters: { "Graph JSON": ["json"], "All files": ["*"] },
                defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
              })
            )?.[0];
      if (!target) return;
      try {
        const entry = await library.importFile(target);
        libraryView.refresh();
        const choice = await vscode.window.showInformationMessage(
          `Imported "${entry.name}" — ${entry.nodeCount} nodes, ${entry.edgeCount} edges.`,
          "Open",
        );
        if (choice === "Open") await openStored(context, library, entry);
      } catch (err) {
        void vscode.window.showErrorMessage(`Graph Viewer: import failed — ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("graphViewer.generate", async (uri?: vscode.Uri) => {
      const folder =
        uri instanceof vscode.Uri
          ? uri
          : (
              await vscode.window.showOpenDialog({
                title: "Select a source folder to build a graph from (e.g. force-app)",
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: "Build graph",
                defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
              })
            )?.[0];
      if (!folder) return;
      const include = await pickSourceTypes(context);
      if (!include) return; // cancelled, or nothing selected
      try {
        const started = Date.now();
        let timings: BuildTimings | undefined;
        const entry = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Building graph from "${path.basename(folder.fsPath)}"…`,
            cancellable: true,
          },
          async (progress, token) => {
            let lastPct = 0;
            const result = await runBuildWorker(context, folder.fsPath, include, token, (p) => {
              if (p.phase === "extract" && p.total > 0) {
                const pct = Math.floor((p.done / p.total) * 100);
                progress.report({
                  message: `extracting ${p.done.toLocaleString()}/${p.total.toLocaleString()} files`,
                  increment: pct - lastPct,
                });
                lastPct = pct;
              } else if (p.phase === "resolve") {
                progress.report({ message: "resolving references…", increment: 100 - lastPct });
                lastPct = 100;
              }
            });
            if (result === undefined) return undefined; // cancelled
            timings = result.timings;
            return library.add(path.basename(folder.fsPath), normalizeGraph(result.graph), folder.fsPath);
          },
        );
        if (!entry) return; // cancelled
        libraryView.refresh();
        const took = fmtDuration(Date.now() - started);
        if (timings) {
          log.appendLine(
            `[build] ${folder.fsPath} — ${entry.nodeCount} nodes, ${entry.edgeCount} edges in ${took} ` +
              `(${timings.files.toLocaleString()} files, ${timings.workers} worker${timings.workers === 1 ? "" : "s"}: ` +
              `walk ${fmtDuration(timings.walkMs)} · extract ${fmtDuration(timings.extractMs)} · resolve ${fmtDuration(timings.resolveMs)})`,
          );
        }
        const choice = await vscode.window.showInformationMessage(
          `Built "${entry.name}" — ${entry.nodeCount.toLocaleString()} nodes, ${entry.edgeCount.toLocaleString()} edges in ${took}.`,
          "Open",
        );
        if (choice === "Open") await openStored(context, library, entry);
      } catch (err) {
        void vscode.window.showErrorMessage(`Graph Viewer: build failed — ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("graphViewer.openStored", async (entry: GraphEntry) => {
      if (entry) await openStored(context, library, entry);
    }),

    vscode.commands.registerCommand("graphViewer.deleteStored", async (entry: GraphEntry) => {
      if (!entry) return;
      const choice = await vscode.window.showWarningMessage(
        `Delete "${entry.name}" from the graph library? This removes only the stored copy.`,
        { modal: true },
        "Delete",
      );
      if (choice !== "Delete") return;
      await library.remove(entry.id);
      libraryView.refresh();
    }),

    vscode.commands.registerCommand("graphViewer.refreshLibrary", () => libraryView.refresh()),
  );
}

async function openStored(
  context: vscode.ExtensionContext,
  library: GraphLibrary,
  entry: GraphEntry,
): Promise<void> {
  await GraphPanel.createOrShow(context, new FileGraphSource(library.pathFor(entry.id), entry.name));
}

interface BuildTimings {
  files: number;
  workers: number;
  walkMs: number;
  extractMs: number;
  resolveMs: number;
}

interface BuildProgress {
  phase: "walk" | "extract" | "resolve";
  done: number;
  total: number;
}

/** Run the graph build in a worker thread (which fans extraction out across its
 *  own worker pool). Resolves the raw graph + phase timings, or `undefined` if
 *  cancelled. Keeps the extension host (and UI) responsive during the build. */
function runBuildWorker(
  context: vscode.ExtensionContext,
  root: string,
  include: string[],
  token: vscode.CancellationToken,
  onProgress?: (p: BuildProgress) => void,
): Promise<{ graph: unknown; timings?: BuildTimings } | undefined> {
  return new Promise((resolve, reject) => {
    const workerPath = vscode.Uri.joinPath(context.extensionUri, "dist", "builder.worker.js").fsPath;
    const worker = new Worker(workerPath);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      void worker.terminate(); // also tears down the coordinator's child workers
      fn();
    };
    token.onCancellationRequested(() => finish(() => resolve(undefined)));
    worker.on(
      "message",
      (msg: { type?: string; ok?: boolean; graph?: unknown; error?: string; timings?: BuildTimings } & Partial<BuildProgress>) => {
        if (msg.type === "progress") {
          if (!settled && msg.phase) onProgress?.({ phase: msg.phase, done: msg.done ?? 0, total: msg.total ?? 0 });
          return;
        }
        finish(() =>
          msg.ok ? resolve({ graph: msg.graph, timings: msg.timings }) : reject(new Error(msg.error ?? "build failed")),
        );
      },
    );
    worker.once("error", (err) => finish(() => reject(err)));
    worker.postMessage({ root, include });
  });
}

/** Multi-select picker for which metadata source types to build nodes from.
 *  Defaults to the last selection (all types on first run). Returns the chosen
 *  catalog keys, or `undefined` if cancelled or nothing was selected. */
async function pickSourceTypes(context: vscode.ExtensionContext): Promise<string[] | undefined> {
  const allKeys = GROUP_CATALOG.map((g) => g.key);
  const last = context.workspaceState.get<string[]>("graphViewer.lastSourceTypes");
  const preselected = new Set(last && last.length ? last : allKeys);
  const items: Array<vscode.QuickPickItem & { key: string }> = GROUP_CATALOG.map((g) => ({
    label: g.label,
    key: g.key,
    picked: preselected.has(g.key),
  }));
  const chosen = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: "Source types to include in the graph",
    placeHolder: "Toggle which metadata types to build nodes from — all on by default",
  });
  if (!chosen) return undefined; // cancelled
  if (chosen.length === 0) {
    void vscode.window.showWarningMessage("Graph Viewer: select at least one source type to build.");
    return undefined;
  }
  const keys = chosen.map((c) => c.key);
  await context.workspaceState.update("graphViewer.lastSourceTypes", keys);
  return keys;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function deactivate(): void {
  // The panel manages its own disposables.
}
