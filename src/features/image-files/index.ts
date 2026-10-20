// Image file viewer (#216, ADR-0103): a container image's files read straight from its registry — no exec into a
// container, no pull on a node, no local docker. The registry client, credentials and indexing are in the backend
// (`image_files_*`, window only); this feature is the page in the Workloads section (also reachable from the palette as
// a page) and the "Browse image files" button of a pod's container header (`ContainerTools`, `openImageFiles`).
import { registerPage } from "../../layout/pages";
import "./imageFiles.css";
import { ImageFilesPage } from "./ImageFilesPage";
import { IMAGE_FILES_PAGE } from "./state";

registerPage({
  id: IMAGE_FILES_PAGE,
  section: "workloads",
  // After right-sizing (80).
  order: 85,
  labelKey: "imagefiles:sidebar",
  icon: "imageFiles",
  Component: ImageFilesPage,
});

export { IMAGE_FILES_PAGE, openImageFiles } from "./state";
