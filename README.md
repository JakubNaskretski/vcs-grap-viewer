# Graph Viewer

An Obsidian-style **graph view inside your editor**. Point it at a `graph.json`
metadata graph (nodes + edges) and explore it as an interactive, filterable map —
click any node to read its attributes and relationships.

## What it shows

- **Graph map** — a force-directed layout you can pan, zoom, and drag. Nodes are
  sized by how connected they are and colored by type. The layout settles, then the
  nodes keep a gentle Obsidian-style drift; hovering highlights a node and its
  neighbors (and dims the rest) without disturbing the layout.
- **Scales to large graphs** — graphs above ~2,500 nodes open as a **container map**:
  fine-grained nodes (fields, Apex methods, flow elements, record types, list views)
  roll up into their parent object/class/flow, edges and all, so you get a readable
  module-level view instead of a frozen hairball. A **Show all** toggle in the
  toolbar expands to every node (behind a confirmation, since it can be heavy).
- **Filters** — toggle node types and edge types on/off to focus the map; search
  nodes by name. Work in either the container map or the full graph.
- **Focus a single node** — click a node and hit **Focus on this node** (or type its
  name in the search box and press **Enter**) to narrow the map to just that node and
  its neighborhood. A depth control (1–3 hops) widens the ring; **clear** restores the
  full view — for when you want *just this one object/class and what it touches*.
- **Node details** — click a node to see its attributes plus every incoming and
  outgoing relationship, grouped by edge type. Click a related node to jump to it.
- **Graphs side panel** — a library of your graphs in the Activity Bar. Generate,
  import, open, and delete from there. Graphs are kept in the extension's private
  storage, so they never land in your repo.

## Getting a graph

Two ways:

1. **Generate it in-plugin** (no external tooling). Open the **Graphs** view in the
   Activity Bar → **Generate from folder…**, or right-click a source folder in the
   Explorer → **Generate Graph from Folder**. The built-in builder parses a
   Salesforce `force-app` into the graph and stores it in your library.
2. **Import an existing `graph.json`** produced by **graph-builder**
   (`python -m graphbuilder path/to/source -o graph.json`) via the **Graphs** view
   → **Import**, or open one ad-hoc with **Graph Viewer: Open**.

The graph is plain JSON; any tool that emits the same shape works:

```jsonc
{
  "nodes": [{ "id": "object/Account", "type": "object", "label": "Account" }],
  "edges": [{ "src": "field/Account.Name", "dst": "object/Account", "type": "field_of" }]
}
```

## Usage

- **Graphs view** (Activity Bar) → **Generate from folder…** to build one, or
  **Import** an existing `graph.json`. Click a graph in the list to open the map.
- Or **Graph Viewer: Open** from the Command Palette to open a `graph.json`
  ad-hoc (its path is remembered in `graphViewer.graphPath`). The view reloads
  automatically when that file changes (`graphViewer.reloadOnChange`).

## Settings

| Setting                       | Default | Description                                             |
| ----------------------------- | ------- | ------------------------------------------------------- |
| `graphViewer.graphPath`       | `""`    | Path to the graph file. Relative paths resolve against the workspace. |
| `graphViewer.reloadOnChange`  | `true`  | Reload the view when the graph file changes on disk.    |
| `graphViewer.physics`         | `true`  | Gentle Obsidian-style drift after the layout settles. Auto-disables on large graphs (see Motion Max Nodes). Off = fully static. |
| `graphViewer.spacing`         | `150`   | Spacing between nodes (20–500). Higher spreads the graph out more. |
| `graphViewer.animateOnHover`  | `true`  | On hover, dim the rest of the graph and enlarge + highlight the node and its neighbors. |
| `graphViewer.motionMaxNodes`  | `800`   | Above this node count the gentle drift turns off so large graphs stay responsive. |

Appearance settings apply live — no reload needed.

## Development

```sh
npm install
npm run watch     # bundle extension + webview, rebuild on change
```

Press <kbd>F5</kbd> to launch an Extension Development Host, then open the
**Graphs** view and generate or import a graph.

The in-plugin builder is a TypeScript port of graph-builder's Salesforce
extractors, so generating a graph needs no Python. It covers objects, fields,
Apex, triggers, flows, LWC, Aura, Visualforce, OmniStudio, permission
sets/profiles, layouts, reports, rules, and more. (Apex uses a regex parser with
a lightweight per-method symbol table for `var.method()` resolution; deep
instance-call resolution is still lighter than graph-builder's optional
tree-sitter backend.)

## License

[MIT](LICENSE)
