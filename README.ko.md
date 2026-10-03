<p align="center"><img src="public/logo.svg" width="128" height="128" alt="CJKonospace"></p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-Hans.md">简体中文</a> |
  <a href="README.zh-Hant.md">繁體中文</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.ko.md">한국어</a>
</p>

# CJKonospace

CJK × 고정폭 폰트 블렌딩 작업대: 두 개의 폰트(CJK용 하나, 고정폭용 하나)를 입력하고 브라우저에서 라이브로 혼합 미리보기를 하며, CJK : mono가 시각적으로 균형 잡힌 1 : 2 비율(Maple Mono 방식)에 도달할 때까지 글자 폭과 글리프 폭을 조정합니다.

라이브 앱: <https://inchei.github.io/CJKonospace/>

## 빠른 시작

```bash
pnpm install
pnpm dev      # 개발 서버
pnpm build    # 프로덕션 빌드 (dist/)
```

## 동작 방식

- **파싱 및 미리보기** — [opentype.js](https://opentype.js.org/)가 두 폰트를 파싱하고 Canvas 렌더러가 혼합 줄을 배치합니다. [harfbuzzjs](https://github.com/harfbuzz/harfbuzzjs)(WASM)가 실제 GSUB 셰이핑을 수행하므로 고정폭 리가처가 미리보기에 나타납니다.
- **WOFF2 입출력** — WOFF2 입력은 압축을 풀고, WOFF2 출력은 [woff2-encoder](https://github.com/itskyedo/woff2-encoder)(WASM)로 압축합니다.
- **폰트 생성** — 동일한 `wasm/merge_font.py`가 브라우저에서 [pyodide](https://pyodide.org/)(WASM)로 실행되며, [fontTools](https://fonttools.readthedocs.io/)는 CDN에서 로드하므로 서버 왕복이 필요 없습니다.

세 개의 WASM 모듈은 모두 지연 로드됩니다(처음 사용할 때만 가져옴): 셰이핑용 harfbuzzjs(약 0.4 MB), WOFF2 입력용 woff2-encoder(약 0.27 MB), 폰트 생성용 pyodide + fontTools(약 10 MB). 런타임의 Python은 WASM 경로에 의존하지 않습니다 — 아래 명령줄 섹션을 참고하세요.

## 명령줄

```bash
uv run wasm/merge_font.py mono.ttf cjk.ttf out.ttf params.json
```

`mono.ttf`는 베이스 폰트(글리프 ID, GSUB/GPOS/GDEF, 라틴 커버리지를 유지)이며 `cjk.ttf`는 덧붙일 글리프를 제공합니다. `params.json`:

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

| 키                         | 의미                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `fs`                       | 기준 폰트 크기(px). `baseline` 오프셋을 px에서 폰트 유닛으로 변환할 때만 사용            |
| `lock2to1`                 | CJK 전진폭을 2 × mono 전진폭으로 고정(이 도구의 핵심)                                    |
| `lineHeight`               | 재계산된 ascent/descent의 배수(기본 `1.0`, 간격은 항상 `0`)                              |
| `format`                   | 출력 패키징: `ttf`(기본) 또는 `woff2`                                                    |
| `mono` / `cjk.advMul`      | 전진폭 배수                                                                              |
| `mono` / `cjk.gsx`, `gsy`  | 윤곽 스케일(글리프 너비/높이), 전진폭은 그대로                                           |
| `mono` / `cjk.baseline`    | 기준선 오프셋(px, `fs` 참고)                                                             |
| `mono` / `cjk.ttcIndex`    | 입력이 `.ttc` 컬렉션일 때의 페이스 인덱스(기본 `0`)                                      |
| `variations.mono` / `.cjk` | 가변 폰트 인스턴스 위치(축 태그 → 값), 예: `{ "wght": 700 }`                             |
| `mergeWght`                | 공유 `wght` 축을 고정하는 대신 가변 출력으로 병합(아래 참고)                             |
| `weightMap`                | `[[mono, cjk], ...]` wght 앵커(사용자 값). 두 폰트를 짝지음. 기본은 min/default/max 정렬 |
| `axisRange`                | `{"min": ..., "max": ...}` 출력 wght 범위 축소(기본: mono 전체 범위)                     |
| `cjk.subset`               | CJK 입력에서 이 코드포인트만 유지, 예: `{ "unicodes": [19968] }`(생략 = 전체)            |

참고:

- 입력은 TTF, OTF, WOFF2를 지원합니다(WOFF2는 먼저 압축 해제; CLI가 이를 위해 `brotli` 의존성을 선언).
- TTC 컬렉션 지원: `ttcIndex`로 페이스 선택(기본 `0`).
- 가변 폰트 입력은 `variations.mono` / `variations.cjk`로 정적 인스턴스에 고정됩니다(fontTools `varLib.instancer`). 빈 위치는 모든 축을 기본값으로 고정합니다.
- `mergeWght`를 사용하면 공유 `wght` 축이 고정되지 않고 가변 출력으로 병합됩니다. 두 입력 모두 `wght` 축을 가진 가변 `glyf`/`gvar` 폰트여야 합니다(그렇지 않으면 경고와 함께 정적으로 폴백). 출력은 mono 범위에 걸쳐 있고, mono 베이스의 avar 웨이트 커브, 명명된 인스턴스, `rvrn` 교체를 유지하며, `weightMap` 앵커로 두 폰트의 마스터를 짝짓습니다.
- CJK 입력은 `cjk.subset.unicodes`로 서브셋할 수 있습니다(fontTools `subset`, 인스턴싱/병합 전에 적용).
- 출력 윤곽은 항상 TrueType(`glyf`)입니다. `format: "woff2"`로 같은 폰트의 WOFF2 패키지를 얻을 수 있습니다. CFF/OTF mono 베이스는 변환됩니다(cu2qu, CFF 힌팅은 제거).
- 이 도구는 힌팅을 건드리지 않으므로, 스케일된 CJK 글리프는 원래 명령을 유지합니다.
- 세로 메트릭(`hhea` ascent/descent, `OS/2` typo + win 메트릭)은 두 폰트에서 모든 글리프를 포괄하도록 재계산되어 키 큰 CJK 글리프가 잘리지 않습니다. `hhea.lineGap`과 `OS/2.sTypoLineGap`은 `0`으로 강제됩니다. 터미널이 양수 간격을 일관되게 해석하지 않기 때문입니다.
- 결과는 mono 베이스의 인쇄 가능한 ASCII 글리프가 실제로 하나의 전진폭을 공유할 때만 고정폭으로 플래그됩니다(`post.isFixedPitch = 1`, `OS/2.panose.bProportion = 9`, `OS/2.xAvgCharWidth` = 반폭, `gasp` 테이블이 없으면 추가). CJK는 설계상 전각 2배이며 이 검사 대상이 아닙니다. ASCII 글리프가 없는 베이스도 고정폭이 아닌 것으로 간주됩니다. 비례 베이스는 자체 플래그를 유지합니다.
- `styleName`은 자유 입력이며 출력 서브패밀리(name ID 2/17/22)와 스타일 메타데이터(`OS/2.usWeightClass`, `OS/2.usWidthClass`, `fsSelection`, `head.macStyle`)를 설정합니다. [OpenType name 예시](https://learn.microsoft.com/en-us/typography/opentype/spec/namesmp)의 키워드 매핑을 사용합니다. 비워 두면 mono 베이스의 서브패밀리를 상속하고 스타일 메타데이터를 그대로 유지합니다.

## 라이선스

GPL-3.0-only
