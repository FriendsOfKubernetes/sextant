# ADR-0076: Pod Security Standards are evaluated locally, Trivy reports are read-only, and security findings are opt-in

## Context

"Is this workload safe to run, and would the namespace's Pod Security level admit it?" (#143). The Pod Security Standards (Baseline and Restricted) are the cluster's own vocabulary, enforced by the built-in Pod Security Admission through namespace labels, but a violation shows up only when a Pod is rejected or a warning scrolls past `kubectl apply`. Image vulnerabilities and configuration audits come from Trivy Operator where it is installed, as custom resources. Turning on enforcement or a stricter namespace label is risky without knowing first which workloads it would reject.

## Decision

- **The standards are evaluated in the frontend** (`src/features/security/pss.ts`, as of Kubernetes v1.37): every Baseline and Restricted control on a Pod or the pod template of a Deployment, StatefulSet, DaemonSet, ReplicaSet, Job or CronJob, read the way Pod Security Admission reads it — all container lists including init and ephemeral containers, pod-level inheritance where the standard says so, the Windows exemptions, the user-namespace relaxations, controls and allowed values added later applied only from their version (`<mode>-version` labels). Each finding has the exact field path, the value found and a fix as a strategic merge patch (`snippet.ts`), copied as YAML and never applied. Hardening hints (read-only root filesystem, requests/limits, an unpinned image, the service account token) are `hint`, not violations.
- **Namespace labels are compared, not changed.** `namespaces.ts` reads `pod-security.kubernetes.io/enforce|audit|warn` and says per mode which workloads would be rejected, recorded or warned about.
- **What admission adds is reported on the owner.** A Pod, ReplicaSet or Job is judged itself only when no judged controller holds its template. Live Pods of the workloads in view are read as well, and a violation a Pod has but its template does not (a webhook-injected `istio-init` with NET_ADMIN) is reported on the owner as "added at admission", without a fix: the template is not where it comes from.
- **Bounded, only while shown.** The "Security" page (Cluster section) checks the namespaces of the filter, at most 20, and watches only while open; the "Security" details section covers workloads and Pods.
- **Trivy Operator is read, never run.** Its kinds (`aquasecurity.github.io`) form a discovered sidebar section `trivy`; a workload's reports are found by the operator's labels (a Deployment's through its live ReplicaSets) and watched by label selector in that namespace only while shown. Counts come from the reports' own `summary`; at most 50 rows (10 in details) are listed. Sextant neither installs Trivy nor triggers a scan.
- **Security findings are an opt-in problem category.** Baseline violations feed the problems screen, the Cluster counter and notifications as the category `security`, off until `AppSettings.notifications.enabledCategories` contains it — one saved setting written by the problems screen's "Security findings" and by Settings → Notifications. Its sources are separate (`sourceKey` adds `|security`): they watch Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs and CronJobs only while the category is on, and they never feed the other categories, the resource map's colours or those categories' caps. Trivy reports are not a problem source. The overview of several clusters does not watch this category (ADR-0077).

## Why

- A server-side dry run under a stricter label was rejected: it needs write rights on Namespaces and Pods, sends a request per workload and still says nothing about why; the standard is public, versioned and small enough to implement and test against fixtures.
- Applying fixes was rejected: a security context change restarts pods and can break images that need root; the patch is offered for review, and the change goes through the editor (with its preview, ADR-0074).
- Running Trivy or fetching vulnerability data was rejected: a scanner needs registry credentials and network access, and Trivy Operator already does it in-cluster.
- Treating Trivy reports as problems was rejected: a background watch of every report moves whole vulnerability lists for a count, and nearly every image has some CVE — the badge would never be zero.
- On by default was rejected: an update would suddenly notify about long-standing Baseline violations on every cluster and add seven watches per connected cluster; opt-in categories (`OPT_IN_CATEGORIES`) start off, so the next one of this kind does not either.

## Consequences

- Policy engines other than Pod Security Admission (Kyverno, Gatekeeper) are not evaluated; the page judges by the standard only.
- A cluster-wide default level set in the admission configuration is not visible through the API: a namespace without labels is described as following the cluster's default.
- With the category on, the problems store holds extra watches of workload kinds per connected cluster; turning it off releases them.
- Tests: `pss.test.ts`, `admission.test.ts`, `trivy.test.ts`, `integration.test.ts`, `notifier.test.tsx`, `security.test.tsx` with fixtures in `src/features/security/fixtures/`.
