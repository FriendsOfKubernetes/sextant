// Form fields of the connectivity page and the policy map.
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={wide ? "np-field np-field--grow" : "np-field"}>
      <span className="np-field__label">{label}</span>
      {children}
    </label>
  );
}

/** A namespace: a list when Namespaces can be read, else typed (taken when the field loses focus). */
export function NamespaceField({
  label,
  value,
  namespaces,
  onChange,
}: {
  label: string;
  value: string;
  namespaces: string[] | null;
  onChange: (ns: string) => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState(value);
  if (namespaces === null) {
    return (
      <Field label={label}>
        <input
          type="text"
          value={typed}
          spellCheck={false}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={() => onChange(typed.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") onChange(typed.trim());
          }}
        />
      </Field>
    );
  }
  const options = value && !namespaces.includes(value) ? [value, ...namespaces] : namespaces;
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("netpol:form.choose")}</option>
        {options.map((ns) => (
          <option key={ns} value={ns}>
            {ns}
          </option>
        ))}
      </select>
    </Field>
  );
}
