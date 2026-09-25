/** Monospace presets: same sources as ../syntaxFont/fonts.json (woff2-only maple-mono excluded,
 *  opentype.js preview cannot parse it). All SIL OFL 1.1, fetched from CDN on demand, never bundled. */
export interface MonoPreset {
  name: string;
  family: string;
  url: string;
  license: string;
  homepage: string;
}

export const MONO_PRESETS: MonoPreset[] = [
  {
    name: "jetbrains-mono",
    family: "JetBrains Mono",
    url: "https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/fonts/ttf/JetBrainsMono-Regular.ttf",
    license: "OFL-1.1",
    homepage: "https://www.jetbrains.com/lp/mono/",
  },
  {
    name: "fira-code",
    family: "Fira Code",
    url: "https://cdn.jsdelivr.net/npm/firacode@6.2.0/distr/ttf/FiraCode-Regular.ttf",
    license: "OFL-1.1",
    homepage: "https://github.com/tonsky/FiraCode",
  },
  {
    name: "source-code-pro",
    family: "Source Code Pro",
    url: "https://raw.githubusercontent.com/adobe-fonts/source-code-pro/release/TTF/SourceCodePro-Regular.ttf",
    license: "OFL-1.1",
    homepage: "https://github.com/adobe-fonts/source-code-pro",
  },
  {
    name: "ibm-plex-mono",
    family: "IBM Plex Mono",
    url: "https://raw.githubusercontent.com/IBM/plex/master/packages/plex-mono/fonts/complete/ttf/IBMPlexMono-Regular.ttf",
    license: "OFL-1.1",
    homepage: "https://github.com/IBM/plex",
  },
  {
    name: "roboto-mono",
    family: "Roboto Mono",
    url: "https://raw.githubusercontent.com/googlefonts/RobotoMono/main/fonts/ttf/RobotoMono-Regular.ttf",
    license: "OFL-1.1",
    homepage: "https://github.com/googlefonts/RobotoMono",
  },
  {
    name: "ubuntu-mono",
    family: "Ubuntu Mono",
    url: "https://raw.githubusercontent.com/google/fonts/main/ufl/ubuntumono/UbuntuMono-Regular.ttf",
    license: "OFL-1.1",
    homepage: "https://fonts.google.com/specimen/Ubuntu+Mono",
  },
  {
    name: "hack",
    family: "Hack",
    url: "https://raw.githubusercontent.com/source-foundry/Hack/master/build/ttf/Hack-Regular.ttf",
    license: "OFL-1.1",
    homepage: "https://github.com/source-foundry/Hack",
  },
  {
    name: "space-mono",
    family: "Space Mono",
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/spacemono/SpaceMono-Regular.ttf",
    license: "OFL-1.1",
    homepage: "https://fonts.google.com/specimen/Space+Mono",
  },
];
