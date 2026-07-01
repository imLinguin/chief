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

/**
 * Download just the header bytes of a (potentially very large) XSP file using
 * an HTTP range request, so we never pull the whole patch down.
 *
 * @param {string} url - The file URL (e.g. a Discord attachment URL).
 * @param {number} [declaredSize] - The known file size, used as a safety cap
 *   when the server ignores the range request.
 * @returns {Promise<Buffer>}
 */
export async function fetchXspHeaderBytes(url, declaredSize) {
  const wanted = 0x1000; // 4 KiB — comfortably covers the 860-byte header
  const res = await fetch(url, { headers: { Range: `bytes=0-${wanted - 1}` } });
  if (!res.ok) {
    throw new Error(`Failed to download file: ${res.status} ${res.statusText}`);
  }

  // If the server honoured the range request we get 206 and a tiny body.
  // If it returned the whole file (200), guard against huge downloads.
  const MAX_FULL_DOWNLOAD = 25 * 1024 * 1024; // 25 MiB
  if (res.status !== 206 && declaredSize && declaredSize > MAX_FULL_DOWNLOAD) {
    throw new Error(
      "File is too large and the host did not honour a range request; cannot fetch just the header.",
    );
  }

  return Buffer.from(await res.arrayBuffer());
}
