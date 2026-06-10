// Per-unit parsers ported from graph-builder's salesforce.py — the validated
// base layer each extractor builds on. Regex for Apex/JS, fast-xml-parser for XML.
import * as fs from "fs";
import * as path from "path";
import { child, iterElements, iterText, parseXmlFile, text } from "./xml";

export function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/** Blank out block + line comments so identifier scans don't trip over them. */
export function stripApex(src: string): string {
  src = src.replace(/\/\*[\s\S]*?\*\//g, " "); // block comments
  src = src.replace(/\/\/[^\n]*/g, " "); // line comments
  return src;
}

// ---- triggers ----
export interface SFTrigger {
  name: string;
  sobject: string;
  events: string;
  classRefs: Set<string>;
  source: string;
}

export function parseTrigger(filePath: string): SFTrigger {
  const raw = readText(filePath);
  const s = stripApex(raw);
  const m = s.match(/\btrigger\s+(\w+)\s+on\s+(\w+)\s*\(([^)]*)\)/);
  const stem = path.basename(filePath).replace(/\.trigger$/i, "");
  return {
    name: m ? m[1] : stem,
    sobject: m ? m[2] : "",
    events: m ? m[3].split(/\s+/).filter(Boolean).join(" ") : "",
    classRefs: new Set(),
    source: raw,
  };
}

// ---- flows ----
export interface SFFlow {
  name: string;
  processType: string;
  objects: Set<string>;
  classRefs: Set<string>;
  triggerObject: string;
}

export function parseFlow(filePath: string): SFFlow {
  const name = path.basename(filePath).replace(/\.flow-meta\.xml$/i, "");
  const flow: SFFlow = { name, processType: "", objects: new Set(), classRefs: new Set(), triggerObject: "" };
  const root = parseXmlFile(filePath);
  if (!root) return flow;
  flow.processType = text(root, "processType");
  for (const o of iterText(root, "object")) flow.objects.add(o);
  const start = child(root, "start");
  if (start) flow.triggerObject = text(start, "object");
  for (const ac of iterElements(root, "actionCalls")) {
    if (text(ac, "actionType") === "apex") {
      const cls = text(ac, "actionName");
      if (cls) flow.classRefs.add(cls);
    }
  }
  return flow;
}

// ---- lwc ----
export interface SFLwc {
  name: string;
  classRefs: Set<string>;
  lwcRefs: Set<string>;
  source: string;
}

const APEX_IMPORT = /@salesforce\/apex\/(\w+)\.\w+/g;
const LWC_IMPORT = /from\s+['"]c\/(\w+)['"]/g;

export function parseLwc(bundleDir: string): SFLwc {
  const name = path.basename(bundleDir);
  const src = readText(path.join(bundleDir, `${name}.js`));
  const classRefs = new Set<string>();
  for (const m of src.matchAll(APEX_IMPORT)) classRefs.add(m[1]);
  const lwcRefs = new Set<string>();
  for (const m of src.matchAll(LWC_IMPORT)) lwcRefs.add(m[1]);
  lwcRefs.delete(name);
  return { name, classRefs, lwcRefs, source: src };
}

// ---- permission sets / profiles / groups ----
export interface SFAccess {
  name: string;
  kind: string;
  label: string;
  objects: Set<string>;
  fields: Set<string>;
  classes: Set<string>;
}

export function parseAccess(filePath: string, kind: string): SFAccess {
  const name = path.basename(filePath).replace(new RegExp(`\\.${kind}-meta\\.xml$`, "i"), "");
  const acc: SFAccess = { name, kind, label: name, objects: new Set(), fields: new Set(), classes: new Set() };
  const root = parseXmlFile(filePath);
  if (!root) return acc;
  acc.label = text(root, "label") || name;
  for (const op of iterElements(root, "objectPermissions")) {
    const o = text(op, "object");
    if (o) acc.objects.add(o);
  }
  for (const fp of iterElements(root, "fieldPermissions")) {
    const f = text(fp, "field");
    if (f) acc.fields.add(f);
  }
  for (const ca of iterElements(root, "classAccesses")) {
    const c = text(ca, "apexClass");
    if (c) acc.classes.add(c);
  }
  return acc;
}

export interface SFPermSetGroup {
  name: string;
  label: string;
  permsets: Set<string>;
}

export function parsePermsetGroup(filePath: string): SFPermSetGroup {
  const name = path.basename(filePath).replace(/\.permissionsetgroup-meta\.xml$/i, "");
  const psg: SFPermSetGroup = { name, label: name, permsets: new Set() };
  const root = parseXmlFile(filePath);
  if (!root) return psg;
  psg.label = text(root, "label") || name;
  for (const ps of iterText(root, "permissionSets")) psg.permsets.add(ps);
  return psg;
}

// ---- flexipages ----
export interface SFFlexiPage {
  name: string;
  sobject: string;
  lwcRefs: Set<string>;
}

// Platform component namespaces on flexipages — never custom/managed components.
const FLEXIPAGE_BUILTIN_NS = new Set([
  "flexipage", "force", "forcecommunity", "forceknowledge", "lightning",
  "lightningcommunity", "lightningsnapin", "native", "interop", "aura", "ui",
  "siteforce", "sfa", "wave", "cms",
]);

export function parseFlexipage(filePath: string): SFFlexiPage {
  const name = path.basename(filePath).replace(/\.flexipage-meta\.xml$/i, "");
  const fp: SFFlexiPage = { name, sobject: "", lwcRefs: new Set() };
  const root = parseXmlFile(filePath);
  if (!root) return fp;
  fp.sobject = text(root, "sobjectType");
  for (const c of iterText(root, "componentName")) {
    const colon = c.indexOf(":");
    if (colon <= 0) continue;
    const ns = c.slice(0, colon).toLowerCase();
    const comp = c.slice(colon + 1);
    if (!comp) continue;
    // custom LWC/Aura are referenced as "c:componentName"; managed-package
    // components as "ns:componentName" -> keep the namespace as ns__componentName.
    if (ns === "c") fp.lwcRefs.add(comp);
    else if (!FLEXIPAGE_BUILTIN_NS.has(ns) && !ns.startsWith("runtime_")) fp.lwcRefs.add(`${ns}__${comp}`);
  }
  return fp;
}
