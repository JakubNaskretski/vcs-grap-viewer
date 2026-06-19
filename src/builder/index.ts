// In-plugin TypeScript port of graph-builder. Currently covers the objects
// extractor; more extractors register here as they are ported (each verified
// against the Python builder for parity). Output matches graph-builder's
// {nodes, edges, unresolved, errors} shape exactly.
import { BuildResult, Extractor, GraphBuilder } from "./core";
import { walkFiles } from "./fsutil";
import { GROUP_CATALOG } from "./groupCatalog";
import { defaultResolvers } from "./resolvers";
import { OBJECT_EXTRACTORS } from "./extractors/objects";
import { TRIGGER_EXTRACTORS } from "./extractors/triggers";
import { FLOW_EXTRACTORS } from "./extractors/flows";
import { LWC_EXTRACTORS } from "./extractors/lwc";
import { SECURITY_EXTRACTORS } from "./extractors/security";
import { PERMISSION_EXTRACTORS } from "./extractors/permissions";
import { APEX_ANTLR_EXTRACTORS } from "./extractors/apex-antlr";
import { FLEXIPAGE_EXTRACTORS } from "./extractors/flexipages";
import { GLOBALVALUESET_EXTRACTORS } from "./extractors/globalvaluesets";
import { LISTVIEW_EXTRACTORS } from "./extractors/listviews";
import { LABEL_EXTRACTORS } from "./extractors/labels";
import { APPTAB_EXTRACTORS } from "./extractors/apptabs";
import { CUSTOMMETADATA_EXTRACTORS } from "./extractors/custommetadata";
import { EVENTCHANNEL_EXTRACTORS } from "./extractors/eventchannels";
import { GROUP_EXTRACTORS as GROUP_EXTRACTORS_LIST } from "./extractors/groups";
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

// Binds each catalog key (groupCatalog.ts) to its extractor array. The order
// here is the dispatch order — preserved when filtering, so "first node for an
// id wins" is unchanged whether or not a type filter is applied.
const GROUP_EXTRACTORS: Record<string, Extractor[]> = {
  objects: OBJECT_EXTRACTORS,
  triggers: TRIGGER_EXTRACTORS,
  flows: FLOW_EXTRACTORS,
  lwc: LWC_EXTRACTORS,
  security: SECURITY_EXTRACTORS,
  permissions: PERMISSION_EXTRACTORS,
  apex: APEX_ANTLR_EXTRACTORS,
  flexipages: FLEXIPAGE_EXTRACTORS,
  globalvaluesets: GLOBALVALUESET_EXTRACTORS,
  listviews: LISTVIEW_EXTRACTORS,
  labels: LABEL_EXTRACTORS,
  apptabs: APPTAB_EXTRACTORS,
  custommetadata: CUSTOMMETADATA_EXTRACTORS,
  eventchannels: EVENTCHANNEL_EXTRACTORS,
  groups: GROUP_EXTRACTORS_LIST,
  approvalprocesses: APPROVALPROCESS_EXTRACTORS,
  layouts: LAYOUT_EXTRACTORS,
  quickactions: QUICKACTION_EXTRACTORS,
  reports: REPORT_EXTRACTORS,
  rules: RULE_EXTRACTORS,
  sharingrules: SHARINGRULE_EXTRACTORS,
  emailtemplates: EMAILTEMPLATE_EXTRACTORS,
  visualforce: VISUALFORCE_EXTRACTORS,
  aura: AURA_EXTRACTORS,
  omnistudio: OMNISTUDIO_EXTRACTORS,
};

/** Every extractor, in catalog (dispatch) order. */
export const ALL_EXTRACTORS: Extractor[] = GROUP_CATALOG.flatMap((g) => GROUP_EXTRACTORS[g.key] ?? []);

export interface BuildOptions {
  /** Catalog group keys to include. Omit or empty = every group (no filtering). */
  include?: string[];
}

function selectExtractors(opts: BuildOptions): Extractor[] {
  if (!opts.include || opts.include.length === 0) return ALL_EXTRACTORS;
  const want = new Set(opts.include);
  return GROUP_CATALOG.filter((g) => want.has(g.key)).flatMap((g) => GROUP_EXTRACTORS[g.key] ?? []);
}

/** A builder wired with the selected extractors + every resolver — the single
 *  construction point. With no `include`, every extractor is registered. */
export function makeBuilder(opts: BuildOptions = {}): GraphBuilder {
  return new GraphBuilder().register(...selectExtractors(opts)).registerResolver(...defaultResolvers());
}

/** Build the metadata graph for a force-app directory. */
export function buildGraph(root: string, opts: BuildOptions = {}): BuildResult {
  return makeBuilder(opts).build(walkFiles(root));
}

export { GROUP_CATALOG } from "./groupCatalog";
export type { GroupInfo } from "./groupCatalog";
export { walkFiles } from "./fsutil";
export type { BuildResult, ExtractResult } from "./core";
