// Traefik (#232): the discovered sidebar section "Traefik" — IngressRoutes (HTTP, TCP, UDP), Middlewares,
// TraefikServices, TLSOptions, TLSStores and ServersTransports, of `traefik.io` and, where still served, of
// `traefik.containo.us`. Traefik writes no status on these kinds, so the state shown is what the references find:
// a Middleware, Service, TraefikService or TLSOption that does not exist breaks its object (a problem of the opt-in
// category `traefik`; a Secret only in the open details, which alone list Secrets), a reference into another
// namespace depends on the provider's `allowCrossNamespace` and stays open. The "Diagnose" action follows an
// IngressRoute to its Services and pods (diagnose/traefik.ts). Read-only (ADR-0108, #232).
import { registerSectionBadge } from "../../layout/sectionBadges";
import "../cert-manager/cert-manager.css";
import { useTraefikProblemCount } from "./badge";
import "./provider";
import "./register";

registerSectionBadge("traefik", useTraefikProblemCount, { tone: "danger", labelKey: "traefik:badge" });
