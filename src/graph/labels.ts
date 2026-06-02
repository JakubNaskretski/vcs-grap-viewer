// Display vocabulary — readable edge wording and per-type colors. This is a
// *presentation* layer only: anything not listed falls back to a derived default,
// so new node/edge types from graph-builder render automatically (just less prettily).

const EDGE_OUT: Record<string, string> = {
  field_of: "Field of",
  lookup: "Looks up",
  on: "Trigger on",
  calls: "Calls",
  references: "References",
  touches: "Touches",
  uses: "Uses",
  "uses-component": "Uses component",
  "page-for": "Page for",
  embeds: "Embeds",
  grants: "Grants access to",
  contains: "Contains",
  maps: "Maps",
  extends: "Extends",
  implements: "Implements",
  invocable: "Invokes (apex)",
  "aura-enabled": "Apex (@AuraEnabled)",
  wire: "Wires",
  reads: "Reads",
  writes: "Writes",
  subflow: "Subflow",
  async: "Runs async via",
  validates: "Validates",
  formula: "Formula refs",
  tests: "Tests",
  requires: "Requires",
};

const EDGE_IN: Record<string, string> = {
  field_of: "Fields",
  lookup: "Looked up by",
  on: "Has trigger",
  calls: "Called by",
  references: "Referenced by",
  touches: "Touched by",
  uses: "Used by",
  "uses-component": "Used by component",
  "page-for": "Has page",
  embeds: "Embedded in",
  grants: "Access granted by",
  contains: "Member of",
  maps: "Mapped by",
  extends: "Extended by",
  implements: "Implemented by",
  invocable: "Invoked by",
  "aura-enabled": "Exposed to",
  wire: "Wired by",
  reads: "Read by",
  writes: "Written by",
  subflow: "Called as subflow by",
  async: "Async source for",
  validates: "Validated by",
  formula: "Referenced in formula",
  tests: "Tested by",
  requires: "Required by",
};

function humanize(t: string): string {
  return (t || "").replace(/[-_]/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase()) || "Related";
}

export function edgeOutLabel(t: string): string {
  return EDGE_OUT[t] ?? humanize(t);
}

export function edgeInLabel(t: string): string {
  return EDGE_IN[t] ?? `${humanize(t)} (in)`;
}

// Node-type colors, grouped the way graph-builder's vault folders group them so
// related kinds read as one family on the map.
const TYPE_COLORS: Record<string, string> = {
  // Objects / data model — blue
  object: "#4C8DFF",
  field: "#6FA8FF",
  recordtype: "#4C8DFF",
  listview: "#4C8DFF",
  globalvalueset: "#4C8DFF",
  custommetadatarecord: "#4C8DFF",
  // Apex — amber
  apexclass: "#FF8C42",
  apexmethod: "#FFB066",
  // Triggers — pink
  trigger: "#E0529C",
  // Flows — green
  flow: "#43C59E",
  flowelement: "#7BD8BE",
  // LWC / Aura — purple
  lwc: "#A06CD5",
  aura: "#B98FE0",
  // Visualforce
  vfpage: "#6C8AD5",
  vfcomponent: "#6C8AD5",
  // Pages / layout — teal
  flexipage: "#2FB6B6",
  layout: "#2FB6B6",
  quickaction: "#2FB6B6",
  // Apps — yellow
  app: "#F2C14E",
  tab: "#F2C14E",
  // Security — red
  permissionset: "#E5564E",
  profile: "#E5564E",
  permsetgroup: "#E5564E",
  custompermission: "#E5564E",
  sharingrule: "#E5564E",
  queue: "#E5564E",
  publicgroup: "#E5564E",
  role: "#E5564E",
  // OmniStudio — violet
  omniscript: "#C77DFF",
  integrationprocedure: "#C77DFF",
  datamapper: "#C77DFF",
  flexcard: "#C77DFF",
  // Analytics
  report: "#5AA9E6",
  dashboard: "#5AA9E6",
  // Automation — slate
  approvalprocess: "#8D99AE",
  assignmentrule: "#8D99AE",
  escalationrule: "#8D99AE",
  duplicaterule: "#8D99AE",
  matchingrule: "#8D99AE",
  customnotificationtype: "#8D99AE",
  platformeventchannel: "#8D99AE",
  // Misc — grey
  label: "#9AA0A6",
  resource: "#9AA0A6",
  messagechannel: "#9AA0A6",
  emailtemplate: "#9AA0A6",
};

const DEFAULT_COLOR = "#888888";

export function typeColor(t: string): string {
  return TYPE_COLORS[t] ?? DEFAULT_COLOR;
}
