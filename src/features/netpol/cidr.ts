// IPv4 and IPv6 addresses and CIDR blocks, for `ipBlock` peers (NetworkPolicy), CIDR rules (Cilium) and `nets`
// (Calico). Pure; an address or block that does not parse is `null`, and the callers treat it as matching nothing.
//
//   parseIp("10.0.0.1")              → { family: 4, value: 167772161n }
//   parseCidr("fd00::/8")            → { family: 6, base: …, prefix: 8 }
//   cidrContains(cidr, ip)           → whether `ip` is inside (an address of the other family never is)

export interface Ip {
  family: 4 | 6;
  value: bigint;
}

export interface Cidr {
  family: 4 | 6;
  /** The block's first address (host bits cleared). */
  base: bigint;
  prefix: number;
}

const BITS = { 4: 32, 6: 128 } as const;

function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseIpv6(text: string): bigint | null {
  if (text.includes("%")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string): string[] | null => (half === "" ? [] : half.split(":"));
  let head = groups(halves[0]!);
  let tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return null;
  // An embedded IPv4 address at the end ("::ffff:10.0.0.1") stands for the last two groups.
  const last = (tail.length > 0 ? tail : head).at(-1);
  if (last?.includes(".")) {
    const v4 = parseIpv4(last);
    if (v4 === null) return null;
    const words = [((v4 >> 16n) & 0xffffn).toString(16), (v4 & 0xffffn).toString(16)];
    if (tail.length > 0) tail = [...tail.slice(0, -1), ...words];
    else head = [...head.slice(0, -1), ...words];
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  let value = 0n;
  for (const group of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

export function parseIp(text: string): Ip | null {
  const trimmed = text.trim();
  if (trimmed.includes(":")) {
    const value = parseIpv6(trimmed);
    return value === null ? null : { family: 6, value };
  }
  const value = parseIpv4(trimmed);
  return value === null ? null : { family: 4, value };
}

export function parseCidr(text: string): Cidr | null {
  const trimmed = text.trim();
  const slash = trimmed.indexOf("/");
  const ip = parseIp(slash < 0 ? trimmed : trimmed.slice(0, slash));
  if (!ip) return null;
  const bits = BITS[ip.family];
  let prefix: number = bits;
  if (slash >= 0) {
    const p = trimmed.slice(slash + 1);
    if (!/^\d{1,3}$/.test(p)) return null;
    prefix = Number(p);
    if (prefix > bits) return null;
  }
  const host = BigInt(bits - prefix);
  return { family: ip.family, base: (ip.value >> host) << host, prefix };
}

export function cidrContains(cidr: Cidr, ip: Ip): boolean {
  if (cidr.family !== ip.family) return false;
  const host = BigInt(BITS[cidr.family] - cidr.prefix);
  return ip.value >> host === cidr.base >> host;
}

/** Whether `ip` (text) is inside `cidr` (text); `null` when either does not parse. */
export function inCidr(cidr: string, ip: string): boolean | null {
  const c = parseCidr(cidr);
  const a = parseIp(ip);
  return c && a ? cidrContains(c, a) : null;
}
