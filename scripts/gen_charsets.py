#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Generate src/lib/charsets.json: compact Unicode ranges for CJK subset presets.

Sources (dev-time download only; the generated JSON is committed):
- WHATWG encoding indexes, CC0-1.0:
    index-gb18030.txt (GBK two-byte area, simplified superset),
    index-big5.txt (Big5 + HKSCS, traditional),
    index-jis0208.txt (JIS X 0208, Japanese),
    index-euc-kr.txt (KS X 1001 / UHC, Korean)
- ben-hua/general_standard_chinese gsc_level_1/2/3.txt, Apache-2.0:
    通用规范汉字表 levels 1 (3500), 1+2 (6500), 1+2+3 (8105), simplified

Usage:
    uv run scripts/gen_charsets.py [--out src/lib/charsets.json]
"""

import argparse
import json
import urllib.request

WHATWG_BASE = "https://raw.githubusercontent.com/whatwg/encoding/main"
GSC_BASE = "https://raw.githubusercontent.com/ben-hua/general_standard_chinese/main"

PRESETS = {
    "gbk": (f"{WHATWG_BASE}/index-gb18030.txt", "whatwg"),
    "big5": (f"{WHATWG_BASE}/index-big5.txt", "whatwg"),
    "jis0208": (f"{WHATWG_BASE}/index-jis0208.txt", "whatwg"),
    "euckr": (f"{WHATWG_BASE}/index-euc-kr.txt", "whatwg"),
    "gsc3500": ([f"{GSC_BASE}/gsc_level_1.txt"], "gsc"),
    "gsc6500": (
        [f"{GSC_BASE}/gsc_level_1.txt", f"{GSC_BASE}/gsc_level_2.txt"],
        "gsc",
    ),
    "gsc8105": (
        [
            f"{GSC_BASE}/gsc_level_1.txt",
            f"{GSC_BASE}/gsc_level_2.txt",
            f"{GSC_BASE}/gsc_level_3.txt",
        ],
        "gsc",
    ),
}

SOURCES = {
    "whatwg": {
        "name": "WHATWG Encoding Standard indexes",
        "url": "https://github.com/whatwg/encoding",
        "license": "CC0-1.0",
    },
    "gsc": {
        "name": "ben-hua/general_standard_chinese (通用规范汉字表)",
        "url": "https://github.com/ben-hua/general_standard_chinese",
        "license": "Apache-2.0",
    },
}


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as res:
        return res.read().decode("utf-8")


def parse_whatwg(text):
    cps = set()
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[1].startswith("0x"):
            cps.add(int(parts[1], 16))
    return cps


def parse_gsc(text):
    cps = set()
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            cps.add(ord(parts[1]))
    return cps


def to_ranges(cps):
    pts = sorted(cps)
    if not pts:
        return []
    ranges = []
    start = prev = pts[0]
    for cp in pts[1:]:
        if cp == prev + 1:
            prev = cp
        else:
            ranges.append([start, prev])
            start = prev = cp
    ranges.append([start, prev])
    return ranges


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="src/lib/charsets.json")
    args = ap.parse_args()

    presets = {}
    for pid, (urls, kind) in PRESETS.items():
        if isinstance(urls, str):
            urls = [urls]
        cps = set()
        for url in urls:
            print(f"fetch {url}")
            text = fetch(url)
            cps |= parse_whatwg(text) if kind == "whatwg" else parse_gsc(text)
        ranges = to_ranges(cps)
        presets[pid] = {"count": len(cps), "ranges": ranges}
        print(f"{pid}: {len(cps)} codepoints -> {len(ranges)} ranges")

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"sources": SOURCES, "presets": presets}, f, ensure_ascii=False)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
