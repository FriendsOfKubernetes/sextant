// emberstack Reflector (#241): mirrored Secrets and ConfigMaps. Reflector defines no kind, so there is no sidebar
// section: a "Reflection" column on the Secret and ConfigMap tables, a "Reflection" details section on objects that
// carry its annotations (a mirror's source and state — in sync, stale, source missing, not allowed; a source's allowed
// and automatic namespaces and its mirrors), and the opt-in problems category `reflector` (stale mirrors and mirrors
// whose source is missing). Only annotations, names and resourceVersions are read — never a Secret's values — from
// bounded metadata-only lists (store.ts). Read-only (ADR-0110).
import "./provider";
import "./reflector.css";
import "./register";
