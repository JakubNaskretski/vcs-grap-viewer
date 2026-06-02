# Changelog

## 0.3.0

### Focus a single node

- **Isolate one object/class and its connections.** Click a node and choose
  **Focus on this node**, or type a name in the search box and press **Enter** —
  the map narrows to just that node and its neighborhood. A **depth** control
  (1–3 hops) widens the ring; **clear** restores the full view. The focus composes
  with the type filters, so you can, say, focus one object and still hide its
  fields.
- Search now does two things: typing dims non-matches (quick locate); pressing
  Enter focuses the best match (exact label wins, else the first partial).

## 0.2.0

### Large-graph handling

- **Container map by default.** Graphs above ~2,500 nodes now open at the
  container level: fine-grained nodes (fields, Apex methods, flow elements, record
  types, list views) are rolled up into their parent object/class/flow, and their
  edges are rolled up with them (self-loops dropped, parallels de-duplicated). This
  turns a multi-tens-of-thousands-node hairball into a readable module-level map
  and avoids freezing the editor.
- **"Show all" toggle.** A toolbar button switches between the container map and
  the full graph. On a large graph, expanding to everything asks for confirmation
  first, since rendering it all at once can be slow.
- **Faster rendering at scale.** Large maps use a draft force layout, the cheap
  "haystack" edge renderer (no arrowheads), edges hidden while panning/zooming, and
  fit-to-view on open. Labels only appear once zoomed in.
- The toolbar status now shows the current view (containers / full) and the total
  node count behind a rolled-up map; container nodes note how many members were
  collapsed into them.

## 0.1.0

- Initial release: interactive, filterable graph view for a `graph.json` metadata
  graph — pan/zoom/drag map, type and edge filters, node search, and a detail panel
  with attributes and relationships.
- In-plugin graph generation (TypeScript port of the Salesforce extractors) and a
  Graphs library stored in the extension's private storage.
