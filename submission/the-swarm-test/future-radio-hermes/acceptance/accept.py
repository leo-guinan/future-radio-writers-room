"""The acceptance test.

  python3 acceptance/accept.py fr-work/timeline.json [--mp4 fr-work/episode.mp4] [--mode forward|reverse] [--spec spec/episode.json]

forward: the plugin's remake. Line order exact (ids, speakers, words), every line starts within 0.5 s,
         every card within 0.5 s, runtime within 1 s. Exit code 0 only on a full pass.
reverse: a blind reconstruction from PROMPT.md + ARCHITECTURE.md. The same checks, reported as scores.
"""
import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from load import ROOT, plugin  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("timeline")
ap.add_argument("--mp4")
ap.add_argument("--mode", default="forward", choices=["forward", "reverse"])
ap.add_argument("--spec", default=str(ROOT / "spec/episode.json"))
a = ap.parse_args()
P = plugin().pipeline
r = P.accept(json.loads(open(a.timeline).read()), json.loads(open(a.spec).read()), mp4=a.mp4, mode=a.mode)
for c in r["checks"]:
    print(f"{'PASS' if c['pass'] else 'FAIL'}  {c['check']:<28} {c['score']:.3f}  {c['detail']}")
print(f"\n{a.mode}: {'PASS' if r['pass'] else 'FAIL'} · score {r['score']:.3f}")
sys.exit(0 if r["pass"] else 1)
