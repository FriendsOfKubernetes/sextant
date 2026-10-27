// Actions on the selected rows of a resource table (ADR-0126): the selection bar rendered by `ResourceTable`, and the
// explanation of an action that applies to part of the selection. It registers nothing: the actions are the
// registry's (Delete, Restart, Logs, Copy name, …). Agents and extensions get nothing new.
import "./bulk.css";

export { SelectionBar, startBarAction, type SelectionBarProps } from "./SelectionBar";
export { selectionActions, type BarAction } from "./selection";
