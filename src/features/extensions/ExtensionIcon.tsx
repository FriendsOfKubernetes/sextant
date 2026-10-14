// The extension's icon: a name from Sextant's set (an unknown or missing one shows the default).
import { Icon, isIconName } from "../../components";
import { DEFAULT_ENTRY_ICON } from "../../resources/registry";

export function ExtensionIcon({ name, size = 20 }: { name: string | undefined; size?: number }) {
  return (
    <span className="ext-icon">
      <Icon name={name !== undefined && isIconName(name) ? name : DEFAULT_ENTRY_ICON} size={size} />
    </span>
  );
}
