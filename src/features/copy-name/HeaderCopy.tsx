// The details panel's header (#274): an icon-only button right after the object's name that copies the plain name,
// and one after the namespace line that copies the plain namespace. Same clipboard path and confirmation as "Copy
// namespace/name" (`copyText`); the accessible name and the tooltip say what is copied (ADR-0034).
import { useTranslation } from "react-i18next";
import { Button } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { copyText } from "./clipboard";

export function CopyNameButton({ objectRef }: DetailsSectionProps) {
  const { t } = useTranslation();
  return (
    <Button
      iconOnly
      size="compact"
      icon="copy"
      label={t("copyname:header.copyName")}
      onClick={() => void copyText(objectRef.name)}
    />
  );
}

export function CopyNamespaceButton({ objectRef }: DetailsSectionProps) {
  const { t } = useTranslation();
  const namespace = objectRef.namespace;
  if (!namespace) return null;
  return (
    <Button
      iconOnly
      size="compact"
      icon="copy"
      label={t("copyname:header.copyNamespace")}
      onClick={() => void copyText(namespace)}
    />
  );
}
