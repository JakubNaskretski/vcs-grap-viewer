// In-plugin TypeScript port of graph-builder. Currently covers the objects
// extractor; more extractors register here as they are ported (each verified
// against the Python builder for parity). Output matches graph-builder's
// {nodes, edges, unresolved, errors} shape exactly.
import { BuildResult, GraphBuilder } from "./core";
import { walkFiles } from "./fsutil";
import { defaultResolvers } from "./resolvers";
import { OBJECT_EXTRACTORS } from "./extractors/objects";
import { TRIGGER_EXTRACTORS } from "./extractors/triggers";
import { FLOW_EXTRACTORS } from "./extractors/flows";
import { LWC_EXTRACTORS } from "./extractors/lwc";
import { SECURITY_EXTRACTORS } from "./extractors/security";
import { PERMISSION_EXTRACTORS } from "./extractors/permissions";
import { APEX_EXTRACTORS } from "./extractors/apex";
import { FLEXIPAGE_EXTRACTORS } from "./extractors/flexipages";
import { GLOBALVALUESET_EXTRACTORS } from "./extractors/globalvaluesets";
import { LISTVIEW_EXTRACTORS } from "./extractors/listviews";
import { LABEL_EXTRACTORS } from "./extractors/labels";
import { APPTAB_EXTRACTORS } from "./extractors/apptabs";
import { CUSTOMMETADATA_EXTRACTORS } from "./extractors/custommetadata";
import { EVENTCHANNEL_EXTRACTORS } from "./extractors/eventchannels";
import { GROUP_EXTRACTORS } from "./extractors/groups";
import { APPROVALPROCESS_EXTRACTORS } from "./extractors/approvalprocesses";
import { LAYOUT_EXTRACTORS } from "./extractors/layouts";
import { QUICKACTION_EXTRACTORS } from "./extractors/quickactions";
import { REPORT_EXTRACTORS } from "./extractors/reports";
import { RULE_EXTRACTORS } from "./extractors/rules";
import { SHARINGRULE_EXTRACTORS } from "./extractors/sharingrules";
import { EMAILTEMPLATE_EXTRACTORS } from "./extractors/emailtemplates";
import { VISUALFORCE_EXTRACTORS } from "./extractors/visualforce";
import { AURA_EXTRACTORS } from "./extractors/aura";
import { OMNISTUDIO_EXTRACTORS } from "./extractors/omnistudio";

export const ALL_EXTRACTORS = [
  ...OBJECT_EXTRACTORS,
  ...TRIGGER_EXTRACTORS,
  ...FLOW_EXTRACTORS,
  ...LWC_EXTRACTORS,
  ...SECURITY_EXTRACTORS,
  ...PERMISSION_EXTRACTORS,
  ...APEX_EXTRACTORS,
  ...FLEXIPAGE_EXTRACTORS,
  ...GLOBALVALUESET_EXTRACTORS,
  ...LISTVIEW_EXTRACTORS,
  ...LABEL_EXTRACTORS,
  ...APPTAB_EXTRACTORS,
  ...CUSTOMMETADATA_EXTRACTORS,
  ...EVENTCHANNEL_EXTRACTORS,
  ...GROUP_EXTRACTORS,
  ...APPROVALPROCESS_EXTRACTORS,
  ...LAYOUT_EXTRACTORS,
  ...QUICKACTION_EXTRACTORS,
  ...REPORT_EXTRACTORS,
  ...RULE_EXTRACTORS,
  ...SHARINGRULE_EXTRACTORS,
  ...EMAILTEMPLATE_EXTRACTORS,
  ...VISUALFORCE_EXTRACTORS,
  ...AURA_EXTRACTORS,
  ...OMNISTUDIO_EXTRACTORS,
];

/** A builder wired with every extractor + resolver — the single construction point. */
export function makeBuilder(): GraphBuilder {
  return new GraphBuilder().register(...ALL_EXTRACTORS).registerResolver(...defaultResolvers());
}

/** Build the metadata graph for a force-app directory. */
export function buildGraph(root: string): BuildResult {
  return makeBuilder().build(walkFiles(root));
}

export { walkFiles } from "./fsutil";
export type { BuildResult, ExtractResult } from "./core";
