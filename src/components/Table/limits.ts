// How much a resource table watches (#157). A table keeps at most `TABLE_MAX_OBJECTS` objects (the backend counts
// the rest by uid and the table says "Showing the first N of M"); before it watches a namespaced kind in every
// namespace it counts the objects (one metadata request of one object) and asks first when there are more than
// `TABLE_GUARD_OBJECTS`. The first list arrives in parts, so rows show while a big list loads.
import type { WatchOptions } from "../../api";

export const TABLE_MAX_OBJECTS = 20_000;
export const TABLE_GUARD_OBJECTS = 10_000;
/** How long a table waits for the count before it watches anyway (the backend gives up on a count after 10 s). */
export const COUNT_WAIT_MS = 3_000;
/** How long a table waits after the last keystroke before it sends the search's selector terms to the API server. */
export const SERVER_FILTER_DELAY_MS = 400;

export const TABLE_WATCH_OPTIONS: WatchOptions = Object.freeze({ progressive: true, maxObjects: TABLE_MAX_OBJECTS });
