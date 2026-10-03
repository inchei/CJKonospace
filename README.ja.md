<p align="center"><img src="public/logo.svg" width="128" height="128" alt="CJKonospace"></p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-Hant.md">繁體中文</a> |
  <a href="README.zh-Hans.md">简体中文</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.ko.md">한국어</a>
</p>

# CJKonospace

CJK × 等幅フォントのブレンド作業台：2 つのフォント（CJK 用と等幅用）を読み込み、ブラウザ上で混植をライブプレビューし、文字幅とグリフ幅を調整して CJK : mono が視覚的にバランスの取れた 1 : 2（Maple Mono 方式）になるまで追い込みます。

ライブアプリ：<https://inchei.github.io/CJKonospace/>

## クイックスタート

```bash
pnpm install
pnpm dev      # 開発サーバー
pnpm build    # プロダクションビルド（dist/）
```

## 仕組み

- **パースとプレビュー** — [opentype.js](https://opentype.js.org/) が両フォントをパースし、Canvas レンダラーが混植行をレイアウトします。[harfbuzzjs](https://github.com/harfbuzz/harfbuzzjs)（WASM）が実際の GSUB シェーピングを行うため、等幅のリガチャがプレビューに表示されます。
- **WOFF2 入出力** — WOFF2 入力は展開し、WOFF2 出力は [woff2-encoder](https://github.com/itskyedo/woff2-encoder)（WASM）で圧縮します。
- **フォント生成** — 同じ `wasm/merge_font.py` をブラウザ内の [pyodide](https://pyodide.org/)（WASM）で実行し、[fontTools](https://fonttools.readthedocs.io/) は CDN から読み込むため、サーバーとの通信は不要です。

3 つの WASM モジュールはすべて遅延読み込み（初回使用時にのみ取得）：シェーピング用の harfbuzzjs（約 0.4 MB）、WOFF2 入力用の woff2-encoder（約 0.27 MB）、フォント生成用の pyodide + fontTools（約 10 MB）。実行時の Python は WASM 経路に依存しません — 下記のコマンドライン節を参照してください。

## コマンドライン

```bash
uv run wasm/merge_font.py mono.ttf cjk.ttf out.ttf params.json
```

`mono.ttf` はベースフォント（その glyph ID、GSUB/GPOS/GDEF、ラテン文字カバレッジを保持）で、`cjk.ttf` は追加するグリフを提供します。`params.json`：

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

| キー                       | 意味                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `fs`                       | 参照フォントサイズ（px）。`baseline` オフセットを px からフォント単位に変換するためだけに使用           |
| `lock2to1`                 | CJK の送り幅を 2 × mono の送り幅に固定（このツールの主目的）                                            |
| `lineHeight`               | 再計算される ascent/descent の倍率（既定 `1.0`、ギャップは常に `0`）                                    |
| `format`                   | 出力パッケージ形式：`ttf`（既定）または `woff2`                                                         |
| `mono` / `cjk.advMul`      | 送り幅の倍率                                                                                            |
| `mono` / `cjk.gsx`, `gsy`  | 輪郭スケール（グリフ幅／高さ）。送り幅は変更しない                                                      |
| `mono` / `cjk.baseline`    | ベースラインオフセット（px、`fs` 参照）                                                                 |
| `mono` / `cjk.ttcIndex`    | 入力が `.ttc` コレクションの場合のフェイスインデックス（既定 `0`）                                      |
| `variations.mono` / `.cjk` | 可変フォントのインスタンス位置（軸タグ → 値）、例 `{ "wght": 700 }`                                     |
| `mergeWght`                | 共有 `wght` 軸を固定せず可変出力にマージ（下記参照）                                                    |
| `weightMap`                | `[[mono, cjk], ...]` wght アンカー（ユーザー値）。2 フォントを対応付け。既定は min/default/max を揃える |
| `axisRange`                | `{"min": ..., "max": ...}` 出力 wght 範囲の縮小（既定：mono の全範囲）                                  |
| `cjk.subset`               | CJK 入力からこれらのコードポイントのみ保持、例 `{ "unicodes": [19968] }`（省略＝すべて）                |

備考：

- 入力は TTF、OTF、WOFF2 に対応（WOFF2 は先に展開。CLI はこのために `brotli` 依存を宣言）。
- TTC コレクションに対応：`ttcIndex` でフェイスを選択（既定 `0`）。
- 可変フォント入力は `variations.mono` / `variations.cjk` により静的インスタンスに固定（fontTools `varLib.instancer`）。空の位置はすべての軸を既定値に固定します。
- `mergeWght` では、共有 `wght` 軸を固定せず可変出力にマージします。両入力は `wght` 軸を持つ可変 `glyf`/`gvar` フォントである必要があります（そうでなければ警告付きで静的出力にフォールバック）。出力は mono の範囲にわたり、mono ベースの avar ウェイトカーブ、名前付きインスタンス、`rvrn` 差し替えを保ち、`weightMap` アンカーで 2 フォントのマスターを対応付けます。
- CJK 入力は `cjk.subset.unicodes` でサブセット化できます（fontTools `subset`、インスタンス化／マージの前に適用）。
- 出力の輪郭は常に TrueType（`glyf`）。`format: "woff2"` で同一フォントの WOFF2 パッケージを取得できます。CFF/OTF の mono ベースは変換されます（cu2qu、CFF ヒンティングは破棄）。
- ヒンティングには手を加えないため、拡大縮小された CJK グリフは元の命令を保持します。
- 垂直メトリクス（`hhea` ascent/descent、`OS/2` typo + win メトリクス）は全グリフをカバーするよう両フォントから再計算され、背の高い CJK グリフが切れません。`hhea.lineGap` と `OS/2.sTypoLineGap` は `0` に強制されます。ターミナルが正のギャップを一貫して扱わないためです。
- 結果が等幅としてフラグされるのは、mono ベースの印刷可能 ASCII グリフが実際に同一の送り幅を共有している場合のみです（`post.isFixedPitch = 1`、`OS/2.panose.bProportion = 9`、`OS/2.xAvgCharWidth` = 半幅、`gasp` テーブルが無ければ追加）。CJK は設計上全角 2 倍でこのチェックの対象外です。ASCII グリフを持たないベースも非等幅とみなされます。プロポーショナルベースは独自のフラグを保持します。
- `styleName` は自由入力で、出力サブファミリー（name ID 2/17/22）とスタイルメタデータ（`OS/2.usWeightClass`、`OS/2.usWidthClass`、`fsSelection`、`head.macStyle`）を設定します。[OpenType name の例](https://learn.microsoft.com/en-us/typography/opentype/spec/namesmp)のキーワード対応を使用。空にすると mono ベースのサブファミリーを継承し、スタイルメタデータをそのまま保持します。

## ライセンス

GPL-3.0-only
