"""What runs: each handler takes (args, **kwargs), returns a JSON string and never raises."""
import json
import pathlib
import traceback

from . import pipeline as P

ROOT = pathlib.Path(__file__).resolve().parent


def _p(v, default):
    return pathlib.Path(v or default)


def _spec(args):
    p = pathlib.Path(args.get("spec") or "spec/episode.json")
    if not p.exists():
        p = ROOT / "spec/episode.json"
    return json.loads(p.read_text())


def _safe(fn):
    def handler(args, **kwargs):
        try:
            return json.dumps({"ok": True, **fn(args or {})})
        except Exception as e:  # handlers never raise
            return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-1200:]})
    handler.__name__ = fn.__name__
    return handler


def _lines(w):
    return json.loads((w / "script.json").read_text())


@_safe
def fr_script(args):
    w = _p(args.get("work"), "fr-work"); w.mkdir(parents=True, exist_ok=True)
    L = P.script(args["script"])
    (w / "script.json").write_text(json.dumps(L, indent=1, ensure_ascii=False))
    by = {}
    for l in L:
        by.setdefault(l["scene"], {}).setdefault(l["speaker"], 0)
        by[l["scene"]][l["speaker"]] += 1
    return {"lines": len(L), "scenes": by, "saved": str(w / "script.json")}


@_safe
def fr_voice(args):
    w = _p(args.get("work"), "fr-work")
    S = _spec(args)
    takes = args.get("takes_dir") or (ROOT / "spec/takes")
    G = P.voice(_lines(w), S["voices"]["by_speaker"], w / "takes", takes_dir=takes, model=S["voices"].get("model", "eleven_v4"))
    (w / "groups.json").write_text(json.dumps(G, indent=1, ensure_ascii=False))
    return {"takes": len(G), "recorded": sum(g["source"] == "recorded" for g in G), "generated": sum(g["source"] == "generated" for g in G)}


@_safe
def fr_split(args):
    w = _p(args.get("work"), "fr-work")
    G = json.loads((w / "groups.json").read_text())
    rep = P.split(G, w / "takes", w / "raw")
    return {"clips": sum(len(v) for v in rep.values()), "by_take": rep}


@_safe
def fr_prep(args):
    w = _p(args.get("work"), "fr-work")
    d = P.prep(w / "raw", w / "clips", tempo=float(args.get("tempo") or 1.04))
    return {"clips": len(d), "seconds_of_voice": round(sum(d.values()), 2)}


@_safe
def fr_cards(args):
    w = _p(args.get("work"), "fr-work")
    src = args.get("cards_dir") or (ROOT / "spec/cards")
    return {"cards": P.cards(src, w / "cards")}


@_safe
def fr_timeline(args):
    w = _p(args.get("work"), "fr-work")
    S = _spec(args)
    cues = json.loads(pathlib.Path(args["cues"]).read_text()) if args.get("cues") else P.cues_from_spec(S)
    d = json.loads((w / "clips/durations.json").read_text())
    tl = P.timeline(_lines(w), d, cues)
    (w / "timeline.json").write_text(json.dumps(tl, indent=1, ensure_ascii=False))
    return {"lines": len(tl["lines"]), "cards": len(tl["cards"]), "runtime": tl["runtime"]}


@_safe
def fr_render(args):
    w = _p(args.get("work"), "fr-work")
    tl = json.loads((w / "timeline.json").read_text())
    return P.render(tl, w / "clips", w / "cards", args.get("out") or (w / "episode.mp4"), work_dir=w / "render")


@_safe
def fr_accept(args):
    tl = json.loads(_p(args.get("timeline"), "fr-work/timeline.json").read_text())
    return P.accept(tl, _spec(args), mp4=args.get("mp4"), mode=args.get("mode") or "forward")
