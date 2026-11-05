"""Test 1, end to end: run the plugin's seven tools on this episode's script, takes and cards, then accept.

  python3 acceptance/forward.py [--work fr-work]

Runs the handlers exactly as Hermes would call them (through register(ctx)), so it needs no Hermes install.
"""
import argparse
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from load import ROOT, FakeCtx, plugin  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--work", default="fr-work")
a = ap.parse_args()
ctx = FakeCtx()
plugin().register(ctx)
call = lambda n, **kw: json.loads(ctx.tools[n]["handler"](kw))
steps = [("fr_script", {"script": str(ROOT / "spec/lines.tsv")}), ("fr_voice", {"takes_dir": str(ROOT / "spec/takes")}), ("fr_split", {}),
         ("fr_prep", {}), ("fr_cards", {}), ("fr_timeline", {}), ("fr_render", {})]
for name, kw in steps:
    t = time.time()
    r = call(name, work=a.work, **kw)
    print(f"{name:<12} {time.time() - t:6.1f}s  {json.dumps({k: v for k, v in r.items() if k not in ('by_take', 'scenes', 'trace')})[:150]}")
    if not r["ok"]:
        print(r.get("trace", "")); sys.exit(2)
r = call("fr_accept", timeline=f"{a.work}/timeline.json", mp4=f"{a.work}/episode.mp4")
for c in r["checks"]:
    print(f"{'PASS' if c['pass'] else 'FAIL'}  {c['check']:<28} {c['detail']}")
print("\nforward:", "PASS" if r["pass"] else "FAIL")
sys.exit(0 if r["pass"] else 1)
