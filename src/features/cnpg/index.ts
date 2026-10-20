// CloudNativePG (#213): the discovered sidebar section "CloudNativePG" — Clusters, Backups, ScheduledBackups and
// Poolers. A Cluster's details tell its state in words, ready instances, the current and target primary (a switchover
// or failover in progress), each instance's role and health from the status, the last successful and failed backup
// and continuous archiving. Unhealthy Clusters, failing archiving or backups and failed Backups feed the problems
// screen (category `cnpg`) and the section counter. Read-only (ADR-0100).
import { registerSectionBadge } from "../../layout/sectionBadges";
import "./cnpg.css";
import { useCnpgProblemCount } from "./problems";
import "./register";

registerSectionBadge("cnpg", useCnpgProblemCount, {
  tone: "danger",
  labelKey: "cnpg:badge",
});

export * from "./model";
