// A minimal ZIP writer for the year-end tax package (roadmap T3.3 K3,
// decision 9): the STORE method only (no compression — CSV files and one PDF
// are a few hundred KB), a table-driven CRC-32 (zlib.crc32 is missing from
// older Node releases) and ASCII file names. No new dependency, no ZIP64: a
// file or archive past 4 GB, or more than 65535 entries, is refused.
//
// Layout (APPNOTE.TXT 4.3): for each file a local file header + its bytes, then
// the central directory (one record per file pointing back at its local
// header), then the end-of-central-directory record.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// CRC-32 (IEEE 802.3, the ZIP checksum) of a Buffer / string → unsigned int.
function crc32(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// MS-DOS date / time fields (2-second resolution, years 1980-2107), from the
// date's UTC fields so the same input gives the same bytes on any server.
function dosDateTime(date) {
  const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(2107, Math.max(1980, d.getUTCFullYear()));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

const MAX_U32 = 0xffffffff;

// A file name the archive can carry: printable ASCII, a relative path with no
// empty, "." or ".." segment and no backslash, at most 255 characters.
function validName(name) {
  if (typeof name !== "string" || !name.length || name.length > 255) return false;
  if (!/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(name)) return false;
  if (name.includes("\\") || name.startsWith("/")) return false;
  return name.split("/").every((seg) => seg && seg !== "." && seg !== "..");
}

// files: [{ name, data: Buffer | string }] → Buffer (a complete .zip).
function createZip(files, { date = new Date() } = {}) {
  if (!Array.isArray(files)) throw new Error("createZip: files must be an array");
  if (files.length > 0xffff) throw new Error("createZip: too many files");
  const { time, date: dosDate } = dosDateTime(date);
  const seen = new Set();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    if (!f || !validName(f.name)) throw new Error("createZip: invalid file name");
    if (seen.has(f.name)) throw new Error("createZip: duplicate file name " + f.name);
    seen.add(f.name);
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data == null ? "" : f.data), "utf8");
    if (data.length > MAX_U32) throw new Error("createZip: file too large");
    const name = Buffer.from(f.name, "ascii");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4);         // version needed to extract (2.0)
    local.writeUInt16LE(0, 6);          // general purpose flags
    local.writeUInt16LE(0, 8);          // method 0 = stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);          // extra field length
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed to extract
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);         // extra field length
    central.writeUInt16LE(0, 32);         // comment length
    central.writeUInt16LE(0, 34);         // disk number start
    central.writeUInt16LE(0, 36);         // internal attributes
    central.writeUInt32LE(0, 38);         // external attributes
    central.writeUInt32LE(offset, 42);    // local header offset
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
    if (offset > MAX_U32) throw new Error("createZip: archive too large");
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  if (offset + cdSize > MAX_U32) throw new Error("createZip: archive too large");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);   // end of central directory signature
  end.writeUInt16LE(0, 4);            // this disk
  end.writeUInt16LE(0, 6);            // disk with the central directory
  end.writeUInt16LE(files.length, 8); // entries on this disk
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);      // central directory offset
  end.writeUInt16LE(0, 20);           // comment length
  return Buffer.concat([...locals, ...centrals, end]);
}

module.exports = { crc32, createZip, dosDateTime, validName };
