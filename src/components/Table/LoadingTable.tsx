// A table that has nothing to show yet: its title in the header and the loading indicator.
import { useTranslation } from "react-i18next";
import { LoadingIndicator } from "../LoadingIndicator";
import "./table.css";

export function LoadingTable({ title, since }: { title: string; since?: number }) {
  const { t } = useTranslation();
  return (
    <section className="rt" aria-label={title} aria-busy="true">
      <header className="rt__header">
        <h2 className="rt__title">{title}</h2>
      </header>
      <LoadingIndicator className="rt__loading" text={t("resources:loading.kind", { kind: title })} since={since} />
    </section>
  );
}
