export interface FontMeta {
  fileName: string;
  familyName: string;
  styleName: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  isVariable: boolean;
}

export type Slot = "cjk" | "mono";
