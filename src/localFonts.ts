/**
 * Local Font Access API (Chromium-only) wrapper.
 *
 * `queryLocalFonts()` enumerates the OS font library (the Windows Fonts folder
 * on Windows) behind a permission prompt, and each entry can hand back the raw
 * SFNT bytes via `blob()`. Types are declared locally because the API is
 * experimental and absent from lib.dom.
 */
export interface SystemFontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob(): Promise<Blob>;
}

interface LocalFontsWindow {
  queryLocalFonts?: (options?: {
    postscriptNames?: string[];
  }) => Promise<SystemFontData[]>;
}

/** True when the browser exposes the Local Font Access API. */
export function supportsLocalFonts(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as LocalFontsWindow).queryLocalFonts === "function"
  );
}

/**
 * Enumerate local fonts, sorted by family then style. Must be called from a
 * user gesture (a click handler) for the browser permission prompt to appear.
 */
export async function listLocalFonts(): Promise<SystemFontData[]> {
  const query = (window as LocalFontsWindow).queryLocalFonts;
  if (!query) throw new Error("Local Font Access API is not supported");
  const fonts = await query.call(window);
  return [...fonts].sort(
    (a, b) =>
      a.family.localeCompare(b.family) || a.style.localeCompare(b.style),
  );
}
