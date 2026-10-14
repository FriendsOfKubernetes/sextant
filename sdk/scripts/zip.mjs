// A small zip writer (deflate, UTF-8 names, no folders, no extra fields) and reader for the SDK's packages and its
// tests. Entries get a fixed date so the same files always give the same archive.
import { Buffer } from "node:buffer";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const DOS_TIME = 0;
const UTF8 = 1 << 11;

/** A zip archive of `entries` (`{path, data}`, `/`-separated paths). */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { path, data } of entries) {
    const name = Buffer.from(path, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The entries of an archive written by `zip` (or any plain zip without zip64): `[{path, data, mode}]`. */
export function unzip(buffer) {
  const endAt = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error("not a zip archive");
  const count = buffer.readUInt16LE(endAt + 10);
  let at = buffer.readUInt32LE(endAt + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central directory");
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extra = buffer.readUInt16LE(at + 30);
    const comment = buffer.readUInt16LE(at + 32);
    const mode = buffer.readUInt32LE(at + 38) >>> 16;
    const local = buffer.readUInt32LE(at + 42);
    const path = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const localName = buffer.readUInt16LE(local + 26);
    const localExtra = buffer.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    const body = buffer.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    if (crc32(data) !== crc) throw new Error(`${path}: bad checksum`);
    entries.push({ path, data, mode });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}
