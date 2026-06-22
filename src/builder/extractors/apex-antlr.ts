// Apex class extractor — ANTLR (`@apexdevtools/apex-parser`) backend. Drives the
// same node/edge outputs as the regex apex.ts off a real parse tree, so it is a
// drop-in replacement behind the `.cls` file type. Falls back to the regex
// extractor on a parse error or for non-class units (interfaces/enums) — the same
// two-tier "AST primary, regex baseline" shape graph-builder/zip-agent use.
//
// antlr4 v5 runtime note: rule contexts expose `.children` + `.getText()` and
// `.parentCtx`; terminals carry `.symbol`. `.text` is unreliable — use getText().
import * as path from "path";
import { ApexParser, ApexParserFactory } from "@apexdevtools/apex-parser";
import { Extractor } from "../core";
import { node, rawEdge, RawEdge, RawNode } from "../model";
import { readText } from "../salesforce";
import { ApexExtractor } from "./apex";

// antlr parse-tree node — kept loose; the generated context types add no safety here.
type PNode = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const KEEP_ANNS = new Set([
  "invocablemethod", "auraenabled", "future", "testsetup", "testvisible",
  "remoteaction", "readonly", "httpget", "httppost", "httpput", "httpdelete",
  "httppatch", "namespaceaccessible",
]);

const COLLECTION_WRAPPERS = new Set(["list", "set", "map", "iterable"]);

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

// ---- tree helpers ----------------------------------------------------------
const ctor = (n: PNode): string => (n && n.constructor && n.constructor.name) || "";
const isRule = (n: PNode): boolean => !!n && n.symbol === undefined && Array.isArray(n.children);
const kids = (n: PNode): PNode[] => (n && n.children) || [];
const text = (n: PNode): string => (n && n.getText && n.getText()) || "";

function* walk(n: PNode): Generator<PNode> {
  for (const c of kids(n)) {
    if (isRule(c)) {
      yield c;
      yield* walk(c);
    }
  }
}
function findAll(n: PNode, type: string): PNode[] {
  const want = type + "Context";
  const out: PNode[] = [];
  for (const d of walk(n)) if (ctor(d) === want) out.push(d);
  return out;
}
function firstDesc(n: PNode, type: string): PNode | undefined {
  const want = type + "Context";
  for (const d of walk(n)) if (ctor(d) === want) return d;
  return undefined;
}
function child(n: PNode, type: string): PNode | undefined {
  const want = type + "Context";
  for (const c of kids(n)) if (ctor(c) === want) return c;
  return undefined;
}
function childrenOf(n: PNode, type: string): PNode[] {
  const want = type + "Context";
  return kids(n).filter((c: PNode) => ctor(c) === want);
}
const firstRule = (n: PNode): PNode | undefined => kids(n).find(isRule);

// ---- type helpers (mirror apex.ts) -----------------------------------------
function isSobjectType(t: string): boolean {
  const lower = t.toLowerCase();
  return !!t && !COLLECTION_WRAPPERS.has(lower) && lower !== "id";
}
/** Short, generic-free, last-dotted segment of a type: `Database.Batchable<X>` -> `Batchable`.
 *  Strips generics innermost-first so NESTED ones (`Map<Id,List<X>>`) fully clear —
 *  a single `<[^>]*>` pass would leave a trailing `>` (`Map>`). */
function shortName(typeText: string): string {
  let t = typeText;
  let prev: string;
  do {
    prev = t;
    t = t.replace(/<[^<>]*>/g, "");
  } while (t !== prev);
  t = t.replace(/\[\s*\]/g, "");
  return (t.split(".").pop() || "").trim();
}
/** The sObject element/base type of a (possibly collection) type: `List<Account>` -> `Account`. */
function sobjectTypeOf(typeText: string): string {
  const m = typeText.match(/^(?:List|Set|Map)\s*<\s*(?:[\w.]+\s*,\s*)?([\w.]+)\s*>/i);
  return shortName(m ? m[1] : typeText);
}
/** A class-like reference (PascalCase, not an sObject token) — `calls`/`new` target. */
function looksLikeClass(name: string): boolean {
  if (!name || /[<>]/.test(name) || /__(?:c|mdt|e|x|b|share|history)$/i.test(name)) return false;
  if (COLLECTION_WRAPPERS.has(name.toLowerCase())) return false;
  return name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();
}

/** Resolve a DML/expression operand node to its sObject type: a `new X(...)`
 *  creator (read from the AST, since getText() drops the space in `new X`), a
 *  `__c`/`__mdt` token, or a typed local/param via the symbol table. */
function resolveOperandNode(opNode: PNode, symbols: Record<string, string>): string {
  if (!opNode) return "";
  const created = firstDesc(opNode, "CreatedName");
  if (created) {
    const t = sobjectTypeOf(text(created));
    if (t && isSobjectType(t)) return t;
  }
  const raw = text(opNode);
  const mtok = raw.match(/\b(\w+__(?:c|mdt))\b/i);
  if (mtok) return mtok[1];
  const mvar = raw.match(/^([A-Za-z_]\w*)/);
  return mvar ? symbols[mvar[1]] ?? "" : "";
}

// antlr PredictionMode constants. Not re-exported by apex-parser, but stable
// since antlr4's inception: SLL=0 (near-linear, no full-context lookahead),
// LL=1 (full ALL(*)). The parser ships defaulting to LL — that full-context
// prediction is the part that goes super-linear and silently wedges the worker
// for minutes on a single large generated .cls (WSDL2Apex output, a giant static
// Map literal, deeply nested expressions). SLL never enters full context, so it
// cannot blow up; per antlr's documented two-stage contract it is correct
// whenever it reports no syntax error.
const PRED_SLL = 0;
const PRED_LL = 1;
// The LL escalation only ever runs for a file SLL already flagged as malformed.
// Bound it: a huge malformed file isn't worth a possibly multi-minute full-context
// parse, so above this size we keep the SLL result (errors>0) and let extract()
// drop it to the regex baseline. Valid files never reach the retry (SLL returns
// errors=0), so this costs zero AST precision on anything parseable.
const LL_RETRY_MAX_CHARS = 200_000;

function parseOnce(src: string, predictionMode: number): { tree: PNode; errors: number } {
  const lexer = ApexParserFactory.createLexer(src);
  // removeErrorListeners() on BOTH lexer and parser is load-bearing, not hygiene:
  // antlr seeds every recognizer with a ConsoleErrorListener that writes each
  // syntax error to stderr. Without these, malformed .cls files flood the worker's
  // stderr (one line per error, thousands of files). Keep them.
  lexer.removeErrorListeners();
  const tokens = ApexParserFactory.createTokenStream(lexer);
  const parser = new ApexParser(tokens);
  parser.removeErrorListeners();
  // `.predictionMode` is a number at runtime; the bundled d.ts types it as the
  // PredictionMode class, hence the cast. `_interp` exists immediately after
  // construction (set in the generated ApexParser constructor).
  (parser as unknown as { _interp: { predictionMode: number } })._interp.predictionMode = predictionMode;
  let errors = 0;
  parser.addErrorListener({
    syntaxError: () => {
      errors++;
    },
    reportAmbiguity: () => {},
    reportAttemptingFullContext: () => {},
    reportContextSensitivity: () => {},
  } as never);
  const tree = parser.compilationUnit();
  return { tree, errors };
}

/** Parse SLL-first; escalate to full LL only when SLL flags an error, so the
 *  common case (any valid class, however large) takes the fast near-linear path
 *  with a complete AST. A genuinely malformed file errors under both modes and
 *  the caller drops it to the regex baseline. The LL retry is size-capped so a
 *  huge malformed file can't wedge the worker on a multi-minute full-context
 *  parse — only small malformed files (bounded LL cost) ever reach it. */
function parseApex(src: string): { tree: PNode; errors: number } {
  const sll = parseOnce(src, PRED_SLL);
  if (sll.errors === 0 || src.length > LL_RETRY_MAX_CHARS) return sll;
  return parseOnce(src, PRED_LL);
}

const DML_STATEMENTS = ["InsertStatement", "UpdateStatement", "DeleteStatement", "UpsertStatement", "UndeleteStatement"];

export class ApexAntlrExtractor implements Extractor {
  source = "salesforce";
  private fallback = new ApexExtractor();

  handles(filePath: string): boolean {
    return filePath.endsWith(".cls");
  }

  extract(filePath: string): [RawNode[], RawEdge[]] {
    const raw = readText(filePath);
    // The whole parse+walk falls back to the regex baseline on ANY throw — not
    // just a parser blow-up. The parser recovers (doesn't throw) on malformed
    // Apex, so the realistic failure is a walk helper hitting a surprising
    // recovered tree; like the regex extractor, this path must never throw past
    // the fallback, or the class would silently vanish from the graph.
    try {
      const { tree, errors } = parseApex(raw);
      const cls = firstDesc(tree, "ClassDeclaration");
      if (errors > 0 || !cls) return this.fallback.extract(filePath); // interface/enum/bad parse
      return this.build(tree, cls, filePath);
    } catch {
      return this.fallback.extract(filePath);
    }
  }

  private build(tree: PNode, cls: PNode, filePath: string): [RawNode[], RawEdge[]] {
    const cname = text(child(cls, "Id")) || path.basename(filePath, ".cls");
    const cid = `apexclass/${cname}`;

    // extends (direct TypeRef child) + implements (TypeList of TypeRefs)
    const extendsRef = child(cls, "TypeRef");
    const implList = child(cls, "TypeList");
    const implements_ = (implList ? childrenOf(implList, "TypeRef") : []).map((t) => text(t));

    let kind = "class";
    const implJoin = implements_.join(" ");
    if (/\bBatchable\b/.test(implJoin)) kind = "batch";
    else if (/\bSchedulable\b/.test(implJoin)) kind = "schedulable";

    const asyncKinds: string[] = [];
    for (const impl of implements_) {
      const bare = impl.replace(/<[^>]*>/g, "");
      if (ASYNC_IFACES[bare]) asyncKinds.push(ASYNC_IFACES[bare]);
      else if (ASYNC_IFACES[shortName(bare)]) asyncKinds.push(ASYNC_IFACES[shortName(bare)]);
    }

    const cnode = node(cid, "apexclass", cname, { kind });
    const nodes: RawNode[] = [cnode];
    const edges: RawEdge[] = [];

    if (extendsRef) edges.push(rawEdge(cid, "extends", "apexclass", shortName(text(extendsRef))));
    for (const impl of implements_) {
      const s = shortName(impl);
      if (s) edges.push(rawEdge(cid, "implements", "apexclass", s));
    }

    // references -> object: SOQL FROM targets + __c/__mdt type usages + mdt/settings accessors
    const sobj = new Set<string>();
    for (const from of findAll(tree, "FromNameList")) {
      const obj = shortName(text(child(from, "FieldName")));
      if (obj) sobj.add(obj);
    }
    for (const tn of findAll(tree, "TypeName")) {
      const t = shortName(text(tn));
      if (/__(?:c|mdt)$/i.test(t)) sobj.add(t);
    }

    // dot-expression call sites across the whole class (initializers included):
    // qualified static calls, custom metadata/settings accessors.
    const seenQ = new Set<string>();
    for (const de of findAll(tree, "DotExpression")) {
      const call = child(de, "DotMethodCall");
      if (!call) continue; // field access, not a call
      const recv = text(firstRule(de));
      const method = text(child(call, "AnyId"));
      if (!method) continue;
      const mdt = recv.match(/^(\w+__mdt)$/i);
      if (mdt && /^(getall|getinstance)$/i.test(method)) sobj.add(mdt[1]);
      const cset = recv.match(/^(\w+__c)$/i);
      if (cset && /^(getinstance|getorgdefaults|getvalues)$/i.test(method)) sobj.add(cset[1]);
      const pascal = recv.match(/^([A-Z]\w*)$/);
      // `Recv.Recv()` is never a real static call (construction is `new Recv()`,
      // handled via CreatedName). Without the `method !== pascal[1]` guard it would
      // emit a phantom `calls -> apexmethod Recv.Recv` edge that resolve() then
      // materializes as an orphan stub node (constructors aren't emitted as methods).
      if (pascal && pascal[1] !== cname && method !== pascal[1]) {
        const key = `${pascal[1]}.${method}`;
        if (!seenQ.has(key)) {
          seenQ.add(key);
          edges.push(rawEdge(cid, "calls", "apexmethod", key));
        }
      }
    }

    // new ClassName(...) -> calls -> apexclass (unwrap collection element types)
    const newClasses = new Set<string>();
    for (const cr of findAll(tree, "CreatedName")) {
      const t0 = text(cr);
      let t = shortName(t0);
      if (COLLECTION_WRAPPERS.has(t.toLowerCase())) {
        t = sobjectTypeOf(t0);
        if (!t) continue;
      }
      if (t && t !== cname && looksLikeClass(t)) newClasses.add(t);
    }
    for (const c of [...newClasses].sort()) edges.push(rawEdge(cid, "calls", "apexclass", c));

    // methods (grouped by name like the regex; constructors skipped)
    const byName = new Map<string, { anns: Set<string>; decls: PNode[] }>();
    for (const md of findAll(tree, "MethodDeclaration")) {
      const nm = text(child(md, "Id"));
      if (!nm || nm === cname) continue;
      const entry = byName.get(nm) ?? { anns: new Set<string>(), decls: [] };
      for (const a of annotationsOf(md)) entry.anns.add(a);
      entry.decls.push(md);
      byName.set(nm, entry);
    }
    const methodNames = new Set(byName.keys());

    for (const [nm, info] of byName) {
      const mid = `apexmethod/${cname}.${nm}`;
      const anns = [...info.anns].filter((a) => KEEP_ANNS.has(a)).sort();
      const mnode = node(mid, "apexmethod", `${cname}.${nm}`);
      if (anns.length) mnode.annotations = anns;
      nodes.push(mnode);
      edges.push(rawEdge(cid, "contains", "apexmethod", `${cname}.${nm}`));

      if (info.anns.has("future")) {
        asyncKinds.push("future");
        edges.push(rawEdge(mid, "async", "apexclass", "System.Future"));
      }

      const symbols: Record<string, string> = {};
      for (const md of info.decls) Object.assign(symbols, symbolTable(md));

      const reads = new Set<string>();
      const readFields = new Set<string>();
      const writes = new Set<string>();
      const instanceCalls = new Set<string>();
      const m2m = new Set<string>();

      for (const md of info.decls) {
        // SOQL: reads -> object + reads -> field
        for (const q of findAll(md, "Query")) {
          const from = child(q, "FromNameList");
          const obj = from ? shortName(text(child(from, "FieldName"))) : "";
          if (obj) reads.add(obj);
          const sel = child(q, "SelectList");
          if (obj && sel) {
            for (const e of childrenOf(sel, "SelectEntry")) {
              // read the FieldName child, not the whole entry: skips functions
              // (COUNT(Id)) and drops any `field alias` suffix getText would glue on.
              const f = text(child(e, "FieldName"));
              if (/^[A-Za-z]\w*$/.test(f)) readFields.add(`${obj}.${f}`);
            }
          }
        }
        // DML statements: writes -> object (resolve operand via symbol table)
        for (const stmt of DML_STATEMENTS) {
          for (const s of findAll(md, stmt)) {
            const obj = resolveOperandNode(firstRule(s), symbols);
            if (obj) writes.add(obj);
          }
        }
        // dot-expression calls inside the method: instance calls, Database DML, call-site async
        for (const de of findAll(md, "DotExpression")) {
          const call = child(de, "DotMethodCall");
          if (!call) continue;
          const recv = text(firstRule(de));
          const method = text(child(call, "AnyId"));
          if (!method) continue;
          const args = child(call, "ExpressionList");

          // Database.<dml>(x) -> writes -> object
          if (/^Database$/i.test(recv) && /^(insert|update|delete|upsert|undelete)$/i.test(method)) {
            const obj = resolveOperandNode(args, symbols);
            if (obj) writes.add(obj);
          }
          // dynamic SOQL: Database.query/getQueryLocator/countQuery('... FROM X ...') -> reads -> object
          if (/^Database$/i.test(recv) && /^(query|getQueryLocator|countQuery)$/i.test(method)) {
            const lit = text(args).match(/^'(?:[^'\\]|\\.|'')*'/); // leading string-literal arg
            const fm = lit && /\bFROM\s+(\w+)/i.exec(lit[0]);
            if (fm) reads.add(fm[1]);
          }
          // call-site async: System.enqueueJob / Database.executeBatch / System.schedule
          const kind2 = callSiteAsync(recv, method);
          if (kind2) {
            asyncKinds.push(kind2);
            const created = args ? firstDesc(args, "CreatedName") : undefined;
            const tname = created ? shortName(text(created)) : "";
            edges.push(rawEdge(mid, "async", "apexclass", tname && isSobjectType(tname) ? tname : asyncIfaceName(kind2)));
          }
          // instance call: var.method() where var has a known declared type
          const simple = recv.match(/^([A-Za-z_]\w*)$/);
          if (simple && symbols[simple[1]]) instanceCalls.add(`${shortName(symbols[simple[1]])}.${method}`);
        }
        // unqualified sibling-method calls -> calls -> apexmethod
        for (const mc of findAll(md, "MethodCall")) {
          const callee = text(child(mc, "Id"));
          if (callee && callee !== nm && methodNames.has(callee)) m2m.add(callee);
        }
      }

      for (const o of [...reads].sort()) edges.push(rawEdge(mid, "reads", "object", o));
      for (const fq of [...readFields].sort()) edges.push(rawEdge(mid, "reads", "field", fq));
      for (const o of [...writes].sort()) edges.push(rawEdge(mid, "writes", "object", o));
      for (const c of [...instanceCalls].sort()) edges.push(rawEdge(mid, "calls", "apexmethod", c));
      for (const c of [...m2m].sort()) edges.push(rawEdge(mid, "calls", "apexmethod", `${cname}.${c}`));
    }

    for (const o of [...sobj].sort()) if (o) edges.push(rawEdge(cid, "references", "object", o));

    if (asyncKinds.length) {
      const uniq = [...new Set(asyncKinds)].sort();
      cnode.async_kind = uniq;
      for (const k of uniq) edges.push(rawEdge(cid, "async", "apexclass", asyncIfaceName(k)));
    }

    // custom-label references -> uses -> label
    const labels = new Set<string>();
    for (const m of text(cls).matchAll(/(?:\$Label|System\.Label|Label)\.([A-Za-z_]\w*)/g)) labels.add(m[1]);
    for (const name of [...labels].sort()) if (name) edges.push(rawEdge(cid, "uses", "label", name));

    return [nodes, edges];
  }
}

/** Lowercased annotation names on a method (from its ClassBodyDeclaration modifiers). */
function annotationsOf(md: PNode): string[] {
  const cbd = md.parentCtx?.parentCtx; // MethodDeclaration -> MemberDeclaration -> ClassBodyDeclaration
  const out: string[] = [];
  for (const mod of cbd ? childrenOf(cbd, "Modifier") : []) {
    const ann = child(mod, "Annotation");
    if (!ann) continue;
    const nm = text(child(ann, "QualifiedName") || child(ann, "Id")).toLowerCase();
    if (nm) out.push(nm);
  }
  return out;
}

/** Per-method variable -> sObject-type table: params, locals, enhanced-for vars. */
function symbolTable(method: PNode): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (typeRef: PNode, idNode: PNode): void => {
    const v = text(idNode);
    const t = sobjectTypeOf(text(typeRef));
    if (v && t && isSobjectType(t) && !(v in out)) out[v] = t;
  };
  for (const fp of findAll(method, "FormalParameter")) add(child(fp, "TypeRef"), child(fp, "Id"));
  for (const lv of findAll(method, "LocalVariableDeclaration")) {
    const tr = child(lv, "TypeRef");
    const decls = child(lv, "VariableDeclarators");
    for (const d of decls ? childrenOf(decls, "VariableDeclarator") : []) add(tr, child(d, "Id"));
  }
  for (const ef of findAll(method, "EnhancedForControl")) add(child(ef, "TypeRef"), child(ef, "Id"));
  // catch (ExceptionType e): the type is a QualifiedName, not a TypeRef.
  for (const cc of findAll(method, "CatchClause")) {
    const qn = child(cc, "QualifiedName");
    const id = child(cc, "Id");
    const v = text(id);
    const t = shortName(text(qn));
    if (v && t && isSobjectType(t) && !(v in out)) out[v] = t;
  }
  return out;
}

function callSiteAsync(recv: string, method: string): string | undefined {
  if (/^System$/i.test(recv) && /^enqueueJob$/i.test(method)) return "queueable";
  if (/^Database$/i.test(recv) && /^executeBatch$/i.test(method)) return "batchable";
  if (/^System$/i.test(recv) && /^schedule$/i.test(method)) return "schedulable";
  return undefined;
}

export const APEX_ANTLR_EXTRACTORS: Extractor[] = [new ApexAntlrExtractor()];
