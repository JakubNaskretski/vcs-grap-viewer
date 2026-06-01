// Apex class extractor — a clean regex port of graph-builder's apex.py regex
// backend (the guaranteed-available baseline; the optional tree-sitter backend is
// intentionally not reproduced). Emits: apexclass + apexmethod nodes, contains,
// calls, references, extends/implements, async, per-method reads/writes, and
// label uses. Best-effort throughout — odd input is skipped, never thrown.
import * as path from "path";
import { Extractor } from "../core";
import { node, rawEdge, RawEdge, RawNode } from "../model";
import { readText, stripApex } from "../salesforce";

const METHOD_RE =
  /(?<modifiers>(?:(?:public|private|protected|global|static|virtual|abstract|override|final|webservice|testmethod)\s+)+)(?<ret>[\w.<>,[\]\s]+?)\s+(?<name>\w+)\s*\((?<params>[^)]*)\)\s*(?<body>\{|;)/gi;

const NOT_METHODS = new Set([
  "if", "for", "while", "switch", "catch", "return", "new", "else", "do",
  "try", "finally", "throw", "synchronized", "super", "this",
]);

const KEEP_ANNS = new Set([
  "invocablemethod", "auraenabled", "future", "testsetup", "testvisible",
  "remoteaction", "readonly", "httpget", "httppost", "httpput", "httpdelete",
  "httppatch", "namespaceaccessible",
]);

const ASYNC_IFACES: Record<string, string> = {
  "Database.Batchable": "batchable",
  Batchable: "batchable",
  Queueable: "queueable",
  Schedulable: "schedulable",
};

function asyncIfaceName(kind: string): string {
  return (
    { batchable: "Database.Batchable", queueable: "Queueable", schedulable: "Schedulable", future: "System.Future" }[
      kind
    ] ?? kind
  );
}

function stripStringLiterals(t: string): string {
  return t.replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
}

function annotationsBefore(src: string, start: number): Set<string> {
  const head = src.slice(0, start);
  const boundary = Math.max(head.lastIndexOf(";"), head.lastIndexOf("{"), head.lastIndexOf("}"));
  const segment = head.slice(boundary + 1);
  const out = new Set<string>();
  for (const m of segment.matchAll(/@(\w+)/g)) out.add(m[1].toLowerCase());
  return out;
}

function balancedBody(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return src.slice(openIdx + 1);
}

/** extends/implements via the generic-safe header parse (handles `Foo<Bar>`). */
function parseHeader(src: string): { extends_: string; implements_: string[] } {
  const m = src.match(/\bclass\s+\w+\s*((?:extends\s+[\w.<>,\s]+?|implements\s+[\w.<>,\s]+?)*)\s*\{/i);
  const rest = m ? m[1] : "";
  const em = rest.match(/\bextends\s+([\w.]+)/i);
  const extendsName = em ? em[1] : "";
  const impls: string[] = [];
  const im = rest.match(/\bimplements\s+([\w.<>,\s]+?)(?=\bextends\b|\{|$)/i);
  if (im) {
    for (const raw of im[1].split(",")) {
      const base = raw.replace(/<.*?>/g, "").trim();
      if (base) impls.push(base);
    }
  }
  return { extends_: extendsName, implements_: impls };
}

function dmlTargets(body: string): Set<string> {
  const targets = new Set<string>();
  for (const m of body.matchAll(/\b(?:insert|update|delete|upsert|undelete)\b/gi)) {
    const stmt = body.slice((m.index ?? 0) + m[0].length).split(";")[0];
    for (const mm of stmt.matchAll(/\b(\w+__c)\b/g)) targets.add(mm[1]);
    const mnew = stmt.match(/\bnew\s+(?:List<)?([A-Z]\w*)\b/);
    if (mnew && !["List", "Map", "Set"].includes(mnew[1])) targets.add(mnew[1]);
  }
  return targets;
}

// ---- AST-lite: a per-method variable->type table, built with targeted regex,
// so `var.method()` can resolve to its declared type. Not a real parser (no
// scoping, no inference of `var x = foo()`), but recovers most of what the
// tree-sitter backend gets for free.
const COLLECTION_WRAPPERS = new Set(["list", "set", "map", "iterable"]);
const DECL_RE =
  /\b(?:List|Set|Map)\s*<\s*(?:[A-Za-z]\w*\s*,\s*)?([A-Za-z]\w*)\s*>\s*(\w+)|\b([A-Z]\w*__(?:c|mdt))\s+(\w+)|\b([A-Z]\w*)\s+(\w+)\s*[=;]/gi;
const SOQL_BRACKET_RE = /\[\s*(SELECT\b[\s\S]*?)\]/gi;
const SOQL_SELECT_RE = /\bSELECT\b([\s\S]*?)\bFROM\s+(\w+)/i;
const DATABASE_DML_RE = /\bDatabase\s*\.\s*(?:insert|update|delete|upsert|undelete)\s*\(/gi;
const DYNAMIC_SOQL_RE = /\bDatabase\s*\.\s*(?:query|getQueryLocator|countQuery)\s*\(/gi;
const STRING_LIT_RE = /'(?:[^'\\]|\\.|'')*'/;
const CALLSITE_ASYNC: Array<[RegExp, string]> = [
  [/\bSystem\s*\.\s*enqueueJob\s*\(/gi, "queueable"],
  [/\bDatabase\s*\.\s*executeBatch\s*\(/gi, "batchable"],
  [/\bSystem\s*\.\s*schedule\s*\(/gi, "schedulable"],
];

function isSobjectType(t: string): boolean {
  const lower = t.toLowerCase();
  return !COLLECTION_WRAPPERS.has(lower) && lower !== "id";
}

function localTypeMap(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(DECL_RE)) {
    let typ: string | undefined;
    let varName: string | undefined;
    if (m[1] && m[2]) [typ, varName] = [m[1], m[2]];
    else if (m[3] && m[4]) [typ, varName] = [m[3], m[4]];
    else if (m[5] && m[6]) [typ, varName] = [m[5], m[6]];
    if (!typ || !varName || !isSobjectType(typ)) continue;
    if (!(varName in out)) out[varName] = typ;
  }
  return out;
}

function paramTypes(params: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of params.split(",")) {
    const p = raw.trim().replace(/^final\s+/i, "");
    if (!p) continue;
    let m = p.match(/^(?:List|Set|Map)\s*<\s*(?:[A-Za-z]\w*\s*,\s*)?([A-Za-z]\w*)\s*>\s+(\w+)$/i);
    if (m && isSobjectType(m[1])) {
      out[m[2]] = m[1];
      continue;
    }
    m = p.match(/^([A-Za-z]\w*(?:\.[A-Za-z]\w*)?)\s+(\w+)$/);
    if (m) {
      const t = m[1].split(".").pop() as string;
      if (isSobjectType(t)) out[m[2]] = t;
    }
  }
  return out;
}

function soqlFields(query: string): [string, string[]] {
  let flat = query;
  for (let i = 0; i < 5; i++) {
    const stripped = flat.replace(/\([^()]*\)/g, " ");
    if (stripped === flat) break;
    flat = stripped;
  }
  const m = SOQL_SELECT_RE.exec(flat);
  if (!m) return ["", []];
  const obj = m[2];
  const orig = SOQL_SELECT_RE.exec(query);
  const clause = orig ? orig[1] : m[1];
  const funcs = new Set([...clause.matchAll(/\b(\w+)\s*\(/g)].map((x) => x[1].toLowerCase()));
  const fields: string[] = [];
  for (const part of m[1].split(",")) {
    const tok = part.trim();
    if (/^[A-Za-z]\w*$/.test(tok) && tok.toLowerCase() !== "from" && !funcs.has(tok.toLowerCase())) fields.push(tok);
  }
  return [obj, fields];
}

function resolveSObjectType(operand: string, typeMap: Record<string, string>): string {
  operand = operand.trim();
  const mnew = operand.match(/\bnew\s+(?:(?:List|Set|Map)\s*<\s*(?:[A-Za-z]\w*\s*,\s*)?)?([A-Za-z]\w*)/i);
  if (mnew && isSobjectType(mnew[1])) return mnew[1];
  const mtok = operand.match(/\b(\w+__(?:c|mdt))\b/i);
  if (mtok) return mtok[1];
  const mvar = operand.match(/^([A-Za-z_]\w*)/);
  return mvar ? typeMap[mvar[1]] ?? "" : "";
}

class ApexExtractor implements Extractor {
  source = "salesforce";

  handles(filePath: string): boolean {
    return filePath.endsWith(".cls");
  }

  extract(filePath: string): [RawNode[], RawEdge[]] {
    const raw = readText(filePath);
    const src = stripApex(raw);
    const stem = path.basename(filePath, ".cls");
    const nameMatch = src.match(/\bclass\s+(\w+)/);
    const cname = nameMatch ? nameMatch[1] : stem;
    const cid = `apexclass/${cname}`;

    // base extends/implements (parse_apex regex) merged with the generic-safe header
    const baseExtends = (src.match(/\bextends\s+([\w.]+)/i) ?? [, ""])[1] as string;
    const baseImplMatch = src.match(/\bimplements\s+([\w.,\s]+?)\s*\{/i);
    const baseImpls = baseImplMatch ? baseImplMatch[1].split(",").map((i) => i.trim()).filter(Boolean) : [];
    let kind = "class";
    const baseImplJoin = baseImpls.join(" ");
    if (baseImplJoin.includes("Batchable")) kind = "batch";
    else if (baseImplJoin.includes("Schedulable")) kind = "schedulable";

    const header = parseHeader(src);
    const extendsName = baseExtends || header.extends_;
    const implements_ = [...baseImpls];
    for (const i of header.implements_) if (!implements_.includes(i)) implements_.push(i);

    const asyncKinds: string[] = [];
    for (const impl of implements_) {
      const short = impl.split(".").pop() as string;
      if (ASYNC_IFACES[impl]) asyncKinds.push(ASYNC_IFACES[impl]);
      else if (ASYNC_IFACES[short]) asyncKinds.push(ASYNC_IFACES[short]);
    }

    // sobject references: custom-object tokens + SOQL FROM targets
    const sobj = new Set<string>();
    for (const m of src.matchAll(/\b(\w+__c)\b/g)) sobj.add(m[1]);
    for (const m of src.matchAll(/\bFROM\s+(\w+)/gi)) sobj.add(m[1]);

    const cnode = node(cid, "apexclass", cname, { kind });
    const nodes: RawNode[] = [cnode];
    const edges: RawEdge[] = [];

    for (const o of [...sobj].sort()) if (o) edges.push(rawEdge(cid, "references", "object", o));
    if (extendsName) edges.push(rawEdge(cid, "extends", "apexclass", extendsName.split(".").pop() as string));
    for (const impl of implements_) {
      const i = impl.trim();
      if (i) edges.push(rawEdge(cid, "implements", "apexclass", i.split(".").pop() as string));
    }

    // string-blanked view so `'... FROM X ...'` can't masquerade as code
    const code = stripStringLiterals(src);

    // qualified `ClassName.method(` -> calls -> apexmethod (skip self-qualifier)
    const seenQ = new Set<string>();
    for (const m of code.matchAll(/\b([A-Z]\w*)\.(\w+)\s*\(/g)) {
      if (m[1] === cname) continue;
      const key = `${m[1]}.${m[2]}`;
      if (seenQ.has(key)) continue;
      seenQ.add(key);
      edges.push(rawEdge(cid, "calls", "apexmethod", key));
    }

    // custom metadata / settings accessors -> references -> object
    const refs = new Set<string>();
    for (const m of code.matchAll(/\b(\w+__mdt)\s*\.\s*(?:getAll|getInstance)\s*\(/gi)) refs.add(m[1]);
    for (const m of code.matchAll(/\b(\w+__c)\s*\.\s*(?:getInstance|getOrgDefaults|getValues)\s*\(/gi)) refs.add(m[1]);
    for (const o of [...refs].sort()) edges.push(rawEdge(cid, "references", "object", o));

    this.deep(src, cname, cid, nodes, edges, asyncKinds);

    if (asyncKinds.length) {
      const uniq = [...new Set(asyncKinds)].sort();
      cnode.async_kind = uniq;
      for (const k of uniq) edges.push(rawEdge(cid, "async", "apexclass", asyncIfaceName(k)));
    }

    // custom-label references -> uses -> label (LabelResolver normalises prefixes)
    const labels = new Set<string>();
    for (const m of src.matchAll(/(?:\$Label|System\.Label|Label)\.([A-Za-z_]\w*)/g)) labels.add(m[1]);
    for (const name of [...labels].sort()) if (name) edges.push(rawEdge(cid, "uses", "label", name));

    return [nodes, edges];
  }

  private deep(src: string, cname: string, cid: string, nodes: RawNode[], edges: RawEdge[], asyncKinds: string[]): void {
    const methods = new Map<string, { annotations: Set<string>; body: string; params: string }>();
    for (const m of src.matchAll(METHOD_RE)) {
      const name = m.groups?.name as string;
      const retRaw = (m.groups?.ret ?? "").trim();
      const ret = retRaw ? (retRaw.split(/\s+/).pop() as string) : "";
      if (NOT_METHODS.has(name.toLowerCase()) || NOT_METHODS.has(ret.toLowerCase())) continue;
      const anns = annotationsBefore(src, m.index ?? 0);
      let body = "";
      if (m.groups?.body === "{") body = balancedBody(src, (m.index ?? 0) + m[0].length - 1);
      const entry = methods.get(name) ?? { annotations: new Set<string>(), body: "", params: "" };
      for (const a of anns) entry.annotations.add(a);
      entry.body += "\n" + body;
      entry.params += "," + (m.groups?.params ?? "");
      methods.set(name, entry);
    }

    for (const [name, info] of methods) {
      const mid = `apexmethod/${cname}.${name}`;
      const anns = [...info.annotations].filter((a) => KEEP_ANNS.has(a)).sort();
      const mnode = node(mid, "apexmethod", `${cname}.${name}`);
      if (anns.length) mnode.annotations = anns;
      nodes.push(mnode);
      edges.push(rawEdge(cid, "contains", "apexmethod", `${cname}.${name}`));

      if (info.annotations.has("future")) {
        asyncKinds.push("future");
        edges.push(rawEdge(mid, "async", "apexclass", "System.Future"));
      }

      const fromObjs = new Set<string>();
      for (const fm of info.body.matchAll(/\bFROM\s+(\w+)/gi)) fromObjs.add(fm[1]);
      for (const o of [...fromObjs].sort()) if (o) edges.push(rawEdge(mid, "reads", "object", o));
      for (const o of [...dmlTargets(info.body)].sort()) if (o) edges.push(rawEdge(mid, "writes", "object", o));

      this.astLite(mid, info.body, info.params, edges, asyncKinds);
    }

    const names = new Set(methods.keys());
    for (const [name, info] of methods) {
      const mid = `apexmethod/${cname}.${name}`;
      const called = new Set<string>();
      for (const m of info.body.matchAll(/(?:\bthis\.)?(\w+)\s*\(/g)) {
        if (names.has(m[1]) && m[1] !== name) called.add(m[1]);
      }
      for (const callee of [...called].sort()) edges.push(rawEdge(mid, "calls", "apexmethod", `${cname}.${callee}`));
    }
  }

  /** AST-lite per-method pass: resolve `var.method()` via a regex-built symbol
   *  table, plus SOQL field reads, dynamic SOQL, precise (typed) DML, and
   *  call-site async — the higher-fidelity edges a real parser would give. */
  private astLite(mid: string, body: string, params: string, edges: RawEdge[], asyncKinds: string[]): void {
    const code = stripStringLiterals(body);
    const symbols = { ...paramTypes(params), ...localTypeMap(code) };

    // instance calls: `var.method(` where `var` has a known declared type
    const seenCall = new Set<string>();
    for (const m of code.matchAll(/\b([A-Za-z_]\w*)\.(\w+)\s*\(/g)) {
      const typ = symbols[m[1]];
      if (!typ) continue;
      const key = `${typ.split(".").pop()}.${m[2]}`;
      if (seenCall.has(key)) continue;
      seenCall.add(key);
      edges.push(rawEdge(mid, "calls", "apexmethod", key));
    }

    // SOQL field selection: [SELECT a, b FROM Obj] -> reads -> field
    const readFields = new Set<string>();
    for (const bm of body.matchAll(SOQL_BRACKET_RE)) {
      const [obj, fields] = soqlFields(bm[1]);
      if (obj) for (const f of fields) readFields.add(`${obj}.${f}`);
    }
    for (const fq of [...readFields].sort()) edges.push(rawEdge(mid, "reads", "field", fq));

    // dynamic SOQL with an inline string literal -> reads -> object
    const dynObjs = new Set<string>();
    for (const dm of body.matchAll(DYNAMIC_SOQL_RE)) {
      const arg = body.slice((dm.index ?? 0) + dm[0].length).replace(/^\s+/, "");
      const sm = arg.match(STRING_LIT_RE);
      if (!sm || sm.index !== 0) continue;
      const fm = /\bFROM\s+(\w+)/i.exec(sm[0]);
      if (fm) dynObjs.add(fm[1]);
    }
    for (const o of [...dynObjs].sort()) edges.push(rawEdge(mid, "reads", "object", o));

    // precise DML via typed locals -> writes -> object
    const dmlObjs = new Set<string>();
    for (const dm of code.matchAll(DATABASE_DML_RE)) {
      const obj = resolveSObjectType(code.slice((dm.index ?? 0) + dm[0].length).split(";")[0].split(",")[0], symbols);
      if (obj) dmlObjs.add(obj);
    }
    for (const dm of code.matchAll(/\b(?:insert|update|delete|upsert|undelete)\b/gi)) {
      const pre = code.slice(0, dm.index ?? 0).replace(/\s+$/, "");
      if (pre.endsWith(".") || /Database\s*\.\s*$/i.test(pre)) continue;
      const obj = resolveSObjectType(code.slice((dm.index ?? 0) + dm[0].length).split(";")[0], symbols);
      if (obj) dmlObjs.add(obj);
    }
    for (const o of [...dmlObjs].sort()) edges.push(rawEdge(mid, "writes", "object", o));

    // call-site async: enqueueJob / executeBatch / schedule -> async -> apexclass
    for (const [rx, kind] of CALLSITE_ASYNC) {
      for (const am of code.matchAll(rx)) {
        asyncKinds.push(kind);
        const mnew = code.slice((am.index ?? 0) + am[0].length).split(";")[0].match(/\bnew\s+([A-Za-z]\w*)/);
        edges.push(rawEdge(mid, "async", "apexclass", mnew && isSobjectType(mnew[1]) ? mnew[1] : asyncIfaceName(kind)));
      }
    }
  }
}

export const APEX_EXTRACTORS: Extractor[] = [new ApexExtractor()];
