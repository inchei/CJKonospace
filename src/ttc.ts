const TTC_TAG = 0x74746366; // 'ttcf'
const NAME_TAG = 0x6e616d65; // 'name'

export interface TTCFace {
  index: number;
  family: string;
  style: string;
}

export function isTTC(buffer: ArrayBuffer): boolean {
  return new DataView(buffer).getUint32(0) === TTC_TAG;
}

function ttcFaceCount(buffer: ArrayBuffer): number {
  return new DataView(buffer).getUint32(8);
}

/** Read nameID 1/2/16/17 out of a face's `name` table without parsing glyphs. */
function readFaceName(
  buffer: ArrayBuffer,
  faceOffset: number,
): { family: string; style: string } {
  const view = new DataView(buffer);
  const numTables = view.getUint16(faceOffset + 4);
  let nameOff = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = faceOffset + 12 + i * 16;
    if (view.getUint32(rec) === NAME_TAG) {
      nameOff = view.getUint32(rec + 8);
      break;
    }
  }
  if (!nameOff) return { family: "", style: "" };

  const count = view.getUint16(nameOff + 2);
  const stringOffset = view.getUint16(nameOff + 4);
  let family = "";
  let style = "";
  let preferredFamily = "";
  let preferredStyle = "";
  for (let i = 0; i < count; i++) {
    const rec = nameOff + 6 + i * 12;
    const platformID = view.getUint16(rec);
    const languageID = view.getUint16(rec + 4);
    const nameID = view.getUint16(rec + 6);
    if (nameID !== 1 && nameID !== 2 && nameID !== 16 && nameID !== 17)
      continue;
    if (platformID !== 3 && platformID !== 1) continue;
    // Windows/English (0x409) or Macintosh/English (0)
    if (platformID === 3 ? languageID !== 0x409 : languageID !== 0) continue;
    const length = view.getUint16(rec + 8);
    const start = nameOff + stringOffset + view.getUint16(rec + 10);
    const bytes = new Uint8Array(buffer, start, length);
    let text: string;
    try {
      text = new TextDecoder(
        platformID === 3 ? "utf-16be" : "macintosh",
      ).decode(bytes);
    } catch {
      continue; // label unsupported here; skip rather than fail the whole TTC
    }
    if (nameID === 1 && !family) family = text;
    else if (nameID === 2 && !style) style = text;
    else if (nameID === 16 && !preferredFamily) preferredFamily = text;
    else if (nameID === 17 && !preferredStyle) preferredStyle = text;
  }
  // Prefer the typographic names (16/17) over the RIBBI ones (1/2).
  return {
    family: preferredFamily || family,
    style: preferredStyle || style,
  };
}

/** List every face in a TTC (family/style only, applies to All/English name records). */
export function inspectTTC(buffer: ArrayBuffer): TTCFace[] {
  if (!isTTC(buffer)) throw new Error("not a ttc");
  const view = new DataView(buffer);
  const count = ttcFaceCount(buffer);
  const faces: TTCFace[] = [];
  for (let i = 0; i < count; i++) {
    const { family, style } = readFaceName(buffer, view.getUint32(12 + i * 4));
    faces.push({ index: i, family: family || `face ${i}`, style });
  }
  return faces;
}

/** Unpack the face at `index` into a plain sfnt buffer (opentype.js cannot parse ttc). */
export function unwrapTTC(
  buffer: ArrayBuffer,
  index = 0,
): {
  sfnt: ArrayBuffer;
  numFonts: number;
} {
  const view = new DataView(buffer);
  const magic = view.getUint32(0);
  if (magic !== TTC_TAG) throw new Error("not a ttc");
  const numFonts = ttcFaceCount(buffer);
  if (index < 0 || index >= numFonts)
    throw new Error(`ttc face ${index} out of range (0-${numFonts - 1})`);
  const dirOffset = view.getUint32(12 + index * 4);
  const sfntVersion = view.getUint32(dirOffset);
  const numTables = view.getUint16(dirOffset + 4);
  // new buffer: 12-byte header + 16*n directory + table data
  const headerSize = 12 + numTables * 16;
  let dataSize = 0;
  for (let i = 0; i < numTables; i++) {
    const len = view.getUint32(dirOffset + 12 + i * 16 + 12);
    dataSize += len + ((4 - (len % 4)) % 4);
  }
  const out = new ArrayBuffer(headerSize + dataSize);
  const outView = new DataView(out);
  const outBytes = new Uint8Array(out);
  outView.setUint32(0, sfntVersion);
  outView.setUint16(4, numTables);
  // opentype.js barely validates searchRange/entrySelector/rangeShift; fill in legal values
  const entrySel = Math.floor(Math.log2(numTables));
  outView.setUint16(6, (1 << entrySel) * 16);
  outView.setUint16(8, entrySel);
  outView.setUint16(10, numTables * 16 - (1 << entrySel) * 16);

  let writePos = headerSize;
  for (let i = 0; i < numTables; i++) {
    const rec = dirOffset + 12 + i * 16;
    outBytes.set(
      new Uint8Array(buffer, rec, 16),
      12 + i * 16, // tag+checksum
    );
    const off = view.getUint32(rec + 8);
    const len = view.getUint32(rec + 12);
    outBytes.set(new Uint8Array(buffer, off, len), writePos);
    outView.setUint32(12 + i * 16 + 8, writePos);
    // copy length as-is; pad writePos to 4 afterwards
    writePos += len;
    const pad = (4 - (len % 4)) % 4;
    writePos += pad;
  }
  return { sfnt: out, numFonts };
}
