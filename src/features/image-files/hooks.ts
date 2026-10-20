// The viewer's backend streams, each through `openStream` (ADR-0078): opening an image (the image stays open in the
// backend under the stream's id until the stream is closed), reading a file for the viewer, and a download.
import { useEffect, useState } from "react";
import {
  api,
  openStream,
  type ImageFileText,
  type ImageOpenEvent,
  type ImagePlatform,
  type ImageReadEvent,
  type ImageSource,
  type ImageSummary,
} from "../../api";
import type { TransferEvent } from "../../api/generated/TransferEvent";

export type OpenStatus =
  | { status: "opening"; progress: ImageOpenEvent | null }
  | { status: "open"; summary: ImageSummary }
  | { status: "error"; error: unknown };

/** Opens `source` while the caller is mounted with the same `key`; closing (unmount, a new key) closes the image. */
export function useOpenImage(source: ImageSource | null, platform: ImagePlatform | null, key: string): OpenStatus | null {
  const [state, setState] = useState<OpenStatus | null>(null);
  useEffect(() => {
    if (!source) {
      setState(null);
      return;
    }
    setState({ status: "opening", progress: null });
    return openStream<ImageOpenEvent>({
      start: (id, channel) => api.imageFiles.openStart(source, platform, id, channel),
      stop: (id) => api.imageFiles.stop(id),
      onEvent: (event) => {
        if (event.type === "opened") setState({ status: "open", summary: event.summary });
        else if (event.type === "error") setState({ status: "error", error: event.error });
        else setState({ status: "opening", progress: event });
      },
      onStartError: (error) => setState({ status: "error", error }),
    });
    // `key` names the request; `source` and `platform` are read when it changes.
  }, [key]);
  return state;
}

export type TextStatus =
  | { status: "reading"; done: number; total: number }
  | { status: "done"; file: ImageFileText }
  | { status: "error"; error: unknown };

/** Reads the first MiB of `path` (a file) of the open image `sessionId`; `null` reads nothing. */
export function useFileText(sessionId: string, path: string | null): TextStatus | null {
  const [state, setState] = useState<TextStatus | null>(null);
  useEffect(() => {
    if (path === null) {
      setState(null);
      return;
    }
    setState({ status: "reading", done: 0, total: 0 });
    return openStream<ImageReadEvent>({
      start: (id, channel) => api.imageFiles.readStart(sessionId, path, id, channel),
      stop: (id) => api.imageFiles.stop(id),
      onEvent: (event) => {
        if (event.type === "text") setState({ status: "done", file: event.file });
        else if (event.type === "error") setState({ status: "error", error: event.error });
        else setState({ status: "reading", done: event.bytes, total: event.total });
      },
      onStartError: (error) => setState({ status: "error", error }),
    });
  }, [sessionId, path]);
  return state;
}

export type DownloadStatus =
  | { status: "running"; done: number; total: number }
  | { status: "done" }
  | { status: "error"; error: unknown };

/**
 * Downloads `path` of the open image after the backend's save dialog; `update` gets the progress (nothing when the
 * dialog was cancelled). Returns the function that cancels it.
 */
export function startDownload(
  sessionId: string,
  path: string,
  title: string,
  update: (status: DownloadStatus | null) => void,
): () => void {
  const close = openStream<TransferEvent>({
    start: async (id, channel) => {
      const started = await api.imageFiles.downloadStart(sessionId, path, title, id, channel);
      if (!started) {
        update(null);
        close();
      }
    },
    stop: (id) => api.imageFiles.stop(id),
    onEvent: (event) => {
      if (event.type === "progress") update({ status: "running", done: event.transferred, total: event.total ?? 0 });
      else if (event.type === "done") update({ status: "done" });
      else update({ status: "error", error: event.error });
    },
    onStartError: (error) => update({ status: "error", error }),
  });
  return close;
}
