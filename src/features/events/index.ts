// Events (task 04): the "Events" sidebar page and the events section of every object's details panel.
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { EventsPage } from "./EventsPage";
import { ObjectEventsSection } from "./ObjectEvents";

registerPage({ id: "events", section: "events", order: 0, labelKey: "events:sidebar", icon: "events", Component: EventsPage });

registerDetailsSection({
  id: "events",
  order: 80,
  appliesTo: (kind) => !(kind.kind === "Event" && (kind.group === "" || kind.group === "events.k8s.io")),
  Component: ObjectEventsSection,
});

export { EVENT_COLUMNS, EventsPage, EventType, InvolvedObjectLink } from "./EventsPage";
export { byNewest, EVENT_KIND, eventSelectorFor, eventTime, involvedObject, isWarning } from "./model";
