// Actions that change objects (edit, delete, scale, restart, node and CronJob actions), registered in the action
// registry; the table's context menu and the details panel's ActionBar offer them.
import "./actions.css";
import "./register";

export { ConfirmAction, DeleteDialog, ScaleDialog, displayName, type ConfirmActionProps } from "./dialogs";
