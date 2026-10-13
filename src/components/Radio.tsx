// A radio button drawn with the theme's colors, for the same reason as `Checkbox`: a native one follows the toolkit's
// theme (WebKitGTK with a dark GTK theme draws it black in the light window). Same API as `<input type="radio">`;
// wrap it in a <label> with the text, and the group in an element with `role="radiogroup"` and `aria-label`.
//
//   <label><Radio name="theme" checked={theme === "dark"} onChange={() => setTheme("dark")} />{t("…dark")}</label>
import type { InputHTMLAttributes, Ref } from "react";
import "./radio.css";

export type RadioProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { ref?: Ref<HTMLInputElement> };

export function Radio({ className, ref, ...props }: RadioProps) {
  return <input ref={ref} type="radio" className={className ? `radio ${className}` : "radio"} {...props} />;
}
