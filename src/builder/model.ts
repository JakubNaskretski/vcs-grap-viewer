// The shared node/edge vocabulary — a 1:1 port of graph-builder's model.py.
// Output node ids/types/edges must match the Python builder exactly so existing
// graph.json files and the viewer stay compatible.

export const NODE_TYPES: ReadonlySet<string> = new Set([
  "object", "field", "apexclass", "apexmethod", "trigger", "flow", "flowelement",
  "lwc", "flexipage", "permissionset", "profile", "permsetgroup",
  "omniscript", "integrationprocedure", "datamapper", "flexcard",
  "label", "approvalprocess", "sharingrule", "app", "tab", "recordtype",
  "aura", "vfpage", "vfcomponent", "quickaction", "layout",
  "queue", "publicgroup", "role", "emailtemplate", "emailalert", "report",
  "dashboard", "custompermission", "customnotificationtype",
  "assignmentrule", "escalationrule", "duplicaterule", "matchingrule",
  "custommetadatarecord", "globalvalueset", "listview", "platformeventchannel",
  "resource", "messagechannel",
]);

export const EDGE_TYPES: ReadonlySet<string> = new Set([
  "field_of", "lookup", "on", "calls", "references", "touches", "uses",
  "uses-component", "page-for", "embeds", "grants", "contains", "maps",
  "extends", "implements", "invocable", "aura-enabled", "wire",
  "reads", "writes", "subflow", "async", "validates", "formula",
  "tests", "requires",
]);

export interface RawNode {
  id: string;
  type: string;
  label: string;
  [key: string]: unknown;
}

/** A raw edge whose target is named logically as (to_kind, to_name); the concrete
 *  destination id is filled in during the resolve pass. Extra keys (readable,
 *  record_type, …) are edge attributes carried through to the resolved edge —
 *  mirrors graph-builder, where raw_edge() returns a freely-decorated dict. */
export interface RawEdge {
  src: string;
  type: string;
  to_kind: string;
  to_name: string;
  [key: string]: unknown;
}

/** Build a node. Label defaults to the id's name segment (everything after the
 *  first "/"), matching graph-builder's `node()`. */
export function node(id: string, type: string, label?: string, attrs: Record<string, unknown> = {}): RawNode {
  const slash = id.indexOf("/");
  const fallback = slash >= 0 ? id.slice(slash + 1) : id;
  return { id, type, label: label || fallback, ...attrs };
}

export function rawEdge(
  src: string,
  type: string,
  toKind: string,
  toName: string,
  attrs: Record<string, unknown> = {},
): RawEdge {
  return { src, type, to_kind: toKind, to_name: toName, ...attrs };
}
