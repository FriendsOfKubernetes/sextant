// Details panel (task 04): a live watch of the opened object, and the sections every kind gets — actions,
// metadata, the kind's own fields, conditions and YAML. Other features add their sections the same way
// (`registerDetailsSection` in src/layout/details/registry.ts); orders used here: 0, 10, 20, 30, 90.
import { registerDetailsSection, setDetailsObjectSource } from "../../layout/details/registry";
import { useLiveDetailsObject } from "./liveObject";
import { ConditionsSection, FieldsSection, hasFields, MetadataSection, SummarySection } from "./sections";
import { YamlSection } from "./YamlSection";

setDetailsObjectSource(useLiveDetailsObject);

registerDetailsSection({ id: "summary", order: 0, appliesTo: () => true, Component: SummarySection });
registerDetailsSection({ id: "metadata", order: 10, appliesTo: () => true, Component: MetadataSection });
registerDetailsSection({ id: "fields", order: 20, appliesTo: hasFields, Component: FieldsSection });
registerDetailsSection({ id: "conditions", order: 30, appliesTo: () => true, Component: ConditionsSection });
registerDetailsSection({ id: "yaml", order: 90, appliesTo: () => true, Component: YamlSection });

export { ActionBar } from "./ActionBar";
export { objectWatchSpec, useDetailsLife, useLiveDetailsObject, type DetailsLife } from "./liveObject";
export { toYaml, displayObject } from "./yaml";
export { YamlViewer } from "./YamlSection";
export { Block, chips, Fields, KINDS, link, mapChips, table, type FieldRow } from "./ui";
