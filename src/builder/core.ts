// Two-pass build framework — a port of graph-builder's core.py. Pass 1 extracts
// nodes + raw edges; pass 2 resolves each raw edge's (to_kind, to_name) into a
// node id, creating external stubs for off-repo targets. Nothing throws: a bad
// extractor lands in `errors`, an unresolved edge in `unresolved`.
import * as path from "path";
import { RawEdge, RawNode } from "./model";

export interface Extractor {
  source: string;
  handles(filePath: string): boolean;
  extract(filePath: string): [RawNode[], RawEdge[]];
}

export interface Resolver {
  kind: string;
  resolve(name: string, registry: Map<string, RawNode>): string | null;
}

export interface ResolvedEdge {
  src: string;
  dst: string;
  type: string;
  /** Edge attributes (readable, record_type, …) carried over from the raw edge. */
  [key: string]: unknown;
}

export interface BuildResult {
  nodes: RawNode[];
  edges: ResolvedEdge[];
  unresolved: Array<RawEdge & { reason: string }>;
  errors: Array<{ source: string; path: string; error: string }>;
}

/** Pass-1 output for a batch of files — mergeable across parallel workers as long
 *  as batches are merged in file order (first node for an id wins, like pass 1). */
export interface ExtractResult {
  nodes: RawNode[];
  pending: RawEdge[];
  errors: BuildResult["errors"];
}

export class GraphBuilder {
  private extractors: Extractor[] = [];
  private resolvers = new Map<string, Resolver>();

  register(...extractors: Extractor[]): this {
    this.extractors.push(...extractors);
    return this;
  }

  registerResolver(...resolvers: Resolver[]): this {
    for (const r of resolvers) this.resolvers.set(r.kind, r);
    return this;
  }

  build(files: string[]): BuildResult {
    const ex = this.extract(files);
    const registry = new Map<string, RawNode>(ex.nodes.map((n) => [n.id, n]));
    return this.resolve(registry, ex.pending, ex.errors);
  }

  /** Pass 1 only. `onFile` is called after every file (handled or not) — progress. */
  extract(files: string[], onFile?: (done: number) => void): ExtractResult {
    const registry = new Map<string, RawNode>();
    const pending: RawEdge[] = [];
    const errors: BuildResult["errors"] = [];

    let done = 0;
    for (const file of files) {
      const extractor = this.extractors.find((e) => safe(() => e.handles(file), false));
      if (!extractor) {
        onFile?.(++done);
        continue;
      }
      let result: [RawNode[], RawEdge[]];
      try {
        result = extractor.extract(file);
      } catch (err) {
        errors.push({
          source: extractor.source ?? "?",
          path: path.basename(file),
          error: `${(err as Error).name}: ${(err as Error).message}`,
        });
        onFile?.(++done);
        continue;
      }
      const [nodes, edges] = result;
      for (const n of nodes ?? []) {
        if (!registry.has(n.id)) registry.set(n.id, n); // first node for an id wins (setdefault)
      }
      pending.push(...(edges ?? []));
      onFile?.(++done);
    }
    return { nodes: [...registry.values()], pending, errors };
  }

  /** Pass 2 only. Mutates `registry` (external stubs) and consumes `pending`. */
  resolve(registry: Map<string, RawNode>, pending: RawEdge[], errors: BuildResult["errors"]): BuildResult {
    const resolvedEdges: ResolvedEdge[] = [];
    const unresolved: BuildResult["unresolved"] = [];
    for (const edge of pending) {
      const resolver = this.resolvers.get(edge.to_kind);
      if (!resolver) {
        unresolved.push({ ...edge, reason: `no resolver for kind '${edge.to_kind}'` });
        continue;
      }
      let dst: string | null;
      try {
        dst = resolver.resolve(edge.to_name, registry);
      } catch (err) {
        unresolved.push({ ...edge, reason: `resolver error: ${(err as Error).message}` });
        continue;
      }
      if (dst == null) {
        unresolved.push({ ...edge, reason: "unresolved target" });
      } else {
        // Carry extra edge attributes through; drop only the logical-target pair.
        const { to_kind: _tk, to_name: _tn, ...rest } = edge;
        resolvedEdges.push({ ...rest, src: edge.src, dst, type: edge.type });
      }
    }

    // registry now includes stubs added during resolve — mirrors core.py.
    return { nodes: [...registry.values()], edges: resolvedEdges, unresolved, errors };
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
