// Canonical, UI-facing list of selectable source-type groups (key + display
// label). Deliberately free of extractor imports so the extension host can render
// the build-time type picker without bundling the whole builder; index.ts binds
// each key to its extractor array. Keep keys in sync with GROUP_EXTRACTORS there.
export interface GroupInfo {
  key: string;
  label: string;
}

export const GROUP_CATALOG: GroupInfo[] = [
  { key: "objects", label: "Objects & Fields" },
  { key: "triggers", label: "Apex Triggers" },
  { key: "flows", label: "Flows" },
  { key: "lwc", label: "Lightning Web Components" },
  { key: "security", label: "Field & Object Security" },
  { key: "permissions", label: "Permission Sets & Profiles" },
  { key: "apex", label: "Apex Classes" },
  { key: "flexipages", label: "FlexiPages (Lightning Pages)" },
  { key: "globalvaluesets", label: "Global Value Sets" },
  { key: "listviews", label: "List Views" },
  { key: "labels", label: "Custom Labels" },
  { key: "apptabs", label: "App & Custom Tabs" },
  { key: "custommetadata", label: "Custom Metadata" },
  { key: "eventchannels", label: "Platform Event Channels" },
  { key: "groups", label: "Public Groups & Queues" },
  { key: "approvalprocesses", label: "Approval Processes" },
  { key: "layouts", label: "Page Layouts" },
  { key: "quickactions", label: "Quick Actions" },
  { key: "reports", label: "Reports" },
  { key: "rules", label: "Validation & Workflow Rules" },
  { key: "sharingrules", label: "Sharing Rules" },
  { key: "emailtemplates", label: "Email Templates" },
  { key: "visualforce", label: "Visualforce" },
  { key: "aura", label: "Aura Components" },
  { key: "omnistudio", label: "OmniStudio" },
];
