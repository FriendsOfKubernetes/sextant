# Sextant's own extensions

These are extensions that Sextant's authors write, in this repository. They are installed from the extension catalog
like anyone else's (ADR-0130) and use only the public extension API (ADR-0139), so each one is also a worked example
for other authors. The guide to writing one is the wiki page
[Writing extensions](https://github.com/FriendsOfKubernetes/sextant/wiki/Writing-extensions).

| Extension | Folder | Version | Needs | What it is |
|---|---|---|---|---|
| Argo Rollouts (`sextant.argo-rollouts`) | [`argo-rollouts/`](argo-rollouts/README.md) | 1.4.0 | Sextant 0.30 (`sextantApi` 4) | Rollouts, their analysis and experiments, with promote, abort, retry, pause and resume |
| Argo Workflows (`sextant.argo-workflows`) | [`argo-workflows/`](argo-workflows/README.md) | 1.1.0 | Sextant 0.30 (`sextantApi` 4) | Workflows with their step tree and pods' logs, cron workflows and templates, with Suspend, Resume, Stop and Terminate |
| Flux (`sextant.flux`) | [`flux/`](flux/README.md) | 1.4.0 | Sextant 0.30 (`sextantApi` 4) | Flux CD's sources, Kustomizations, HelmReleases, image automation and notifications, with Reconcile, Suspend and Resume |
| Argo CD (`sextant.argo-cd`) | [`argo-cd/`](argo-cd/README.md) | 1.4.0 | Sextant 0.30 (`sextantApi` 4) | Argo CD's Applications, ApplicationSets and AppProjects: sync, health, resources, history, actions, diff and UI |
| Rook Ceph (`sextant.rook-ceph`) | [`rook-ceph/`](rook-ceph/README.md) | 1.2.0 | Sextant 0.29 (`sextantApi` 3) | A view and control panel of Rook Ceph clusters |
| Knative (`sextant.knative`) | [`knative/`](knative/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | Knative Serving's Services, Configurations, Revisions and Routes and Eventing's brokers, triggers, channels, flows and sources, read-only, with their problems |
| CloudNativePG (`sextant.cnpg`) | [`cnpg/`](cnpg/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | PostgreSQL clusters, backups, scheduled backups and poolers, with their problems |
| Operator Lifecycle Manager (`sextant.olm`) | [`olm/`](olm/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | Subscriptions, ClusterServiceVersions, InstallPlans, catalogs and OLM v1 extensions, read-only, with their problems |
| Strimzi (`sextant.strimzi`) | [`strimzi/`](strimzi/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | Kafka clusters, node pools, topics, users, Connect, connectors and MirrorMaker 2, with their problems |
| External Secrets (`sextant.external-secrets`) | [`external-secrets/`](external-secrets/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | ExternalSecrets, ClusterExternalSecrets, stores and PushSecrets, read-only, with their problems |
| NVIDIA GPU Operator (`sextant.gpu-operator`) | [`gpu-operator/`](gpu-operator/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | ClusterPolicies, NVIDIADrivers, their components and GPU nodes, read-only, with their problems |
| JobSet (`sextant.jobset`) | [`jobset/`](jobset/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | JobSets with their replicated jobs, Jobs, pods, restarts and failures |
| KubeRay (`sextant.kuberay`) | [`kuberay/`](kuberay/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | RayClusters, RayJobs and RayServices with their pods and logs |
| KServe (`sextant.kserve`) | [`kserve/`](kserve/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | InferenceServices with the runtime KServe chooses, serving runtimes, inference graphs and trained models |
| Velero (`sextant.velero`) | [`velero/`](velero/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | Velero's backups, schedules, restores and storage locations, with Back up namespace and Restore from this backup |
| Kueue (`sextant.kueue`) | [`kueue/`](kueue/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | ClusterQueues with their quota against what is reserved and in use, LocalQueues, Workloads and why they wait, and the queue of every job Kueue queues, read-only, with their problems |
| Kyverno (`sextant.kyverno`) | [`kyverno/`](kyverno/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | ClusterPolicies and Policies with their mode, policy reports, and the policy results of every object, read-only, with opt-in problems |
| Dynamic Resource Allocation (`sextant.dra`) | [`dra/`](dra/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | ResourceClaims with their state, requests and devices, claim templates, device classes, ResourceSlices, the Devices page and the devices of Pods and Nodes, read-only, with their problems |
| Sealed Secrets (`sextant.sealed-secrets`) | [`sealed-secrets/`](sealed-secrets/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | SealedSecrets with their unseal state, scope, target Secret and sealed keys by name, and the controller with its sealing keys, read-only, with opt-in problems |
| Vertical Pod Autoscaler (`sextant.vpa`) | [`vpa/`](vpa/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | VerticalPodAutoscalers with their state, update mode and recommendation against the target's template with what a new pod would get, their checkpoints and components, and the VPAs of every workload, read-only, with their problems |
| Prometheus Operator (`sextant.prometheus-operator`) | [`prometheus-operator/`](prometheus-operator/README.md) | 1.1.0 | Sextant 0.30.1 (`sextantApi` 5) | ServiceMonitors, PodMonitors and Probes with what they select and which Prometheus picks them up, PrometheusRules, Prometheuses and Alertmanagers, read-only, with opt-in problems |
| Cluster API (`sextant.cluster-api`) | [`cluster-api/`](cluster-api/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | Clusters, ClusterClasses, KubeadmControlPlanes, MachineDeployments, MachineSets, Machines, MachineHealthChecks and ClusterResourceSets with their state, the chain from a Cluster down to its Machines and their Nodes, and the workload cluster opened on a click, read-only, with their problems |
| k3s / RKE2 (`sextant.k3s`) | [`k3s/`](k3s/README.md) | 1.1.0 | Sextant 0.30.1 (`sextantApi` 5) | The distribution of a k3s or RKE2 cluster with its nodes, bundled components and ServiceLB, helm-controller's HelmCharts with their install Job and its logs, HelmChartConfigs, Addons, etcd snapshots and a k3s / RKE2 block on Nodes, read-only, with their problems |
| Traefik (`sextant.traefik`) | [`traefik/`](traefik/README.md) | 1.1.0 | Sextant 0.30.1 (`sextantApi` 5) | IngressRoutes (HTTP, TCP, UDP), Middlewares, TraefikServices, TLSOptions, TLSStores and ServersTransports of `traefik.io` and `traefik.containo.us` with their routes, chains and settings and every reference checked, read-only, with opt-in problems |
| Contour (`sextant.contour`) | [`contour/`](contour/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | HTTPProxies with their state as Contour writes it and its first error, virtual host and TLS, routes with each service's share, includes and the delegation tree, TLSCertificateDelegations and ExtensionServices, read-only, with their problems |
| OpenShift (`sextant.openshift`) | [`openshift/`](openshift/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | Routes with their admission and backends, DeploymentConfigs with their rollouts and triggers, BuildConfigs and Builds with their pods' logs, ImageStreams with their tags and Projects, with Rollout latest and Start build, and their problems |
| Trivy (`sextant.trivy`) | [`trivy/`](trivy/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | Trivy Operator's vulnerability, configuration audit, exposed secret, RBAC, infrastructure, compliance and SBOM reports with their severity counts and most severe findings, and every workload's image scans, read-only |
| KEDA (`sextant.keda`) | [`keda/`](keda/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | ScaledObjects, ScaledJobs and (Cluster)TriggerAuthentications with their state in plain words, target, replica range, triggers and the HPA KEDA manages, read-only |
| Karpenter (`sextant.karpenter`) | [`karpenter/`](karpenter/README.md) | 1.1.0 | Sextant 0.30.1 (`sextantApi` 5) | NodePools with their usage against their limits, disruption settings and recent disruptions, NodeClaims with their launch and disruption, and node classes, read-only |
| cert-manager (`sextant.cert-manager`) | [`cert-manager/`](cert-manager/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | Certificates, CertificateRequests, Issuers, ClusterIssuers, Orders and Challenges with their state and reasons in plain words and the issuance chain, read-only, with the problems of Certificates that are not ready, fail to renew, expire soon or have expired |
| Service mesh (`sextant.mesh`) | [`mesh/`](mesh/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | Istio's and Linkerd's objects in two sections with their routes and policies in plain words, the Request routing page, every workload's mesh membership, mTLS mode and who may call it, and Istio configuration mistakes as problems, read-only |
| Crossplane (`sextant.crossplane`) | [`crossplane/`](crossplane/README.md) | 1.0.0 | Sextant 0.30 (`sextantApi` 4) | Composite Resource Definitions, Compositions, Providers, Configurations and Functions with their state, the Composite Resources page, and the chain Claim → composite → managed resources in the details of any kind, read-only, with the problems of claims and composites |

## The documents of an extension

Each extension's folder holds two documents, both in English (ADR-0046). They are written for its users first, then
for whoever changes it.

**`README.md`** has these sections, in this order. A section with nothing to say still stands, with one line saying
so ("None.").

| Section | What goes in it |
|---|---|
| `# <Name>` | One paragraph: what it is for, its id, and the ADRs that decide how it is built. |
| `## At a glance` | A table: id, version, `sextantApi` and the oldest Sextant that runs it, where it is released, the catalog. |
| `## What it adds` | Every page, details section, action, column and dock action, by place in Sextant's window, each with its manifest id in backticks. |
| `## Permissions` | What it reads, changes and deletes, each with why; what Sextant confirms; when an update asks for consent again. |
| `## Problems` | A table of every problem rule: id, kind, when it holds, grace, and whether another object tells it. |
| `## Metrics` | A table of every metric query: id and what it reads. |
| `## Commands` | A table of every command: id, its words, where it runs, and whether it changes something. |
| `## Changes it makes` | What it changes in a cluster, and how each change is shown and confirmed before it is sent. |
| `## What it does not do` | What it leaves to other tools, on purpose. |
| `## Requirements and limits` | What must be installed or running for it to work (operators, toolboxes, metrics), the versions it was checked against, and what it was not tried on. |
| `## Troubleshooting` | What a user sees when something it needs is missing, and what to do. |
| `## Development` | How to build, test and check it, and how it is released. |

**`CHANGELOG.md`** has one `## <version> — <date>` section per release, newest first, saying what changed for
users. It also says what an update asks for again.

`npm run check` runs `scripts/check-extension-docs.mjs`, which keeps the documents in step with the manifest. It
checks that:
- both files exist and the sections are there, in order;
- every manifest id listed above appears in `README.md` in backticks;
- `CHANGELOG.md` has a section for the manifest's version.

## Adding an extension

1. Make a folder here, with its own `package.json` like `rook-ceph/package.json`, a manifest whose id starts with
   `sextant.`, and `src/`.
2. Add its texts in every language Sextant has (ADR-0140).
3. Write its `README.md` and `CHANGELOG.md` as above, and add its row to the table at the top.
4. `npm run sdk:check` type-checks, tests and builds every folder here. A test in
   `crates/sextant-core/src/extensions/` checks that Sextant accepts its manifest.
5. It is released from
   [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions) with that
   repository's key. Its workflow "Release a Sextant extension" builds the package from a commit or tag of this
   repository; add the folder's name to that workflow's `extension` choices.
