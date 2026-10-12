// A checkbox drawn with the theme's colors. A native checkbox follows the toolkit's theme instead (WebKitGTK with a
// dark GTK theme draws it black in the light window), so it is drawn here: `appearance: none` + theme tokens.
//
//   <Checkbox checked={value} onChange={(e) => setValue(e.target.checked)} aria-label={t("…")} />
import type { InputHTMLAttributes, Ref } from "react";
import "./checkbox.css";

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { ref?: Ref<HTMLInputElement> };

export function Checkbox({ className, ref, ...props }: CheckboxProps) {
  return <input ref={ref} type="checkbox" className={className ? `checkbox ${className}` : "checkbox"} {...props} />;
}
