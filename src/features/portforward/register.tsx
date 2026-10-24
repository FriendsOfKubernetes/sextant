// Registers the details section, the "Port forward…" action and the Port Forwarding page.
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { registerAction } from "../actions/registry";
import { PortForwardSection } from "./DetailsSection";
import { ForwardDialog } from "./ForwardDialog";
import { isForwardable, portsOf, targetOf } from "./model";
import { PortForwardPage } from "./PortForwardPage";
import "./portforward.css";

export const PORT_FORWARD_PAGE = "portforward";

registerDetailsSection({ id: "portforward", order: 40, appliesTo: isForwardable, Component: PortForwardSection });

registerPage({
  id: PORT_FORWARD_PAGE,
  section: "network",
  order: 100,
  labelKey: "portforward:sidebar",
  icon: "portForwarding",
  Component: PortForwardPage,
});

registerAction("portForward", {
  placement: "primary",
  labelKey: "portforward:action.label",
  icon: "portForward",
  appliesTo: (obj, kind) => portsOf(obj, kind).length > 0,
  run: ({ clusterId, kind, objects, refs, openDialog }) => {
    const [obj, ref] = [objects[0], refs[0]];
    if (!obj || !ref) return;
    const ports = portsOf(obj, kind);
    openDialog((close) => <ForwardDialog clusterId={clusterId} target={targetOf(ref)} ports={ports} close={close} />);
  },
});
