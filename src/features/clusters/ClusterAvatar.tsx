// A cluster's icon: its own picture, or one or two characters (its own text or the initials) on the label color.
// The letters are light or dark, whichever reads better on that color. Drawn in the rail and as the preview in the
// cluster settings; decorative (the name is said by the caller). The letters are drawn by CSS from `data-text`, not as
// text in the page: the rail button's accessible name is the cluster name, and visible text inside it that the name
// does not contain fails WCAG 2.5.3 Label in Name (axe `label-content-name-mismatch`, #186).
import type { CSSProperties } from "react";
import type { AppSettings, ClusterInfo } from "../../api";
import { colorOf, iconOf, initialsColorOn } from "./clusterSettings";

export interface ClusterAvatarProps {
  cluster: ClusterInfo;
  settings: AppSettings | null;
  /** Side in pixels (40 in the rail). */
  size?: number;
}

export function ClusterAvatar({ cluster, settings, size = 40 }: ClusterAvatarProps) {
  const icon = iconOf(cluster, settings);
  const color = colorOf(cluster, settings);
  const style = {
    "--cluster-color": color,
    "--cluster-text": initialsColorOn(color),
    width: size,
    height: size,
    fontSize: Math.round(size * 0.35),
  } as CSSProperties;
  return (
    <span
      className={icon.kind === "image" ? "cluster-avatar cluster-avatar--image" : "cluster-avatar"}
      style={style}
      aria-hidden="true"
    >
      {icon.kind === "image" ? (
        <img className="cluster-avatar__image" src={icon.src} alt="" draggable={false} />
      ) : (
        <span className="cluster-avatar__text" data-text={icon.text} />
      )}
    </span>
  );
}
