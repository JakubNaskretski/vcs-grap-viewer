# Changelog

## Unreleased

### Real Apex parsing, and pick what goes into the graph

- **Apex is now parsed from a real syntax tree** (ANTLR `@apexdevtools/apex-parser`)
  instead of regex. Class structure, method/instance calls, SOQL/DML targets, and
  `implements`/generics are read accurately — e.g. a class implementing
  `Database.Batchable<SObject>` is now correctly classified, and field references
  are no longer mistaken for objects. The previous regex parser stays on as an
  automatic fallback for any `.cls` the grammar can't cleanly parse.
- **Choose which source types to build** when generating a graph. A multi-select
  prompt (everything on by default, your last choice remembered) lets you scope the
  graph to just the metadata types you care about — handy for large orgs.

## 0.6.2

- Add a branded extension icon — shown on the Marketplace listing and the activity-bar.

## 0.6.1

### Clearer selection, calmer zoom, and a node "Explore" panel

- **Selecting or hovering a node is readable again.** The highlighted label now sits
  on a dark, theme-matched chip (it used to wash out to white), and the rest of the
  map dims into the background instead of brightening — so the focused node and its
  connections stand out.
- **Gentler mouse-wheel zoom.** Each scroll step is a smaller, calmer change instead
  of a large jump.
- **New "Explore" panel in a node's details.** Select a node and reveal more around it
  a step at a time, with live counts: its **members** (children), its most-connected
  **neighbours**, and the nodes that point into it (**sources**). Reveals are additive
  — they layer onto the current map. This replaces the old depth dropdown and tidies
  the toolbar.

## 0.6.0

### A new rendering engine for much larger graphs

- **The map now renders on the GPU (WebGL).** Graphs that used to slow down or
  freeze the editor — tens of thousands of nodes — now open and pan smoothly,
  drawn on the graphics card instead of the CPU canvas.
- **Everything you already use works the same.** Hover to highlight a node and its
  neighbors, click to select and see its details and connections, the **Layout**
  toggle (force-directed ⟷ grouped islands), type/edge **filters**, **search**,
  and drilling into a container to reveal its members are all unchanged.
- **Labels and colors as before.** Nodes stay sized by connectivity and colored by
  type; names fade in as you zoom and always show for the hovered or selected node.

## 0.5.4

### Group the map by type, and a roomier default layout

- **New "Grouped" layout.** A **Layout** toggle in the toolbar switches between
  the force-directed view and a grouped view that lays each node type out as its
  own labelled, color-coded island. The most-connected nodes sit at each
  island's centre, so a type's key nodes stand out; connections between types
  are drawn as links between the islands.
- **The force layout spreads out more.** Dense views no longer pile up in the
  centre — nodes push apart for a more even, readable map. The **Spacing**
  setting still scales both layouts.

## 0.5.3

### Fix: freeze on opening dense graphs

- **Opening a graph with a densely interconnected core no longer freezes the
  editor.** The default view now bounds how many *edges* it draws, not just
  nodes — the most-connected slice of a big org graph is also its densest, and
  edge volume is what makes layout expensive. Layout quality and label-aware
  spacing now adapt to edge count as well.
- The empty-library welcome message no longer shows duplicated copies after
  rapid refreshes.

## 0.5.2

### Readable maps: real node spacing and smarter labels

- **Every node now gets breathing room.** The layout reserves space for each
  node including its label, with a hard minimum separation between neighbors —
  unrelated nodes sitting next to each other can no longer overlap each other's
  text. The **Spacing** setting default is higher (220) and now applies between
  all neighboring nodes, not just connected ones.
- **Labels appear only when they're readable.** Zoomed out, the map shows
  shapes and colors; names fade in as you zoom, at a larger font with an
  outline that stays legible over edges. Hovering or selecting a node always
  shows its name (and its neighbors') at any zoom level.
- Sharper text while zooming, and a higher-quality force layout on the default
  (capped) view.

## 0.5.1

### Faster builds, safer big-graph rendering, managed-package coverage

- **Graph builds now run in parallel** across worker threads and report live
  progress ("extracting 12,400/53,000 files"), with phase timings in a new
  **Graph Viewer** output channel. Long builds are no longer a silent wait.
- **Huge graphs can't crash the view anymore.** The container overview is capped
  to the most-connected nodes (new `graphViewer.maxRenderNodes` setting, default
  1,500); the status bar shows "top 1,500 of 37,993 by connectivity". Drill-in,
  filters, and the confirmed "Show all" are unchanged.
- **The map always lands zoomed in on the most-connected node** — big maps
  previously fit the entire graph at once, which could freeze or crash the editor.
- **Search reaches the whole graph**: pressing Enter on a name that isn't drawn
  asks the extension host to find it in the full graph and drill in to it.
- **Managed-package components are now mapped.** Namespaced components (e.g.
  `vlocity_cmt:…`) referenced on Lightning pages, in LWC templates, and in Aura
  markup become proper graph nodes instead of being skipped.
- **More accurate extraction:** Big Objects (`__b`) and External Objects (`__x`)
  are classified; flow email-alert actions resolve; Apex methods without an access
  modifier are captured (also removes a pathological-regex slowdown on large
  generated classes); permission grants keep their read/edit, app-visibility, and
  record-type details on the edges; OmniStudio components no longer emit duplicate
  edges.

## 0.5.0

### Expand a container into its members

- In the container map, a rolled-up node now has an **⊕ Expand members** action in
  the detail panel. Expanding **drills in**: the map narrows to that node, its
  members (Apex methods, object fields, flow elements), and the related main nodes
  those members connect to (kept collapsed). Member→member calls and member→neighbor
  edges are drawn, with the far end rolled up to its container.
- **Walk the graph one step at a time.** Each related node can be expanded in turn,
  so you can follow connections class-by-class without ever rendering the whole
  graph. An **exploring · reset** pill returns to the overview; **⊖ Collapse
  members** rolls a node back up.
- New **Max Related Nodes** setting (`graphViewer.maxRelatedNodes`, default `10`)
  controls how many related nodes each expansion reveals; when more are connected,
  the detail panel notes how many were hidden.
- The drill-in is computed in the extension host, which sends only the focused
  slice to the view — so it stays fast on large graphs.

## 0.4.0

### Drill into a type and pick individual nodes

- The **node-type filters are now an expandable tree**. Click a type (e.g. *Apex
  class* or *Object*) to expand it into a searchable list of its own nodes — built
  for types with thousands of members: the list renders a capped window and a
  **per-type search** narrows it by name.
- **Tick individual nodes** to choose exactly what shows, so you can isolate a few
  classes/objects and see how they relate. Per-type **all / none** shortcuts make
  "show none, then pick three" practical; the section-wide all/none still works.
- Clicking a node's name in the list shows it and jumps the map to it.
- Selecting/searching composes with everything else (type toggles, focus, the
  container/full view).

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
