// Port of graph-builder's extractors/lwc.py. LWC node + calls/uses-component/
// aura-enabled/wire/uses edges from the bundle's main module and templates.
import * as fs from "fs";
import * as path from "path";
import { Extractor } from "../core";
import { node, rawEdge, RawEdge, RawNode } from "../model";
import { parseLwc } from "../salesforce";

const APEX_METHOD = /['"]@salesforce\/apex\/(\w+)\.(\w+)['"]/g;
const SCHEMA = /['"]@salesforce\/schema\/([\w.$]+)['"]/g;
const LABEL = /['"]@salesforce\/label\/([\w.$]+)['"]/g;
const RESOURCE = /['"]@salesforce\/resourceUrl\/([\w.$]+)['"]/g;
const MESSAGE_CHANNEL = /['"]@salesforce\/messageChannel\/([\w.$]+)['"]/g;
const APEX_IMPORT_BINDING = /import\s+(\w+)\s+from\s+['"]@salesforce\/apex\/(\w+)\.(\w+)['"]/g;
const WIRE_ADAPTER = /@wire\s*\(\s*(\w+)/g;
const CUSTOM_ELEMENT = /<c-([a-z0-9]+(?:-[a-z0-9]+)*)\b/g;
// Managed-package component tag: <ns-comp-name> where ns is the package namespace
// (may contain underscores, e.g. vlocity_cmt). Platform namespaces are skipped;
// the local `c` namespace is handled by CUSTOM_ELEMENT above.
const NAMESPACED_ELEMENT = /<([a-z][a-z0-9_]*)-([a-z0-9_]+(?:-[a-z0-9_]+)*)\b/g;
const BUILTIN_TAG_NS = new Set([
  "c", "lightning", "lwc", "aura", "ui", "force", "forcechatter", "forcecommunity",
  "ltng", "laf", "lightningsnapin", "site", "clients",
]);

function kebabToCamel(tag: string): string {
  const parts = tag.split("-").filter(Boolean);
  if (!parts.length) return "";
  return parts[0] + parts.slice(1).map((p) => p.slice(0, 1).toUpperCase() + p.slice(1)).join("");
}

class LwcExtractor implements Extractor {
  source = "salesforce";

  handles(filePath: string): boolean {
    try {
      if (!filePath.endsWith(".js")) return false;
      const stem = path.basename(filePath, ".js");
      const parent = path.basename(path.dirname(filePath));
      const grand = path.basename(path.dirname(path.dirname(filePath)));
      return stem === parent && grand === "lwc";
    } catch {
      return false;
    }
  }

  extract(filePath: string): [RawNode[], RawEdge[]] {
    const bundleDir = path.dirname(filePath);
    const bundle = parseLwc(bundleDir);
    const lid = `lwc/${bundle.name}`;
    const nodes: RawNode[] = [node(lid, "lwc", bundle.name)];
    const edges: RawEdge[] = [];

    for (const cls of [...bundle.classRefs].sort()) {
      if (cls) edges.push(rawEdge(lid, "calls", "apexclass", cls));
    }
    const composed = new Set<string>(bundle.lwcRefs);
    for (const c of this.templateComponents(bundleDir, bundle.name)) composed.add(c);
    for (const comp of [...composed].sort()) {
      if (comp) edges.push(rawEdge(lid, "uses-component", "lwc", comp));
    }

    const src = bundle.source || "";

    const apexBindings = new Map<string, string>();
    for (const m of src.matchAll(APEX_IMPORT_BINDING)) {
      if (m[1] && m[2] && m[3]) apexBindings.set(m[1], `${m[2]}.${m[3]}`);
    }

    for (const m of src.matchAll(APEX_METHOD)) {
      if (m[1] && m[2]) edges.push(rawEdge(lid, "aura-enabled", "apexmethod", `${m[1]}.${m[2]}`));
    }

    for (const m of src.matchAll(WIRE_ADAPTER)) {
      const target = apexBindings.get(m[1]);
      if (target) edges.push(rawEdge(lid, "wire", "apexmethod", target));
    }

    for (const m of src.matchAll(SCHEMA)) {
      const ref = m[1];
      const dot = ref.indexOf(".");
      const obj = dot >= 0 ? ref.slice(0, dot) : ref;
      const fld = dot >= 0 ? ref.slice(dot + 1) : "";
      if (!obj) continue;
      if (fld) edges.push(rawEdge(lid, "wire", "field", `${obj}.${fld}`));
      else edges.push(rawEdge(lid, "wire", "object", obj));
    }

    for (const m of src.matchAll(LABEL)) if (m[1]) edges.push(rawEdge(lid, "uses", "label", m[1]));
    for (const m of src.matchAll(RESOURCE)) if (m[1]) edges.push(rawEdge(lid, "uses", "resource", m[1]));
    for (const m of src.matchAll(MESSAGE_CHANNEL)) if (m[1]) edges.push(rawEdge(lid, "uses", "messagechannel", m[1]));

    return [nodes, edges];
  }

  private templateComponents(bundleDir: string, selfName: string): Set<string> {
    const found = new Set<string>();
    let templates: string[];
    try {
      templates = fs.readdirSync(bundleDir).filter((n) => n.endsWith(".html")).sort();
    } catch {
      return found;
    }
    for (const tpl of templates) {
      let html: string;
      try {
        html = fs.readFileSync(path.join(bundleDir, tpl), "utf8");
      } catch {
        continue;
      }
      for (const m of html.matchAll(CUSTOM_ELEMENT)) {
        const name = kebabToCamel(m[1]);
        if (name && name !== selfName) found.add(name);
      }
      // Managed-package children keep their namespace: <vlocity_cmt-card-frame>
      // -> vlocity_cmt__cardFrame (matching how flows reference namespaced LWC).
      for (const m of html.matchAll(NAMESPACED_ELEMENT)) {
        const ns = m[1];
        if (BUILTIN_TAG_NS.has(ns)) continue;
        const name = kebabToCamel(m[2]);
        if (name) found.add(`${ns}__${name}`);
      }
    }
    return found;
  }
}

export const LWC_EXTRACTORS: Extractor[] = [new LwcExtractor()];
