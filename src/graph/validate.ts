import { Graph, GraphEdge, GraphNode } from "./types";

/**
 * Coerce arbitrary parsed JSON into a well-formed {@link Graph}.
 *
 * Tolerant by design (matching graph-builder's own loader): a bare
 * `{nodes, edges}` is fine, optional keys default to empty, and malformed
 * individual nodes/edges are dropped rather than failing the whole load. Throws
 * only when the input clearly isn't a graph, with a message that points the user
 * back at graph-builder.
 */
export function normalizeGraph(data: unknown): Graph {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error('Not a graph: expected a JSON object with "nodes" and "edges".');
  }
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) {
    throw new Error(
      'Missing "nodes"/"edges" arrays. Produce this file with graph-builder, e.g. `python -m graphbuilder <source> -o graph.json`.',
    );
  }

  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  for (const raw of obj.nodes) {
    if (!raw || typeof raw !== "object") continue;
    const n = raw as Record<string, unknown>;
    const id = typeof n.id === "string" ? n.id : undefined;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const type = typeof n.type === "string" ? n.type : "unknown";
    const label = typeof n.label === "string" && n.label ? n.label : nameOf(id);
    nodes.push({ ...(n as object), id, type, label } as GraphNode);
  }

  const ids = seen;
  const edges: GraphEdge[] = [];
  for (const raw of obj.edges) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const src = typeof e.src === "string" ? e.src : undefined;
    const dst = typeof e.dst === "string" ? e.dst : undefined;
    const type = typeof e.type === "string" ? e.type : "related";
    // Keep only edges whose endpoints both exist — a dangling edge can't be drawn.
    if (!src || !dst || !ids.has(src) || !ids.has(dst)) continue;
    edges.push({ ...(e as object), src, dst, type } as GraphEdge);
  }

  return {
    version: typeof obj.version === "number" ? obj.version : undefined,
    nodes,
    edges,
    unresolved: Array.isArray(obj.unresolved) ? obj.unresolved : [],
    errors: Array.isArray(obj.errors) ? obj.errors : [],
  };
}

function nameOf(id: string): string {
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}
