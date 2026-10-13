// The app's button: one height for every kind (32 px, `--control-height`), 28 px in table rows and dense lists
// (`size="compact"`), text that never wraps and a button that never shrinks in a flex row (styles: `.btn` in
// src/styles/global.css; places that still write `className="btn"` get the same look).
//
//   <Button variant="primary" onClick={apply}>{t("…apply")}</Button>
//   <Button icon="logs">{t("logs:action")}</Button>                       // icon + visible text
//   <Button iconOnly icon="eye" label={t("…showKey", { key })} aria-pressed={open} />
//
// An icon-only button has no visible text, so `label` is required: it becomes the accessible name (`aria-label`)
// and the tooltip (`title`).
import type { ButtonHTMLAttributes, Ref } from "react";
import { renderIcon, type IconName } from "./icons";

type BaseProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger";
  size?: "regular" | "compact";
  /** An icon of the set (src/components/icons.tsx), shown before the text. */
  icon?: IconName;
  ref?: Ref<HTMLButtonElement>;
};

export type ButtonProps = BaseProps &
  (
    | { iconOnly: true; icon: IconName; /** Accessible name and tooltip. */ label: string }
    | { iconOnly?: false; label?: undefined }
  );

export function Button({
  variant = "default",
  size = "regular",
  icon,
  iconOnly,
  label,
  className,
  type = "button",
  title,
  children,
  ref,
  ...props
}: ButtonProps) {
  let classes = "btn";
  if (variant !== "default") classes += ` btn--${variant}`;
  if (size === "compact") classes += " btn--compact";
  if (iconOnly) classes += " btn--icon";
  if (className) classes += ` ${className}`;
  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? (title ?? label) : title}
      {...props}
    >
      {renderIcon(icon)}
      {!iconOnly && children}
    </button>
  );
}
