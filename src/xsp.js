/**
 * Parser for the header of an XSP (MSIXVC streaming patch) file.
 *
 * Modelled after the xodus implementation:
 *   https://github.com/xodus-gaming/xodus/blob/main/msixvc/src/xsp.rs
 *   https://github.com/xodus-gaming/xodus/tree/main/msixvc/src/models/xsp
 *
 * The raw header is a `#[repr(C, packed)]` little-endian structure. We only
 * parse the header here (patch records are skipped — there can be a great
 * many of them). Byte layout (offsets in hex):
 *
 *   0x000  [0x200] signature
 *   0x200  [8]     magic                       = "MS-XPFM "
 *   0x208  u32     block_size_or_payload        -> page_size
 *   0x20C  [4]     _unknown
 *   0x210  [0x10]  vduid                        -> content_id (GUID, LE)
 *   0x220  [0x10]  uduid                        (GUID, LE)
 *   0x230  [0x10]  build_id                     (GUID, LE)
 *   0x240  [0x30]  _reserved
 *   0x27C  u32     record_count
 *   0x2B0  u64     next_block_size
 *   0x2C0  u32     number_of_elements
 *   0x2C8  u64     total_bytes                  -> total_download
 *   0x2D0  u64     disk_space_required
 *   0x318  [0x10]  plan_id                      (GUID, LE)
 *   0x33C  [0x10]  xsp_id                       (GUID, LE)
 *   0x34C  [u16;4] previous_build_version       -> upgrade_from_version
 *   0x354  [u16;4] current_build_version        -> upgrade_to_version
 *   0x35C  (end of header)
 */

export const XSP_MAGIC = "MS-XPFM ";
export const XSP_HEADER_SIZE = 0x35c; // 860 bytes

const OFF = {
  magic: 0x200,
  blockSizeOrPayload: 0x208,
  vduid: 0x210,
  uduid: 0x220,
  buildId: 0x230,
  recordCount: 0x27c,
  nextBlockSize: 0x2b0,
  numberOfElements: 0x2c0,
  totalBytes: 0x2c8,
  diskSpaceRequired: 0x2d0,
  planId: 0x318,
  xspId: 0x33c,
  previousBuildVersion: 0x34c,
  currentBuildVersion: 0x354,
};

/**
 * Format 16 bytes as a UUID using little-endian field order (matches Rust's
 * `uuid::Uuid::from_bytes_le`, i.e. the in-memory Windows GUID layout):
 * Data1 (u32 LE), Data2 (u16 LE), Data3 (u16 LE), then 8 tail bytes as-is.
 */
function formatGuidLe(buf, offset) {
  const b = buf.subarray(offset, offset + 16);
  const hex2 = (n) => n.toString(16).padStart(2, "0");
  const d1 = b.readUInt32LE(0).toString(16).padStart(8, "0");
  const d2 = b.readUInt16LE(4).toString(16).padStart(4, "0");
  const d3 = b.readUInt16LE(6).toString(16).padStart(4, "0");
  const tail = [...b.subarray(8, 16)].map(hex2).join("");
  return `${d1}-${d2}-${d3}-${tail.slice(0, 4)}-${tail.slice(4)}`;
}

/**
 * Format a `[u16; 4]` little-endian version array as "major.minor.x.build".
 * The array is stored in reverse component order: the last element is the
 * major version and the first is the build number, so we read it backwards.
 */
function formatVersion(buf, offset) {
  return [6, 4, 2, 0].map((i) => buf.readUInt16LE(offset + i)).join(".");
}

/** Read an unsigned 64-bit little-endian value, returning a Number. */
function readU64(buf, offset) {
  return Number(buf.readBigUInt64LE(offset));
}

/**
 * Parse the header of an XSP file from a buffer.
 *
 * @param {Buffer} buf - A buffer containing at least the first
 *   {@link XSP_HEADER_SIZE} bytes of the file.
 * @returns {{
 *   magic: string,
 *   pageSize: number,
 *   recordCount: number,
 *   numberOfElements: number,
 *   nextBlockSize: number,
 *   totalDownload: number,
 *   diskSpaceRequired: number,
 *   contentId: string,
 *   updateDomainId: string,
 *   buildId: string,
 *   planId: string,
 *   xspId: string,
 *   upgradeFromVersion: string,
 *   upgradeToVersion: string,
 * }}
 */
export function parseXspHeader(buf) {
  if (buf.length < XSP_HEADER_SIZE) {
    throw new Error(
      `File too small: need at least ${XSP_HEADER_SIZE} bytes for the header, got ${buf.length}.`,
    );
  }

  const magic = buf.toString("latin1", OFF.magic, OFF.magic + 8);
  if (magic !== XSP_MAGIC) {
    throw new Error(
      `Not an XSP file: expected magic "${XSP_MAGIC}", found "${magic.replace(/[^\x20-\x7e]/g, ".")}".`,
    );
  }

  return {
    magic,
    pageSize: buf.readUInt32LE(OFF.blockSizeOrPayload),
    recordCount: buf.readUInt32LE(OFF.recordCount),
    numberOfElements: buf.readUInt32LE(OFF.numberOfElements),
    nextBlockSize: readU64(buf, OFF.nextBlockSize),
    totalDownload: readU64(buf, OFF.totalBytes),
    diskSpaceRequired: readU64(buf, OFF.diskSpaceRequired),
    contentId: formatGuidLe(buf, OFF.vduid),
    updateDomainId: formatGuidLe(buf, OFF.uduid),
    buildId: formatGuidLe(buf, OFF.buildId),
    planId: formatGuidLe(buf, OFF.planId),
    xspId: formatGuidLe(buf, OFF.xspId),
    upgradeFromVersion: formatVersion(buf, OFF.previousBuildVersion),
    upgradeToVersion: formatVersion(buf, OFF.currentBuildVersion),
  };
}

export const XSP_RECORD_SIZE = 16; // bytes per raw XspPatchRecord
export const XSP_FLAG_NEW = 0x00000000; // NewData: block downloaded fresh
export const XSP_FLAG_COPY = 0x88000000; // CopyData: block re-used from install
const DEFAULT_BLOCK_SIZE = 4096;

/**
 * Parse the patch record table and aggregate how much data is re-used from an
 * existing install versus downloaded fresh.
 *
 * Each 16-byte record is `#[repr(C, packed)]` little-endian:
 *   +0x0 u32 source_offset  (old block number for CopyData)
 *   +0x4 u32 flag           (0 = NewData, 0x88000000 = CopyData)
 *   +0x8 u32 target_offset  (new block number)
 *   +0xC u32 length         (block/page count — NOT bytes)
 *
 * @param {Buffer} buf - Buffer positioned at the first record.
 * @param {number} recordCount - Number of records to read.
 * @param {number} blockSize - Size of one block/page in bytes (usually 4096).
 */
export function parseXspRecords(buf, recordCount, blockSize) {
  const available = Math.floor(buf.length / XSP_RECORD_SIZE);
  const parsedCount = Math.min(recordCount, available);

  let newBlocks = 0;
  let copyBlocks = 0;
  let newCount = 0;
  let copyCount = 0;
  let unknownCount = 0;

  for (let i = 0; i < parsedCount; i++) {
    const off = i * XSP_RECORD_SIZE;
    const flag = buf.readUInt32LE(off + 4);
    const length = buf.readUInt32LE(off + 12); // in blocks/pages

    if (flag === XSP_FLAG_NEW) {
      newBlocks += length;
      newCount += 1;
    } else if (flag === XSP_FLAG_COPY) {
      copyBlocks += length;
      copyCount += 1;
    } else {
      unknownCount += 1;
    }
  }

  const downloadedBytes = newBlocks * blockSize;
  const reusedBytes = copyBlocks * blockSize;
  const totalBytes = downloadedBytes + reusedBytes;

  return {
    parsedCount,
    newCount,
    copyCount,
    unknownCount,
    downloadedBytes,
    reusedBytes,
    totalBytes,
    reuseRatio: totalBytes > 0 ? reusedBytes / totalBytes : 0,
    truncated: parsedCount < recordCount,
  };
}

/**
 * Fetch a byte range from a URL. Returns the requested slice, transparently
 * handling servers that ignore the range and return the whole body (200).
 *
 * @param {string} url
 * @param {number} start - Inclusive start offset.
 * @param {number} end - Inclusive end offset.
 * @returns {Promise<Buffer>}
 */
async function fetchRange(url, start, end) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (!res.ok) {
    throw new Error(`Failed to download file: ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // 206 => body already starts at `start`. 200 => full file, slice it out.
  return res.status === 206 ? buf : buf.subarray(start, end + 1);
}

/**
 * Download and analyse an XSP file: parse its header, then parse the patch
 * record table to compute the re-used vs downloaded data ratio. Only the
 * header page and the record table are fetched (via range requests), never
 * the payload blocks themselves.
 *
 * @param {string} url - The file URL (e.g. a Discord attachment URL).
 * @param {number} [declaredSize] - Known file size (safety cap).
 * @returns {Promise<{ header: object, stats: object }>}
 */
export async function analyzeXspFile(url, declaredSize) {
  // 1. Header page (records begin at header.pageSize, always < 4 KiB in).
  const headerBuf = await fetchRange(url, 0, 0xfff);
  const header = parseXspHeader(headerBuf);

  const blockSize = header.pageSize || DEFAULT_BLOCK_SIZE;
  const recordsStart = header.pageSize;
  const recordsBytes = header.recordCount * XSP_RECORD_SIZE;

  // 2. Record table. Cap the download so a pathological header can't make us
  //    pull an unbounded range; note truncation if we hit the cap.
  const MAX_RECORD_BYTES = 128 * 1024 * 1024; // 128 MiB (~8.4M records)
  const cap =
    declaredSize && declaredSize > recordsStart
      ? Math.min(recordsBytes, declaredSize - recordsStart)
      : recordsBytes;
  const wantBytes = Math.min(cap, MAX_RECORD_BYTES);

  let stats;
  if (wantBytes <= 0) {
    stats = parseXspRecords(Buffer.alloc(0), header.recordCount, blockSize);
  } else {
    const recordsBuf = await fetchRange(
      url,
      recordsStart,
      recordsStart + wantBytes - 1,
    );
    stats = parseXspRecords(recordsBuf, header.recordCount, blockSize);
  }

  return { header, stats };
}
