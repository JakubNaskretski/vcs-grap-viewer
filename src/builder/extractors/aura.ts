// Port of graph-builder's extractors/aura.py. Aura bundle node; uses-component ->
// aura; calls -> apexclass; references -> object. Names/structure only.
import * as fs from "fs";
import * as path from "path";
import { Extractor } from "../core";
import { node, rawEdge, RawEdge, RawNode } from "../model";
import { readText } from "../salesforce";

const MARKUP_EXTS = new Set([".cmp", ".app", ".evt"]);
const CUSTOM_TAG = /<c:([A-Za-z_]\w*)\b/g;
const CREATE_COMPONENT = /createComponent\s*\(\s*['"]c:([A-Za-z_]\w*)['"]/g;
const CONTROLLER_ATTR = /\bcontroller\s*=\s*['"]([\w.]+)['"]/g;
const DEPENDENCY_TAG = /<aura:dependency\b[^>]*>/g;
const RESOURCE_ATTR = /\bresource\s*=\s*['"]([^'"]+)['"]/g;
const RECORD_DATA_TAG = /<force:recordData\b[^>]*>/g;
const OBJECT_ATTR = /\b(?:targetObject|sobjectType|recordObject|object|entityName)\s*=\s*['"]([\w.]+)['"]/g;
const APEX_URI = /apex:\/\/([\w.]+)/g;

function looksLikeObject(name: string): boolean {
  if (!name) return false;
  // Any custom suffix, not just __c: managed-package __e/__mdt/__x/__b objects have
  // a lowercase namespace prefix that fails the capitalization fallback below.
  if (/__(c|e|mdt|x|b)$/i.test(name)) return true;
  return name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();
}

function objectFromResource(res: string): string {
  if (!res) return "";
  let tail = res.includes("://") ? (res.split("://").pop() as string) : res;
  if (tail.includes(":")) tail = tail.split(":").pop() as string;
  if (tail.includes(".")) tail = tail.split(".").pop() as string;
  return tail.trim();
}

class AuraExtractor implements Extractor {
  source = "salesforce";

  handles(filePath: string): boolean {
    try {
      const ext = path.extname(filePath);
      if (!MARKUP_EXTS.has(ext)) return false;
      const stem = path.basename(filePath, ext);
      const parent = path.basename(path.dirname(filePath));
      const grand = path.basename(path.dirname(path.dirname(filePath)));
      return stem === parent && grand === "aura";
    } catch {
      return false;
    }
  }

  extract(filePath: string): [RawNode[], RawEdge[]] {
    const name = path.basename(filePath, path.extname(filePath));
    const aid = `aura/${name}`;
    const nodes: RawNode[] = [node(aid, "aura", name)];
    const edges: RawEdge[] = [];

    const markup = readText(filePath);
    const jsSrc = this.bundleJs(path.dirname(filePath), name);

    const children = new Set<string>();
    for (const m of markup.matchAll(CUSTOM_TAG)) if (m[1] && m[1] !== name) children.add(m[1]);
    for (const m of jsSrc.matchAll(CREATE_COMPONENT)) if (m[1] && m[1] !== name) children.add(m[1]);
    for (const c of [...children].sort()) edges.push(rawEdge(aid, "uses-component", "aura", c));

    const classes = new Set<string>();
    for (const m of markup.matchAll(CONTROLLER_ATTR)) {
      const seg = m[1].split(".").pop() as string;
      if (seg) classes.add(seg);
    }
    for (const m of jsSrc.matchAll(APEX_URI)) {
      const seg = m[1].split(".").pop() as string;
      if (seg) classes.add(seg);
    }
    for (const c of [...classes].sort()) edges.push(rawEdge(aid, "calls", "apexclass", c));

    const objects = new Set<string>();
    for (const m of markup.matchAll(RECORD_DATA_TAG)) {
      for (const om of m[0].matchAll(OBJECT_ATTR)) {
        const seg = om[1].split(".")[0];
        if (looksLikeObject(seg)) objects.add(seg);
      }
    }
    for (const m of markup.matchAll(DEPENDENCY_TAG)) {
      for (const rm of m[0].matchAll(RESOURCE_ATTR)) {
        const obj = objectFromResource(rm[1]);
        if (obj && looksLikeObject(obj)) objects.add(obj);
      }
    }
    for (const o of [...objects].sort()) edges.push(rawEdge(aid, "references", "object", o));

    return [nodes, edges];
  }

  private bundleJs(bundleDir: string, name: string): string {
    const out: string[] = [];
    for (const suffix of ["Controller.js", "Helper.js"]) {
      const p = path.join(bundleDir, `${name}${suffix}`);
      try {
        if (fs.statSync(p).isFile()) out.push(readText(p));
      } catch {
        /* missing */
      }
    }
    return out.join("\n");
  }
}

export const AURA_EXTRACTORS: Extractor[] = [new AuraExtractor()];
