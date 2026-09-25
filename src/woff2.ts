const WOFF2_SIG = 0x774f4632; // 'wOF2'

export function isWoff2(buffer: ArrayBuffer): boolean {
  return (
    buffer.byteLength >= 4 && new DataView(buffer).getUint32(0) === WOFF2_SIG
  );
}

/**
 * Convert a WOFF2 buffer to a plain sfnt (TTF/OTF); other formats pass through.
 * woff2-encoder is ESM with its wasm inlined and a proper async init, and is
 * loaded lazily so it is only fetched when a WOFF2 file is actually used.
 */
export async function toSfnt(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (!isWoff2(buffer)) return buffer;
  const { default: decompress } = await import("woff2-encoder/decompress");
  const out = await decompress(new Uint8Array(buffer));
  return out.buffer.slice(
    out.byteOffset,
    out.byteOffset + out.byteLength,
  ) as ArrayBuffer;
}

/** Package a sfnt (TTF/OTF) buffer as WOFF2. Loaded lazily. */
export async function toWoff2(sfnt: ArrayBuffer): Promise<ArrayBuffer> {
  const { compress } = await import("woff2-encoder");
  const out = await compress(new Uint8Array(sfnt));
  return out.buffer.slice(
    out.byteOffset,
    out.byteOffset + out.byteLength,
  ) as ArrayBuffer;
}
