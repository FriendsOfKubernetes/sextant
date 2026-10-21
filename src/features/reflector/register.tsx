// Reflector (#241) adds no kind: its annotations live on Secrets and ConfigMaps. So it adds a "Reflection" column to
// their tables and a "Reflection" details section (drawn only for objects with Reflector's annotations), after the
// generic fields and the TLS certificate section.
import { registerDetailsSection } from "../../layout/details/registry";
import { extendColumns } from "../../resources";
import { reflectionColumn } from "./columns";
import { ReflectionSection } from "./details";
import { reflectedKind } from "./model";

extendColumns({ group: "", kind: "Secret" }, [reflectionColumn]);
extendColumns({ group: "", kind: "ConfigMap" }, [reflectionColumn]);

registerDetailsSection({
  id: "reflector",
  order: 23,
  appliesTo: (kind) => reflectedKind(kind) !== undefined,
  Component: ReflectionSection,
});
