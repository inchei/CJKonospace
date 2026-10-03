<p align="center"><img src="public/logo.svg" width="128" height="128" alt="CJKonospace"></p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-Hant.md">繁體中文</a> |
  <a href="README.zh-Hans.md">简体中文</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.ko.md">한국어</a>
</p>

# CJKonospace

CJK × 等宽字体混排工作台：输入两个字体（一个负责 CJK、一个负责等宽），在浏览器中实时预览混排效果，并调校字符宽度与字形宽度，直到 CJK : mono 达到视觉平衡的 1 : 2 比例（Maple Mono 风格）。

在线应用：<https://inchei.github.io/CJKonospace/>

## 快速开始

```bash
pnpm install
pnpm dev      # 开发服务器
pnpm build    # 生产构建（dist/）
```

## 工作原理

- **解析与预览** — [opentype.js](https://opentype.js.org/) 解析两个字体，Canvas 渲染器负责排版混排文字行；[harfbuzzjs](https://github.com/harfbuzz/harfbuzzjs)（WASM）执行真正的 GSUB shaping，让等宽连字能在预览中正确呈现。
- **WOFF2 读写** — WOFF2 输入会先解压，输出则以 [woff2-encoder](https://github.com/itskyedo/woff2-encoder)（WASM）压缩。
- **字体生成** — 同一份 `wasm/merge_font.py` 在浏览器中通过 [pyodide](https://pyodide.org/)（WASM）运行，[fontTools](https://fonttools.readthedocs.io/) 由 CDN 加载，因此无需任何服务器往返。

三个 WASM 模块均为延迟加载（首次使用时才下载）：harfbuzzjs（约 0.4 MB）用于 shaping、woff2-encoder（约 0.27 MB）用于 WOFF2 输入、pyodide + fontTools（约 10 MB）用于字体生成。运行时的 Python 不依赖 WASM 路径 —— 详见下方命令行章节。

## 命令行

```bash
uv run wasm/merge_font.py mono.ttf cjk.ttf out.ttf params.json
```

`mono.ttf` 是基础字体（保留其 glyph ID、GSUB/GPOS/GDEF 与拉丁字符覆盖），`cjk.ttf` 提供要附加的字形。`params.json`：

```json
{
  "fs": 48,
  "lock2to1": true,
  "familyName": "MyMono",
  "styleName": "Regular",
  "lineHeight": 1.0,
  "format": "ttf",
  "variations": { "mono": {}, "cjk": {} },
  "mono": { "advMul": 1, "gsx": 1, "gsy": 1, "baseline": 0, "ttcIndex": 0 },
  "cjk": {
    "advMul": 1,
    "gsx": 1,
    "gsy": 1,
    "baseline": 0,
    "ttcIndex": 0,
    "subset": { "unicodes": [19968, 19969] }
  }
}
```

| 键                         | 说明                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `fs`                       | 参考字号（px）；仅用于把 `baseline` 偏移从 px 换算为字体单位                       |
| `lock2to1`                 | 将 CJK 步进宽度锁定为 2 × mono 步进宽度（本工具的核心目的）                        |
| `lineHeight`               | 重新计算的 ascent/descent 的倍率（默认 `1.0`；间隙恒为 `0`）                       |
| `format`                   | 输出封装格式：`ttf`（默认）或 `woff2`                                              |
| `mono` / `cjk.advMul`      | 步进宽度倍率                                                                       |
| `mono` / `cjk.gsx`, `gsy`  | 轮廓缩放（字形宽／高），不影响步进宽度                                             |
| `mono` / `cjk.baseline`    | 基线偏移，单位 px（见 `fs`）                                                       |
| `mono` / `cjk.ttcIndex`    | 输入为 `.ttc` 集合时的字面索引（默认 `0`）                                         |
| `variations.mono` / `.cjk` | 可变字体实例位置（轴标签 → 值），例如 `{ "wght": 700 }`                            |
| `mergeWght`                | 将共享的 `wght` 轴合并为可变输出而非固定（见下文）                                 |
| `weightMap`                | `[[mono, cjk], ...]` wght 锚点（用户数值），配对两个字体；默认对齐 min/default/max |
| `axisRange`                | `{"min": ..., "max": ...}` 缩小输出 wght 范围（默认：mono 的完整范围）             |
| `cjk.subset`               | 仅保留 CJK 输入中的这些码位，例如 `{ "unicodes": [19968] }`（省略 = 全部）         |

备注：

- 输入可为 TTF、OTF 或 WOFF2（WOFF2 会先解压；命令行为此声明 `brotli` 依赖）。
- 支持 TTC 集合：用 `ttcIndex` 选择字面（默认 `0`）。
- 可变字体输入会通过 `variations.mono` / `variations.cjk`（fontTools `varLib.instancer`）固定为静态实例；空位置会把所有轴固定在其默认值。
- 使用 `mergeWght` 时，共享的 `wght` 轴会合并为可变输出而非固定。两个输入都必须是具备 `wght` 轴的可变 `glyf`/`gvar` 字体（否则会回退为静态并发出警告）；输出覆盖 mono 的范围，保留 mono 基础字体的 avar 字重曲线、其命名实例与 `rvrn` 替换，并通过 `weightMap` 锚点配对两个字体的 master。
- CJK 输入可用 `cjk.subset.unicodes` 子集化（fontTools `subset`，在实例化／合并之前应用）。
- 输出轮廓始终为 TrueType（`glyf`）；设置 `format: "woff2"` 可得到同一字体的 WOFF2 封装。CFF/OTF mono 基础字体会被转换（cu2qu；CFF hinting 被丢弃）。
- 本工具不改动 hinting，因此缩放后的 CJK 字形会保留其原始指令。
- 垂直度量（`hhea` ascent/descent、`OS/2` typo + win 度量）会依据两个字体重新计算以覆盖所有字形，避免过高的 CJK 字形被裁切。`hhea.lineGap` 与 `OS/2.sTypoLineGap` 强制设为 `0`，因为终端对正间隙的解读不一致。
- 只有当 mono 基础字体的可打印 ASCII 字形确实共享同一步进宽度时，结果才会被标记为等宽（`post.isFixedPitch = 1`、`OS/2.panose.bProportion = 9`；`OS/2.xAvgCharWidth` = 半宽；缺少时加入 `gasp` 表）（CJK 按设计为全宽 2 倍，不在此检查范围内；没有 ASCII 字形的基础字体也算作非等宽）。比例字体会保留自身的标志。
- `styleName` 可自由输入，用于设置输出子家族（name ID 2/17/22）与样式元数据（`OS/2.usWeightClass`、`OS/2.usWidthClass`、`fsSelection`、`head.macStyle`），采用 [OpenType name 示例](https://learn.microsoft.com/en-us/typography/opentype/spec/namesmp)的关键字映射。可留空以继承 mono 基础字体的子家族并保持其样式元数据不变。

## 许可证

GPL-3.0-only
