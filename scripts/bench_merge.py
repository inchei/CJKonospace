"""Benchmark the local merger, optionally against an unchanged Git revision.

Run with the same Python environment as merge_font.py. Outputs and profiles
belong outside the repository, for example under /tmp/opencode/.
"""

import argparse
import cProfile
import functools
import json
import resource
import subprocess
import sys
import time
import types
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
STAGES = (
    "_subset_cjk",
    "_instance_variable_fonts",
    "_to_glyf",
    "_adjust_mono_advances",
    "_append_cjk",
    "_merge_cmap",
    "_synthesize_names",
    "_decompose_nested_composites",
    "_update_metrics",
    "_update_vertical_metrics",
    "_build_variable",
)


def compare_fonts(actual, expected):
    """Compare compiled tables, ignoring timestamps and the file checksum."""
    with (
        TTFont(actual, recalcTimestamp=False) as a,
        TTFont(expected, recalcTimestamp=False) as b,
    ):
        if set(a.keys()) != set(b.keys()):
            raise AssertionError("Output table sets differ")
        for font in (a, b):
            font["head"].created = font["head"].modified = 0
            font["head"].checkSumAdjustment = 0
        different = [
            tag
            for tag in a.keys()  # noqa: SIM118 -- TTFont iterates its reader
            if tag != "GlyphOrder" and a.getTableData(tag) != b.getTableData(tag)
        ]
        if different:
            raise AssertionError(f"Output tables differ: {different}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mono", type=Path)
    parser.add_argument("cjk", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--params", type=Path)
    parser.add_argument("--revision", help="Load merger source from this Git revision")
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--profile", type=Path)
    parser.add_argument("--reference", type=Path)
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    source = (
        subprocess.check_output(
            ["git", "show", f"{args.revision}:wasm/merge_font.py"], cwd=ROOT
        ).decode()
        if args.revision
        else (ROOT / "wasm/merge_font.py").read_text()
    )
    merger = types.ModuleType("bench_merger")
    exec(compile(source, "wasm/merge_font.py", "exec"), merger.__dict__)
    params = json.loads(args.params.read_text()) if args.params else {}
    timings = {}

    def instrument(name):
        original = getattr(merger, name)

        @functools.wraps(original)
        def timed(*a, **kw):
            start = time.perf_counter()
            try:
                return original(*a, **kw)
            finally:
                timings[name] = timings.get(name, 0) + time.perf_counter() - start

        setattr(merger, name, timed)

    for name in STAGES:
        instrument(name)
    import fontTools
    import numpy

    print(
        json.dumps(
            {
                "python": sys.version,
                "fonttools": fontTools.__version__,
                "numpy": numpy.__version__,
                "revision": args.revision or "working-tree",
                "params": params,
            }
        ),
        flush=True,
    )
    for run in range(args.repeat):
        timings.clear()
        profiler = cProfile.Profile() if args.profile else None
        start = time.perf_counter()
        if profiler:
            profiler.enable()
        meta = merger.merge(str(args.mono), str(args.cjk), str(args.output), params)
        if profiler:
            profiler.disable()
            profiler.dump_stats(str(args.profile))
        elapsed = time.perf_counter() - start
        print(
            json.dumps(
                {
                    "run": run + 1,
                    "seconds": elapsed,
                    "stages": dict(timings),
                    "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                    "bytes": args.output.stat().st_size,
                    "meta": meta,
                }
            ),
            flush=True,
        )
    if args.reference:
        compare_fonts(args.output, args.reference)
        print("Output tables match reference (except timestamps/checksum).", flush=True)


if __name__ == "__main__":
    main()
