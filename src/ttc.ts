/** opentype.js cannot parse ttc; unpack the first face into a plain sfnt buffer. */
export function unwrapTTC(buffer: ArrayBuffer): {
  sfnt: ArrayBuffer;
  numFonts: number;
} {
  const view = new DataView(buffer);
  const magic = view.getUint32(0);
  if (magic !== 0x74746366) throw new Error("not a ttc");
  const numFonts = view.getUint32(8);
  const dirOffset = view.getUint32(12 + 0);
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
