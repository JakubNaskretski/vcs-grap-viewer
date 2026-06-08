// Port of graph-builder's extractors/apptabs.py. CustomApplication -> app node +
// contains -> tab; CustomTab -> tab node + one classifying edge.
import * as path from "path";
import { Extractor } from "../core";
import { node, rawEdge, RawEdge, RawNode } from "../model";
import { iterText, parseXmlFile, text } from "../xml";

const APP_SUFFIX = ".app-meta.xml";
const TAB_SUFFIX = ".tab-meta.xml";

class AppTabExtractor implements Extractor {
  source = "salesforce";

  handles(filePath: string): boolean {
    return filePath.endsWith(APP_SUFFIX) || filePath.endsWith(TAB_SUFFIX);
  }

  extract(filePath: string): [RawNode[], RawEdge[]] {
    if (filePath.endsWith(APP_SUFFIX)) return this.app(filePath);
    if (filePath.endsWith(TAB_SUFFIX)) return this.tab(filePath);
    return [[], []];
  }

  private app(filePath: string): [RawNode[], RawEdge[]] {
    const base = path.basename(filePath);
    const name = base.slice(0, base.length - APP_SUFFIX.length);
    const aid = `app/${name}`;
    const nodes: RawNode[] = [node(aid, "app", name)];
    const edges: RawEdge[] = [];
    const root = parseXmlFile(filePath);
    if (!root) return [nodes, edges];
    const seen = new Set<string>();
    for (const tab of iterText(root, "tabs")) {
      const t = tab.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        edges.push(rawEdge(aid, "contains", "tab", t));
      }
    }
    return [nodes, edges];
  }

  private tab(filePath: string): [RawNode[], RawEdge[]] {
    const base = path.basename(filePath);
    const name = base.slice(0, base.length - TAB_SUFFIX.length);
    const tid = `tab/${name}`;
    const nodes: RawNode[] = [node(tid, "tab", name)];
    const edges: RawEdge[] = [];
    const root = parseXmlFile(filePath);
    if (!root) return [nodes, edges];

    const sobject = text(root, "sobjectType");
    const lwc = text(root, "lwcComponent");
    const aura = text(root, "auraComponent");
    const flexipage = text(root, "flexiPage");

    if (sobject) edges.push(rawEdge(tid, "references", "object", sobject));
    // tab name is the object API name — any custom suffix (incl. __x external-object
    // tabs common in packaged orgs), not just __c.
    else if (/__(c|e|mdt|x|b)$/i.test(name)) edges.push(rawEdge(tid, "references", "object", name));
    else if (lwc) edges.push(rawEdge(tid, "embeds", "lwc", lwc));
    else if (aura) edges.push(rawEdge(tid, "embeds", "lwc", aura));
    else if (flexipage) edges.push(rawEdge(tid, "page-for", "flexipage", flexipage));

    return [nodes, edges];
  }
}

export const APPTAB_EXTRACTORS: Extractor[] = [new AppTabExtractor()];
