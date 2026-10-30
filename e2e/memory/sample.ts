// Node-side memory samples of the running app (Linux only): PSS + SwapPss of the Sextant process and of every process
// under it (WebKit's web and network processes), read from /proc/<pid>/smaps_rollup. PSS splits shared pages between
// the processes that map them, so the sum over the tree is what the app costs; SwapPss counts what the kernel moved
// to swap, so a machine short of memory does not make the app look smaller than it is.
import { readdirSync, readFileSync, realpathSync } from "node:fs";

/** Kilobytes of one process, as the kernel reports them. */
export interface ProcessMemory {
  pid: number;
  name: string;
  pssKb: number;
  swapPssKb: number;
}

/** One sample: every process of the tree, and the totals by process name. */
export interface MemorySample {
  at: string;
  processes: ProcessMemory[];
  /** MB (PSS + SwapPss) by process name: `sextant`, `WebKitWebProces`, `WebKitNetworkPr` (names are cut at 15). */
  byName: Record<string, number>;
  totalMb: number;
}

function pids(): number[] {
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number);
}

function read(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    // The process ended or is not ours.
    return null;
  }
}

function parentOf(pid: number): number | null {
  const stat = read(`/proc/${pid}/stat`);
  if (!stat) return null;
  // `pid (comm) state ppid …`; comm may hold spaces and parentheses, so read after the last ")".
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(fields[1]);
}

/** The pid of the process running `app` (its executable), or `null`; more than one (a leftover run) is an error. */
export function appPid(app: string): number | null {
  const target = realpathSync(app);
  const found = pids().filter((pid) => {
    try {
      return realpathSync(`/proc/${pid}/exe`) === target;
    } catch {
      // Not ours or gone.
      return false;
    }
  });
  if (found.length > 1) throw new Error(`${found.length} processes run ${app} (${found.join(", ")}): stop the leftovers`);
  return found[0] ?? null;
}

/** `root` and every process below it. */
export function processTree(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const pid of pids()) {
    const parent = parentOf(pid);
    if (parent !== null) children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const tree: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    tree.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return tree;
}

function memoryOf(pid: number): ProcessMemory | null {
  const rollup = read(`/proc/${pid}/smaps_rollup`);
  const name = read(`/proc/${pid}/comm`)?.trim();
  if (!rollup || !name) return null;
  const field = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(rollup)?.[1] ?? 0);
  return { pid, name, pssKb: field("Pss"), swapPssKb: field("SwapPss") };
}

export function sampleTree(root: number): MemorySample {
  const processes = processTree(root)
    .map(memoryOf)
    .filter((p): p is ProcessMemory => p !== null);
  const byName: Record<string, number> = {};
  for (const p of processes) byName[p.name] = (byName[p.name] ?? 0) + (p.pssKb + p.swapPssKb) / 1024;
  const totalMb = Object.values(byName).reduce((a, b) => a + b, 0);
  return { at: new Date().toISOString(), processes, byName, totalMb };
}

/** The sample whose total is the median of `samples` (an odd count gives a real sample, not an average). */
export function median(samples: MemorySample[]): MemorySample {
  const sorted = [...samples].sort((a, b) => a.totalMb - b.totalMb);
  return sorted[Math.floor(sorted.length / 2)];
}
