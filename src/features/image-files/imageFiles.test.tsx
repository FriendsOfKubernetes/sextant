import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type ImageDir, type ImageEntry, type ImageSummary, type MockBackend } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { getPage } from "../../layout/pages";
import { axeViolations } from "../../test/axe";
import { modeOctal, modeString, parentFolders } from "./format";
import { ImageFilesPage } from "./ImageFilesPage";
import { IMAGE_FILES_PAGE, openImageFiles, resetImageFiles } from "./state";
import "./index";

function entry(path: string, kind: ImageEntry["kind"], extra: Partial<ImageEntry> = {}): ImageEntry {
  return {
    name: path.split("/").pop() ?? "",
    path,
    kind,
    size: kind === "file" ? 10 : 0,
    mode: kind === "directory" ? 0o755 : 0o644,
    uid: 0,
    gid: 0,
    user: "root",
    group: "root",
    mtime: 1_700_000_000,
    link: null,
    layer: 0,
    hasChildren: kind === "directory",
    ...extra,
  };
}

const DIRS: Record<string, ImageDir> = {
  "/": { path: "/", truncated: false, entries: [entry("/etc", "directory")] },
  "/etc": {
    path: "/etc",
    truncated: false,
    entries: [entry("/etc/alias", "symlink", { link: "os-release", mode: 0o777 }), entry("/etc/os-release", "file", { layer: 1 })],
  },
};

const SUMMARY: ImageSummary = {
  sessionId: "",
  reference: "registry.example/team/app:1.0",
  digest: `sha256:${"a".repeat(64)}`,
  platform: { os: "linux", architecture: "amd64", variant: null },
  platforms: [
    { os: "linux", architecture: "amd64", variant: null },
    { os: "linux", architecture: "arm64", variant: null },
  ],
  layers: [
    { digest: `sha256:${"b".repeat(64)}`, size: 2048, mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", createdBy: "RUN step 0", cached: false, files: 2 },
    { digest: `sha256:${"c".repeat(64)}`, size: 512, mediaType: "application/vnd.oci.image.layer.v1.tar+zstd", createdBy: null, cached: true, files: 1 },
  ],
  files: 3,
  skipped: 1,
  credentials: { type: "pullSecret", name: "regcred" },
  unreadableSecrets: ["missing"],
};

let backend: MockBackend;
const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

beforeEach(() => {
  resetAppStore();
  resetImageFiles();
  backend = mockBackend({
    image_files_open_start: () => undefined,
    image_files_read_start: () => undefined,
    image_files_download_start: () => false,
    image_files_stop: () => undefined,
    image_files_list: (args) => DIRS[args.path as string] ?? { path: args.path, truncated: false, entries: [] },
    image_files_search: () => ({ matches: [entry("/etc/os-release", "file")], truncated: false }),
    image_files_resolve: () => "/etc/os-release",
  });
});

async function openTyped(): Promise<string> {
  render(<ImageFilesPage clusterId="c1" />);
  fireEvent.change(screen.getByLabelText("Image reference"), { target: { value: "registry.example/team/app:1.0" } });
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await waitFor(() => expect(calls("image_files_open_start")).toHaveLength(1));
  const [start] = calls("image_files_open_start");
  expect(start).toMatchObject({ source: { type: "reference", reference: "registry.example/team/app:1.0" }, platform: null });
  return start!.streamId as string;
}

describe("image file viewer", () => {
  it("is a page of the Workloads section", () => {
    expect(getPage(IMAGE_FILES_PAGE)).toMatchObject({ section: "workloads", labelKey: "imagefiles:sidebar" });
  });

  it("opens a typed reference, shows its progress, then the image, its tree, a file's facts and text", async () => {
    const id = await openTyped();
    act(() => backend.emit(`image-open:${id}`, { type: "layer", index: 0, layers: 2, state: "downloading", bytes: 1024, total: 2048 }));
    expect(screen.getByText("Layer 1 of 2: 1.00KiB of 2.00KiB")).toBeInTheDocument();
    act(() => backend.emit(`image-open:${id}`, { type: "opened", summary: { ...SUMMARY, sessionId: id } }));
    expect(screen.getByText("Pull secret regcred")).toBeInTheDocument();
    expect(screen.getByText("These pull secrets could not be read: missing")).toBeInTheDocument();
    expect(screen.getByText("1 entry with an unsafe or too long path was left out.")).toBeInTheDocument();
    expect(screen.getByLabelText("Platform")).toHaveValue("linux/amd64");

    const tree = await screen.findByRole("navigation", { name: "Files of the image" });
    fireEvent.click(within(tree).getByRole("button", { name: "Expand etc" }));
    fireEvent.click(await within(tree).findByRole("button", { name: "os-release" }));
    expect(screen.getByText("-rw-r--r-- (0644)")).toBeInTheDocument();
    expect(screen.getByText("Layer 2")).toBeInTheDocument();
    await waitFor(() => expect(calls("image_files_read_start")).toHaveLength(1));
    const read = calls("image_files_read_start")[0]!;
    expect(read).toMatchObject({ sessionId: id, path: "/etc/os-release" });
    act(() =>
      backend.emit(`image-read:${read.streamId as string}`, {
        type: "text",
        file: { path: "/etc/os-release", size: 10, text: "NAME=fake\n", binary: false, truncated: false },
      }),
    );
    expect(screen.getByLabelText("Contents of os-release")).toHaveTextContent("NAME=fake");
    expect(await axeViolations(document.body)).toEqual([]);

    // A symbolic link is not read; its target is shown inside the image.
    fireEvent.click(within(tree).getByRole("button", { name: "alias" }));
    fireEvent.click(await screen.findByRole("button", { name: "Go to the target" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "os-release" })).toBeInTheDocument());
    // The read starts in an effect after the heading renders; a slow runner can see the heading first.
    await waitFor(() => expect(calls("image_files_read_start")).toHaveLength(2));

    // A download asks the backend's save dialog; cancelled, nothing runs.
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(calls("image_files_download_start")).toHaveLength(1));
    expect(calls("image_files_download_start")[0]).toMatchObject({ sessionId: id, path: "/etc/os-release", title: "Save the file from the image" });
  });

  it("searches by path and a binary file is not shown", async () => {
    const id = await openTyped();
    act(() => backend.emit(`image-open:${id}`, { type: "opened", summary: { ...SUMMARY, sessionId: id } }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search by path" }), { target: { value: "release" } });
    const match = await screen.findByRole("button", { name: "/etc/os-release" });
    expect(calls("image_files_search")[0]).toEqual({ sessionId: id, query: "release" });
    fireEvent.click(match);
    await waitFor(() => expect(calls("image_files_read_start")).toHaveLength(1));
    const read = calls("image_files_read_start")[0]!;
    act(() =>
      backend.emit(`image-read:${read.streamId as string}`, {
        type: "text",
        file: { path: "/etc/os-release", size: 10, text: null, binary: true, truncated: false },
      }),
    );
    expect(screen.getByText("This file is binary. Download it to look inside.")).toBeInTheDocument();
  });

  it("closing the image stops its stream; an error is shown", async () => {
    const id = await openTyped();
    act(() => backend.emit(`image-open:${id}`, { type: "error", error: { code: "unauthorized", message: "HTTP 401" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("HTTP 401");
    fireEvent.click(screen.getByRole("button", { name: "Close image" }));
    await waitFor(() => expect(calls("image_files_stop")).toContainEqual({ streamId: id }));
  });

  it("a pod's container header opens its image with the pod as the source", async () => {
    openImageFiles("c1", "demo", "web", "app");
    expect(useAppStore.getState().clusterViews.c1?.view).toBe(IMAGE_FILES_PAGE);
    render(<ImageFilesPage clusterId="c1" />);
    await waitFor(() => expect(calls("image_files_open_start")).toHaveLength(1));
    expect(calls("image_files_open_start")[0]).toMatchObject({
      source: { type: "pod", clusterId: "c1", namespace: "demo", pod: "web", container: "app" },
    });
    expect(screen.getByText("The image of container app in Pod demo/web")).toBeInTheDocument();
  });

  it("the Docker credentials opt-in is off by default and saved in the settings", async () => {
    render(<ImageFilesPage clusterId="c1" />);
    const box = await screen.findByRole("checkbox", { name: "Use my Docker credentials for registries the pull secrets do not cover" });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(backend.settings.imageFiles.dockerCredentials).toBe(true));
  });
});

describe("format", () => {
  it("writes modes as ls does", () => {
    expect(modeString("directory", 0o755)).toBe("drwxr-xr-x");
    expect(modeString("file", 0o4755)).toBe("-rwsr-xr-x");
    expect(modeString("file", 0o2644)).toBe("-rw-r-Sr--");
    expect(modeString("directory", 0o1777)).toBe("drwxrwxrwt");
    expect(modeOctal(0o644)).toBe("0644");
    expect(parentFolders("/usr/bin/sh")).toEqual(["/", "/usr", "/usr/bin"]);
  });
});
