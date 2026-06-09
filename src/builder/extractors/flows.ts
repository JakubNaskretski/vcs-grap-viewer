// Port of graph-builder's extractors/flows.py. Flow node + flowelement nodes,
// touches/calls/contains/subflow/invocable/embeds/reads/writes edges.
import { Extractor } from "../core";
import { node, rawEdge, RawEdge, RawNode } from "../model";
import { parseFlow } from "../salesforce";
import { asArray, asArrayObj, child, iterElements, parseXmlFile, text } from "../xml";

const ELEMENT_TAGS = [
  "decisions", "assignments", "screens", "subflows", "actionCalls",
  "recordCreates", "recordUpdates", "recordLookups", "recordDeletes",
  "dynamicChoiceSets",
];
const CHOICE_FIELD_TAGS = ["displayField", "valueField", "sortField", "picklistField"];
const RECORD_ACCESS: Record<string, string> = {
  recordLookups: "reads",
  recordCreates: "writes",
  recordUpdates: "writes",
  recordDeletes: "writes",
};
const RECORD_PREFIXES = ["$Record__Prior", "$Record", "Record"];
const EMAIL_ACTION_TYPES = new Set(["emailAlert", "emailSimple"]);

function lwcName(raw: string): string | null {
  if (!raw) return null;
  let name = raw.trim();
  if (!name) return null;
  // Split off a `ns:` or `ns__` namespace prefix. The default-namespace marker `c`
  // is dropped (local component, keyed lwc/<name>); a real managed-package namespace
  // is preserved in API form (`ns:Foo` and `ns__Foo` both -> `ns__Foo`) so the edge
  // targets the packaged component instead of colliding with a local one.
  let ns = "";
  if (name.includes(":")) {
    const i = name.lastIndexOf(":");
    ns = name.slice(0, i);
    name = name.slice(i + 1);
  } else if (name.includes("__")) {
    const i = name.lastIndexOf("__");
    ns = name.slice(0, i);
    name = name.slice(i + 2);
  }
  name = name.trim();
  if (!name || name.includes(" ") || name.includes(".")) return null;
  return ns && ns !== "c" ? `${ns}__${name}` : name;
}


function triggerAttrs(start: Record<string, unknown> | null): [string | null, boolean] {
  if (!start) return [null, false];
  const obj = text(start, "object");
  const triggerType = text(start, "triggerType");
  const scheduled = start["schedule"] !== undefined || triggerType === "Scheduled";
  if (scheduled) return ["schedule", true];
  if (obj && obj.endsWith("__e")) return ["platformevent", false];
  if (obj || triggerType || text(start, "recordTriggerType")) return ["record", false];
  return [null, false];
}

function fieldName(raw: string, obj: string): string | null {
  if (!raw || !obj) return null;
  const field = raw.trim();
  if (!field || field.includes(".") || field.includes(" ")) return null;
  return `${obj}.${field}`;
}

function decisionField(ref: string, obj: string): string | null {
  if (!ref || !obj) return null;
  ref = ref.trim();
  for (const prefix of RECORD_PREFIXES) {
    if (ref.startsWith(prefix + ".")) {
      const field = ref.slice(prefix.length + 1);
      if (field && !field.includes(".") && !field.includes(" ")) return `${obj}.${field}`;
    }
  }
  return null;
}

class FlowExtractor implements Extractor {
  source = "salesforce";

  handles(filePath: string): boolean {
    return filePath.endsWith(".flow-meta.xml");
  }

  extract(filePath: string): [RawNode[], RawEdge[]] {
    const flow = parseFlow(filePath);
    const fid = `flow/${flow.name}`;
    const flowNode = node(fid, "flow", flow.name, { process_type: flow.processType });
    const nodes: RawNode[] = [flowNode];
    const edges: RawEdge[] = [];

    for (const obj of [...flow.objects].sort()) edges.push(rawEdge(fid, "touches", "object", obj));
    for (const cls of [...flow.classRefs].sort()) edges.push(rawEdge(fid, "calls", "apexclass", cls));

    const root = parseXmlFile(filePath);
    if (!root) return [nodes, edges];

    const start = child(root, "start");
    const triggerObj = start ? text(start, "object") : "";
    const [triggerType, scheduled] = triggerAttrs(start);
    if (triggerType) flowNode.trigger_type = triggerType;
    if (scheduled) flowNode.schedule = true;

    for (const tag of ELEMENT_TAGS) {
      for (const el of asArrayObj(root[tag])) {
        const ename = text(el, "name");
        if (!ename) continue;
        const eid = `flowelement/${flow.name}.${ename}`;
        nodes.push(
          node(eid, "flowelement", ename, { flow: flow.name, element_type: tag, flow_label: text(el, "label") || ename }),
        );
        edges.push(rawEdge(fid, "contains", "flowelement", `${flow.name}.${ename}`));

        if (tag === "subflows") {
          const target = text(el, "flowName");
          if (target) edges.push(rawEdge(fid, "subflow", "flow", target));
        } else if (tag === "actionCalls") {
          const actionType = text(el, "actionType");
          if (actionType === "apex") {
            const action = text(el, "actionName");
            if (action) edges.push(rawEdge(eid, "invocable", action.includes(".") ? "apexmethod" : "apexclass", action));
          } else if (EMAIL_ACTION_TYPES.has(actionType)) {
            const action = text(el, "actionName");
            if (action) edges.push(rawEdge(eid, "uses", "emailalert", action));
          }
        } else if (tag === "screens") {
          const seenLwc = new Set<string>();
          for (const fld of iterElements(el, "fields")) {
            const ref = text(fld, "extensionName") || text(fld, "componentName");
            const lwc = lwcName(ref);
            if (lwc && !seenLwc.has(lwc)) {
              seenLwc.add(lwc);
              edges.push(rawEdge(eid, "embeds", "lwc", lwc));
            }
          }
        } else if (tag === "dynamicChoiceSets") {
          const dobj = text(el, "object") || text(el, "picklistObject");
          if (dobj) {
            edges.push(rawEdge(eid, "reads", "object", dobj));
            const seen = new Set<string>();
            for (const ftag of CHOICE_FIELD_TAGS) {
              const fn = fieldName(text(el, ftag), dobj);
              if (fn && !seen.has(fn)) {
                seen.add(fn);
                edges.push(rawEdge(eid, "reads", "field", fn));
              }
            }
          }
        } else if (tag === "decisions") {
          const seen = new Set<string>();
          for (const rule of asArrayObj(el["rules"])) {
            for (const cond of asArrayObj(rule["conditions"])) {
              const fn = decisionField(text(cond, "leftValueReference"), triggerObj);
              if (fn && !seen.has(fn)) {
                seen.add(fn);
                edges.push(rawEdge(eid, "reads", "field", fn));
              }
            }
          }
        } else if (RECORD_ACCESS[tag]) {
          const obj = text(el, "object");
          if (obj) {
            edges.push(rawEdge(eid, RECORD_ACCESS[tag], "object", obj));
            if (tag === "recordLookups") {
              const seen = new Set<string>();
              for (const qf of asArray(el["queriedFields"])) {
                if (typeof qf !== "string") continue;
                const fn = fieldName(qf, obj);
                if (fn && !seen.has(fn)) {
                  seen.add(fn);
                  edges.push(rawEdge(eid, "reads", "field", fn));
                }
              }
              for (const flt of asArrayObj(el["filters"])) {
                const fn = fieldName(text(flt, "field"), obj);
                if (fn && !seen.has(fn)) {
                  seen.add(fn);
                  edges.push(rawEdge(eid, "reads", "field", fn));
                }
              }
            } else if (tag === "recordCreates" || tag === "recordUpdates") {
              const seen = new Set<string>();
              for (const ia of asArrayObj(el["inputAssignments"])) {
                const fn = fieldName(text(ia, "field"), obj);
                if (fn && !seen.has(fn)) {
                  seen.add(fn);
                  edges.push(rawEdge(eid, "writes", "field", fn));
                }
              }
            }
          }
        }
      }
    }

    // record-typed variables declare an object dependency via <objectType>.
    for (const v of asArrayObj(root["variables"])) {
      const ot = text(v, "objectType");
      if (ot && !flow.objects.has(ot)) edges.push(rawEdge(fid, "touches", "object", ot));
    }

    return [nodes, edges];
  }
}

export const FLOW_EXTRACTORS: Extractor[] = [new FlowExtractor()];
