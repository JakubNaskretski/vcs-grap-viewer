// Off-main-thread graph build, parallel across worker threads.
//
// The extension spawns ONE instance of this bundle (the coordinator). It walks
// the tree, splits the sorted file list into contiguous chunks, and runs pass 1
// (extract) on up to MAX_WORKERS child instances of this same bundle
// (workerData.role === "extract"). Chunk results are merged IN CHUNK ORDER —
// contiguous chunks of a sorted list make that byte-identical to a sequential
// build (first node for an id wins either way). Pass 2 (resolve) is a fast
// single pass in the coordinator. Progress + phase timings stream up to the
// extension. If child workers can't spawn, the build silently degrades to the
// old sequential path.
import * as os from "os";
import { Worker, parentPort, workerData } from "worker_threads";
import { ExtractResult } from "./core";
import { makeBuilder, walkFiles } from "./index";
import { RawEdge, RawNode } from "./model";

// Keep a core free for the extension host; never flood the machine.
const MAX_WORKERS = Math.min(4, Math.max(1, os.cpus().length - 1));
// Below this many files the thread spin-up costs more than it saves.
const PARALLEL_THRESHOLD = 2000;
const PROGRESS_EVERY = 250;

interface ProgressMsg {
  type: "progress";
  phase: "walk" | "extract" | "resolve";
  done: number;
  total: number;
}

/** Coordinator request: a root to build, plus the optional source-type filter. */
interface BuildRequest {
  root: string;
  include?: string[];
}

// ---- extract child: pass 1 over one chunk ----------------------------------
if (workerData?.role === "extract") {
  const include = (workerData?.include as string[] | undefined) ?? undefined;
  parentPort?.on("message", (files: string[]) => {
    try {
      let lastSent = 0;
      const result = makeBuilder({ include }).extract(files, (done) => {
        if (done - lastSent >= PROGRESS_EVERY || done === files.length) {
          lastSent = done;
          parentPort?.postMessage({ type: "progress", done });
        }
      });
      parentPort?.postMessage({ type: "done", result });
    } catch (err) {
      parentPort?.postMessage({ type: "error", error: (err as Error).message });
    }
  });
}

// ---- coordinator: walk -> parallel extract -> resolve -----------------------
else {
  parentPort?.on("message", (req: BuildRequest | string) => {
    // Back-compat: a bare string is still accepted as the root (no type filter).
    const { root, include } = typeof req === "string" ? { root: req, include: undefined } : req;
    void coordinate(root, include);
  });
}

async function coordinate(root: string, include?: string[]): Promise<void> {
  try {
    const t0 = Date.now();
    const files = walkFiles(root);
    const tWalk = Date.now();
    progress({ type: "progress", phase: "extract", done: 0, total: files.length });

    const chunks = await extractAll(files, include);
    const tExtract = Date.now();
    progress({ type: "progress", phase: "resolve", done: 0, total: 0 });

    // Merge in chunk order: identical to one sequential pass over `files`.
    const registry = new Map<string, RawNode>();
    const pending: RawEdge[] = [];
    const errors: ExtractResult["errors"] = [];
    for (const chunk of chunks) {
      for (const n of chunk.nodes) if (!registry.has(n.id)) registry.set(n.id, n);
      pending.push(...chunk.pending);
      errors.push(...chunk.errors);
    }
    const graph = makeBuilder({ include }).resolve(registry, pending, errors);
    const tResolve = Date.now();

    parentPort?.postMessage({
      ok: true,
      graph,
      timings: {
        files: files.length,
        workers: files.length >= PARALLEL_THRESHOLD ? MAX_WORKERS : 1,
        walkMs: tWalk - t0,
        extractMs: tExtract - tWalk,
        resolveMs: tResolve - tExtract,
      },
    });
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: (err as Error).message });
  }
}

/** Pass 1 over all files: parallel when it pays off, sequential otherwise. */
async function extractAll(files: string[], include?: string[]): Promise<ExtractResult[]> {
  if (files.length >= PARALLEL_THRESHOLD && MAX_WORKERS > 1) {
    try {
      return await extractParallel(files, include);
    } catch {
      // worker spin-up failed (restricted env?) — fall through to sequential
    }
  }
  let lastSent = 0;
  return [
    makeBuilder({ include }).extract(files, (done) => {
      if (done - lastSent >= PROGRESS_EVERY || done === files.length) {
        lastSent = done;
        progress({ type: "progress", phase: "extract", done, total: files.length });
      }
    }),
  ];
}

function extractParallel(files: string[], include?: string[]): Promise<ExtractResult[]> {
  const chunkSize = Math.ceil(files.length / MAX_WORKERS);
  const chunks: string[][] = [];
  for (let i = 0; i < files.length; i += chunkSize) chunks.push(files.slice(i, i + chunkSize));

  const doneByChunk = new Array<number>(chunks.length).fill(0);
  const report = () =>
    progress({
      type: "progress",
      phase: "extract",
      done: doneByChunk.reduce((a, b) => a + b, 0),
      total: files.length,
    });

  return Promise.all(
    chunks.map(
      (chunk, i) =>
        new Promise<ExtractResult>((resolve, reject) => {
          const child = new Worker(__filename, { workerData: { role: "extract", include } });
          child.on("message", (msg: { type: string; done?: number; result?: ExtractResult; error?: string }) => {
            if (msg.type === "progress") {
              doneByChunk[i] = msg.done ?? 0;
              report();
            } else if (msg.type === "done" && msg.result) {
              void child.terminate();
              resolve(msg.result);
            } else if (msg.type === "error") {
              void child.terminate();
              reject(new Error(msg.error ?? "extract worker failed"));
            }
          });
          child.once("error", reject);
          child.postMessage(chunk);
        }),
    ),
  );
}

function progress(msg: ProgressMsg): void {
  parentPort?.postMessage(msg);
}
