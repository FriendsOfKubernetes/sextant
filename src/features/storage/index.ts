// Storage insights (#152).
//  - Usage: the fill level of every mounted PersistentVolumeClaim (bytes and inodes) from the kubelets' stats
//    summaries through the API server, or from Prometheus' `kubelet_volume_stats_*` when `nodes/proxy` is forbidden
//    (`storage_volume_usage`, polled once a minute per cluster while a view needs it, usageStore.ts): a Usage column
//    in the PVC table, a section in a claim's and a pod's details, and the opt-in problems category "disk almost
//    full" (thresholds `notifications.volumeWarnPercent` / `volumeCriticalPercent`, 85 % / 95 %), which feeds the
//    problems screen, the Cluster counter and the notifications (problems.ts).
//  - VolumeSnapshots (when snapshot.storage.k8s.io is served): a discovered section with snapshots, classes and
//    contents; "Create snapshot" on a bound claim and "Restore to a new PVC" on a ready snapshot.
//  - Velero is Sextant's own extension `extensions/velero` (ADR-0162 amendment), creating its objects through the
//    extensions' `resources.create`.
// Every object is created with one POST (`resource_create`) after a form and a confirmation that lists it; an object
// of the same name is never touched. Agents and extensions get nothing new (they read these kinds with the generic tools).
import "./storage.css";
import "./problems";
import "./register";

export { ThresholdFields } from "./ThresholdFields";
