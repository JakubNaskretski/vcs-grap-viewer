// The on-disk contract emitted by graph-builder. Mirrors its persistence format:
//   { version, nodes[], edges[], unresolved[], errors[] }
// Kept deliberately permissive — node attrs vary by type, so anything beyond the
// core fields is carried through untyped and surfaced generically in the detail panel.

export interface GraphNode {
  /** "<type>/<name>", e.g. "object/Account" or "apexmethod/Foo.bar". */
  id: string;
  type: string;
  label: string;
  /** True for stubs referenced but not present in the source repo. */
  external?: boolean;
  /** Type-specific attributes (field_type, process_type, annotations, …). */
  [key: string]: unknown;
}

export interface GraphEdge {
  /** Source node id. Direction is "src depends on dst". */
  src: string;
  dst: string;
  type: string;
  /** Edge attributes (readable, record_type, …) — surfaced in the detail panel. */
  [key: string]: unknown;
}

export interface Graph {
  version?: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved?: unknown[];
  errors?: unknown[];
}
