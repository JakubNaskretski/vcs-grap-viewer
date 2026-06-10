// Port of graph-builder's extractors/security.py. Permission sets / profiles ->
// grants edges (+ visibility families); permission-set groups -> contains.
import { Extractor } from "../core";
import { node, rawEdge, RawEdge, RawNode } from "../model";
import { parseAccess, parsePermsetGroup } from "../salesforce";
import { iterElements, parseXmlFile, text } from "../xml";

function isTrue(el: Record<string, unknown>, tag: string): boolean {
  return text(el, tag).toLowerCase() === "true";
}

function sortedRecord<T>(m: Map<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of [...m.keys()].sort()) out[k] = m.get(k) as T;
  return out;
}

class SecurityExtractor implements Extractor {
  source = "salesforce";

  handles(filePath: string): boolean {
    return (
      filePath.endsWith(".permissionset-meta.xml") ||
      filePath.endsWith(".profile-meta.xml") ||
      filePath.endsWith(".permissionsetgroup-meta.xml")
    );
  }

  extract(filePath: string): [RawNode[], RawEdge[]] {
    if (filePath.endsWith(".permissionsetgroup-meta.xml")) return this.extractGroup(filePath);
    const kind = filePath.endsWith(".permissionset-meta.xml") ? "permissionset" : "profile";
    return this.extractAccess(filePath, kind);
  }

  private extractAccess(filePath: string, kind: string): [RawNode[], RawEdge[]] {
    const acc = parseAccess(filePath, kind);
    const aid = `${kind}/${acc.name}`;

    const fieldAccess = new Map<string, { readable: boolean; editable: boolean }>();
    const tabs = new Set<string>();
    const apps = new Map<string, { visible: boolean; default: boolean }>();
    const recordTypes = new Map<string, Set<string>>();
    const customPerms = new Set<string>();
    const pages = new Set<string>();
    const flows = new Set<string>();
    const dataObjects = new Set<string>();

    const root = parseXmlFile(filePath);
    if (root) {
      for (const fp of iterElements(root, "fieldPermissions")) {
        const f = text(fp, "field");
        if (f) fieldAccess.set(f, { readable: isTrue(fp, "readable"), editable: isTrue(fp, "editable") });
      }
      for (const tv of iterElements(root, "tabVisibilities")) {
        const tab = text(tv, "tab");
        if (tab) tabs.add(tab);
      }
      for (const av of iterElements(root, "applicationVisibilities")) {
        const app = text(av, "application");
        if (app) apps.set(app, { visible: isTrue(av, "visible"), default: isTrue(av, "default") });
      }
      for (const rtv of iterElements(root, "recordTypeVisibilities")) {
        const rt = text(rtv, "recordType");
        const dot = rt.indexOf(".");
        if (dot > 0) {
          const obj = rt.slice(0, dot);
          const rname = rt.slice(dot + 1);
          if (obj && rname) (recordTypes.get(obj) ?? recordTypes.set(obj, new Set()).get(obj)!).add(rname);
        }
      }
      for (const cp of iterElements(root, "customPermissions")) {
        const name = text(cp, "name");
        if (name) customPerms.add(name);
      }
      for (const pa of iterElements(root, "pageAccesses")) {
        const pg = text(pa, "apexPage");
        if (pg) pages.add(pg);
      }
      for (const fa of iterElements(root, "flowAccesses")) {
        const fl = text(fa, "flow");
        if (fl) flows.add(fl);
      }
      for (const cmt of iterElements(root, "customMetadataTypeAccesses")) {
        const nm = text(cmt, "name");
        if (nm) dataObjects.add(nm);
      }
      for (const cs of iterElements(root, "customSettingAccesses")) {
        const nm = text(cs, "name");
        if (nm) dataObjects.add(nm);
      }
    }

    const nodes: RawNode[] = [
      node(aid, kind, acc.label || acc.name, {
        field_grants: [...acc.fields].sort(),
        field_access: sortedRecord(fieldAccess),
        app_visibilities: sortedRecord(apps),
        record_type_visibilities: Object.fromEntries(
          [...recordTypes.keys()].sort().map((o) => [o, [...recordTypes.get(o)!].sort()]),
        ),
      }),
    ];

    const edges: RawEdge[] = [];
    for (const obj of [...acc.objects].sort()) if (obj) edges.push(rawEdge(aid, "grants", "object", obj));
    for (const cls of [...acc.classes].sort()) if (cls) edges.push(rawEdge(aid, "grants", "apexclass", cls));
    for (const f of [...acc.fields].sort()) {
      if (!f) continue;
      const flags = fieldAccess.get(f);
      edges.push(rawEdge(aid, "grants", "field", f, flags ? { readable: flags.readable, editable: flags.editable } : {}));
    }
    for (const tab of [...tabs].sort()) edges.push(rawEdge(aid, "grants", "tab", tab));
    for (const app of [...apps.keys()].sort()) {
      const v = apps.get(app)!;
      edges.push(rawEdge(aid, "grants", "app", app, { visible: v.visible, default: v.default }));
    }
    for (const obj of [...recordTypes.keys()].sort()) {
      for (const rname of [...recordTypes.get(obj)!].sort()) {
        edges.push(rawEdge(aid, "grants", "object", obj, { record_type: rname }));
      }
    }
    for (const cp of [...customPerms].sort()) edges.push(rawEdge(aid, "grants", "custompermission", cp));
    for (const pg of [...pages].sort()) edges.push(rawEdge(aid, "grants", "vfpage", pg));
    for (const fl of [...flows].sort()) edges.push(rawEdge(aid, "grants", "flow", fl));
    for (const ob of [...dataObjects].sort()) edges.push(rawEdge(aid, "grants", "object", ob));

    return [nodes, edges];
  }

  private extractGroup(filePath: string): [RawNode[], RawEdge[]] {
    const psg = parsePermsetGroup(filePath);
    const gid = `permsetgroup/${psg.name}`;
    const nodes: RawNode[] = [node(gid, "permsetgroup", psg.label || psg.name)];
    const edges: RawEdge[] = [];
    for (const ps of [...psg.permsets].sort()) if (ps) edges.push(rawEdge(gid, "contains", "permissionset", ps));
    return [nodes, edges];
  }
}

export const SECURITY_EXTRACTORS: Extractor[] = [new SecurityExtractor()];
