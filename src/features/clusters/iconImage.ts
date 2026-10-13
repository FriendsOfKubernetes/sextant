// A picture chosen for a cluster icon: checked, then fitted into a small PNG kept in the settings
// (`ClusterIcon.image.dataUrl`). Everything happens in the page: the file comes from `<input type="file">`, nothing
// is copied to disk and no backend command is involved.

/** Side of the stored PNG, in pixels. */
export const ICON_IMAGE_SIZE = 96;
/** Largest file accepted. */
export const ICON_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** The value of the `accept` attribute of the file input. */
export const ICON_IMAGE_ACCEPT = "image/png,image/jpeg,image/svg+xml,image/webp,.png,.jpg,.jpeg,.svg,.webp";

const TYPES = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);
const EXTENSIONS = /\.(png|jpe?g|svg|webp)$/i;

/** `type` — not a supported picture (or does not decode); `size` — over 5 MB; `read` — the file cannot be read. */
export type IconImageErrorCode = "type" | "size" | "read";

export class IconImageError extends Error {
  readonly code: IconImageErrorCode;
  constructor(code: IconImageErrorCode) {
    super(`cluster icon image: ${code}`);
    this.name = "IconImageError";
    this.code = code;
  }
}

/**
 * Reads a PNG, JPEG, SVG or WebP file and returns it fitted into a 96×96 transparent square (proportions kept,
 * centered) as `data:image/png;base64,…`. Rejects with `IconImageError`.
 */
export async function readIconImage(file: File): Promise<string> {
  // Some systems report no MIME type; the extension decides then.
  const supported = file.type ? TYPES.has(file.type) : EXTENSIONS.test(file.name);
  if (!supported) throw new IconImageError("type");
  if (file.size > ICON_IMAGE_MAX_BYTES) throw new IconImageError("size");

  const source = await readAsDataUrl(file);
  const image = await loadImage(source);
  // An SVG without its own size reports 0×0: draw it as a square.
  const width = image.naturalWidth || ICON_IMAGE_SIZE;
  const height = image.naturalHeight || ICON_IMAGE_SIZE;
  const scale = Math.min(ICON_IMAGE_SIZE / width, ICON_IMAGE_SIZE / height);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = ICON_IMAGE_SIZE;
  canvas.height = ICON_IMAGE_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new IconImageError("read");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  try {
    context.drawImage(image, Math.round((ICON_IMAGE_SIZE - w) / 2), Math.round((ICON_IMAGE_SIZE - h) / 2), w, h);
    const result = canvas.toDataURL("image/png");
    if (!result.startsWith("data:image/png;base64,")) throw new IconImageError("read");
    return result;
  } catch (err) {
    if (err instanceof IconImageError) throw err;
    throw new IconImageError("read");
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string" ? resolve(reader.result) : reject(new IconImageError("read"));
    reader.onerror = () => reject(new IconImageError("read"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    // The file says it is a picture but does not decode as one.
    image.onerror = () => reject(new IconImageError("type"));
    image.src = src;
  });
}
