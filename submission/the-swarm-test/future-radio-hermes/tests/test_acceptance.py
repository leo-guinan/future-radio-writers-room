import copy
import json
import os
import pathlib
import subprocess
import sys

import pytest
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "acceptance"))
from load import FakeCtx, plugin  # noqa: E402

SPEC = json.loads((ROOT / "spec/episode.json").read_text())
P = plugin().pipeline


def ref_timeline():
    durs = {l["id"]: l["dur"] for l in SPEC["lines"]}
    return P.timeline(P.script(ROOT / "spec/lines.tsv"), durs, P.cues_from_spec(SPEC))


def test_register_matches_manifest():
    ctx = FakeCtx()
    plugin().register(ctx)
    declared = yaml.safe_load((ROOT / "plugin.yaml").read_text())["provides_tools"]
    assert sorted(ctx.tools) == sorted(declared)
    for t in ctx.tools.values():
        assert t["schema"]["parameters"]["type"] == "object"


def test_handlers_return_json_and_never_raise():
    ctx = FakeCtx()
    plugin().register(ctx)
    out = json.loads(ctx.tools["fr_split"]["handler"]({"work": "/nonexistent"}))
    assert out["ok"] is False and "error" in out


def test_script_matches_spec():
    L = P.script(ROOT / "spec/lines.tsv")
    assert [(l["id"], l["speaker"], l["text"]) for l in L] == [(l["id"], l["speaker"], l["text"]) for l in SPEC["lines"]]


def test_timeline_from_spec_durations_passes():
    r = P.accept(ref_timeline(), SPEC)
    assert r["pass"], r


def test_late_line_fails():
    tl = ref_timeline()
    tl["lines"][40]["start"] += 0.6
    assert not P.accept(tl, SPEC)["pass"]


def test_late_card_fails():
    tl = ref_timeline()
    tl["cards"][5]["start"] += 0.6
    assert not P.accept(tl, SPEC)["pass"]


def test_swapped_lines_fail():
    tl = ref_timeline()
    tl["lines"][3], tl["lines"][4] = tl["lines"][4], tl["lines"][3]
    assert not P.accept(tl, SPEC)["pass"]


def test_long_runtime_fails():
    tl = ref_timeline()
    tl["runtime"] += 1.5
    assert not P.accept(tl, SPEC)["pass"]


def test_reverse_mode_scores_a_paraphrase():
    tl = copy.deepcopy(ref_timeline())
    for l in tl["lines"][::3]:
        l["text"] = "Something else entirely."
    r = P.accept(tl, SPEC, mode="reverse")
    assert not r["pass"] and 0.5 < r["score"] < 1


@pytest.mark.skipif(not os.environ.get("FR_FORWARD"), reason="slow (about 2 minutes): set FR_FORWARD=1")
def test_forward_end_to_end(tmp_path):
    r = subprocess.run([sys.executable, str(ROOT / "acceptance/forward.py"), "--work", str(tmp_path / "w")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
