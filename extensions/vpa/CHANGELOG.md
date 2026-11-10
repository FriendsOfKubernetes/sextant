# Changes of Vertical Pod Autoscaler

## 1.0.0 — 2026-11-10

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in Vertical Pod Autoscaler view
(ADR-0111) as an extension.

- **A sidebar section "Vertical Pod Autoscaler"** after Karpenter's, with VerticalPodAutoscalers and Checkpoints in
  Sextant's table, the built-in columns in their widths (the state sorted and filtered by its name, CPU and memory targets in Sextant's
  units sorted by the amount, a checkpoint's last save as a date and time), and "Only
  problems".
- **Details** without a heading of their own, their blocks remembered in Sextant's memory of details sections: a VPA's
  state and what it means, its update mode explained, an HPA that fights it, its recommendation per container against
  the target's template with what the admission controller would set on a pod created now, and the VPA components
  found in the cluster; a **"Vertical Pod Autoscaler" block** on every Deployment, StatefulSet, DaemonSet, ReplicaSet,
  Job and CronJob a VPA targets. The tables' columns resize and Sextant remembers their widths, as the built-in
  tables'. The blocks keep the open or closed choices remembered for the built-in ones, and follow the cluster's kinds
  while shown, as the built-in sections followed discovery.
- **Problems** in the category "Vertical Pod Autoscaler", on by default and never given to agents: a configuration the
  recommender cannot use, a VPA that matches no pod (listed, not notified), and a fight with an HPA
  that scales the same workload on a resource the VPA changes; counted on the section.
- Installing asks for consent to read VPAs, their checkpoints, HPAs and the workloads a VPA can target, and to judge
  VPAs (looking up HPAs) in problem rules.
- A fight with an HPA names the HPA, in the built-in problem's words ("HPA … scales the same workload on …"); several
  HPAs on one target are named together in one problem.
- The rules' HPAs are listed only in the namespaces of the VPAs that change running pods (`narrowLookups`), as the
  built-in held them, up to 40 namespaces, then wherever the extension may read.
