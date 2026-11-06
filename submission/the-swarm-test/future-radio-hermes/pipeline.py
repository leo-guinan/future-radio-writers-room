"""Future Radio, script to screen, as plain functions. tools.py wraps each one as a Hermes tool.

Steps (see ARCHITECTURE.md):
  1 script    script table -> lines
  2 voice     one take per scene per character (or reuse recorded takes)
  3 split     cut each take at its longest silences, one clip per line
  4 prep      trim, level, +4% tempo; measure durations the way the studio does
  5 cards     monitor cards: HTML pages, photographed
  6 timeline  durations + cue sheet -> absolute times for every line, card, title and credit
  7 render    cards + voice + subtitles -> mp4
  accept      compare a timeline (and optionally an mp4) with the reference spec

Only the standard library and ffmpeg/ffprobe are required. Step 5 needs Playwright; step 2 needs an
ElevenLabs API key unless you reuse the recorded takes.
"""
from __future__ import annotations

import csv
import json
import os
import pathlib
import re
import shutil
import subprocess
import urllib.request
from difflib import SequenceMatcher

PAUSE = "\n\n[long pause]\n\n"
ATTEMPTS = [(-40, 0.35), (-35, 0.25), (-30, 0.18)]  # silencedetect: noise dB, min duration s


def _run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def probe_duration(path) -> float:
    out = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]).stdout
    return float(out.strip())


# 1 ---------------------------------------------------------------------------------------------
def script(path) -> list[dict]:
    """Read a tab-separated script: id, SPEAKER, line. The id's prefix before '_' is the scene."""
    lines = []
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            if not row or not row[0].strip() or row[0].startswith("#"):
                continue
            i, speaker, text = row[0].strip(), row[1].strip(), row[2].strip()
            lines.append({"id": i, "scene": i.split("_")[0], "speaker": speaker, "text": text})
    ids = [l["id"] for l in lines]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate line ids")
    return lines


def groups(lines: list[dict], voices: dict) -> list[dict]:
    """One take per scene per character, in order of first appearance."""
    out, seen = [], {}
    for l in lines:
        v = voices[l["speaker"]]
        key = f"{l['scene']}_{v[:4]}"
        if key not in seen:
            seen[key] = {"key": key, "voice": v, "speaker": l["speaker"], "ids": [], "texts": []}
            out.append(seen[key])
        seen[key]["ids"].append(l["id"])
        seen[key]["texts"].append(l["text"])
    return out


# 2 ---------------------------------------------------------------------------------------------
def voice(lines, voices, out_dir, takes_dir=None, model="eleven_v4", api_key=None) -> list[dict]:
    """Write takes/<scene>_<voice4>.mp3. Reuses recorded takes when takes_dir has them; otherwise calls
    ElevenLabs text-to-speech with the lines joined by long pauses."""
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    G = groups(lines, voices)
    for g in G:
        dst = out / f"{g['key']}.mp3"
        src = pathlib.Path(takes_dir) / f"{g['key']}.mp3" if takes_dir else None
        if src and src.exists():
            if src.resolve() != dst.resolve():
                shutil.copyfile(src, dst)
            g["source"] = "recorded"
            continue
        key = api_key or os.environ.get("ELEVENLABS_API_KEY")
        if not key:
            raise RuntimeError(f"no recorded take for {g['key']} and no ELEVENLABS_API_KEY")
        req = urllib.request.Request(
            f"https://api.elevenlabs.io/v1/text-to-speech/{g['voice']}?output_format=mp3_44100_128",
            data=json.dumps({"text": PAUSE.join(g["texts"]), "model_id": model}).encode(),
            headers={"xi-api-key": key, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=300) as r:
            dst.write_bytes(r.read())
        g["source"] = "generated"
    return G


# 3 ---------------------------------------------------------------------------------------------
def split(G, takes_dir, raw_dir) -> dict:
    """Cut each take at its N-1 longest silences into raw/<id>.mp3, then re-encode with a short pad."""
    raw = pathlib.Path(raw_dir)
    raw.mkdir(parents=True, exist_ok=True)
    report = {}
    for g in G:
        f = str(pathlib.Path(takes_dir) / f"{g['key']}.mp3")
        n, D = len(g["ids"]), probe_duration(f)
        if n == 1:
            bounds = [(0, D)]
        else:
            sil = []
            for th, md in ATTEMPTS:
                err = subprocess.run(["ffmpeg", "-nostdin", "-i", f, "-af", f"silencedetect=noise={th}dB:d={md}", "-f", "null", "-"],
                                     capture_output=True, text=True).stderr
                st = [float(v) for v in re.findall(r"silence_start: ([\d.]+)", err)]
                en = [float(v) for v in re.findall(r"silence_end: ([\d.]+)", err)]
                sil = [(a, b) for a, b in zip(st, en) if a > 0.2 and b < D - 0.1]
                if len(sil) >= n - 1:
                    break
            if len(sil) < n - 1:
                raise RuntimeError(f"{g['key']}: found {len(sil)} silences for {n} lines")
            cut = sorted(sorted(sil, key=lambda s: s[1] - s[0], reverse=True)[: n - 1])
            mids = [0] + [(a + b) / 2 for a, b in cut] + [D]
            bounds = []
            for i in range(n):
                s, e = mids[i], mids[i + 1]
                if i > 0:
                    s = max(s, cut[i - 1][1] - 0.08)
                if i < n - 1:
                    e = min(e, cut[i][0] + 0.12)
                bounds.append((s, e))
        for i, (s, e) in zip(g["ids"], bounds):
            tmp = raw / f".{i}.mp3"
            cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", f] + (["-ss", f"{s:.3f}", "-to", f"{e:.3f}"] if n > 1 else [])
            _run(cmd + ["-c:a", "libmp3lame", "-q:a", "2", str(tmp)])
            _run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(tmp), "-af", "apad=pad_dur=0.05", "-c:a", "libmp3lame", "-q:a", "2", str(raw / f"{i}.mp3")])
            tmp.unlink()
        report[g["key"]] = [round(e - s, 2) for s, e in bounds]
    return report


# 4 ---------------------------------------------------------------------------------------------
def studio_duration(path) -> float:
    """The studio times a line by its mouth envelope: 30 values a second, from 16 kHz mono audio."""
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    return (len(raw) // 2 // (16000 // 30)) / 30


def prep(raw_dir, out_dir, ids=None, tempo=1.04, lufs=-18, pad=0.04, threshold_db=-45) -> dict:
    """Trim silence at both ends, speed up (pitch kept), normalize loudness. Returns {id: seconds}."""
    raw, out = pathlib.Path(raw_dir), pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    trim = (f"silenceremove=start_periods=1:start_threshold={threshold_db}dB:start_silence={pad},"
            f"areverse,silenceremove=start_periods=1:start_threshold={threshold_db}dB:start_silence={pad},areverse,"
            + (f"atempo={tempo}," if tempo != 1 else "") + f"loudnorm=I={lufs}:TP=-1.5:LRA=11")
    durs = {}
    for src in sorted(raw.glob("*.mp3")):
        i = src.stem
        if ids and i not in ids:
            continue
        wav, mp3 = out / f"{i}.wav", out / f"{i}.mp3"
        _run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "48000", "-af", trim, str(wav)])
        _run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(wav), "-c:a", "libmp3lame", "-b:a", "128k", str(mp3)])
        wav.unlink()
        durs[i] = round(studio_duration(mp3), 3)
    (out / "durations.json").write_text(json.dumps(durs, indent=1))
    return durs


# 5 ---------------------------------------------------------------------------------------------
def cards(cards_dir, out_dir, ids=None) -> list[str]:
    """Photograph each cards/<id>.html at 1280x720 into <out>/<id>.png (needs Playwright)."""
    from playwright.sync_api import sync_playwright
    src, out = pathlib.Path(cards_dir), pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    done = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1280, "height": 720})
        for h in sorted(src.glob("*.html"), key=lambda x: (len(x.stem), x.stem)):
            if ids and h.stem not in ids:
                continue
            pg.goto(h.resolve().as_uri())
            pg.wait_for_timeout(700)
            pg.screenshot(path=str(out / f"{h.stem}.png"))
            done.append(h.stem)
        b.close()
    return done


# 6 ---------------------------------------------------------------------------------------------
def timeline(lines, durations, cues) -> dict:
    """Lay every line end to end with its cued gap, then hang cards and credits on their anchor lines.
    cues = {"gaps": {id: s}, "cards": [{id, anchor, offset}], "title": {...}, "credits": {anchor, offset_from_line_end, lines}, "tail_s": s}"""
    t, out = 0.0, []
    for l in lines:
        t += cues["gaps"][l["id"]]
        d = durations[l["id"]]
        out.append({"id": l["id"], "speaker": l["speaker"], "text": l["text"], "start": round(t, 3), "dur": d})
        t += d
    at = {l["id"]: l for l in out}
    cs = [{"id": c["id"], "start": round(at[c["anchor"]]["start"] + c["offset"], 3)} for c in cues["cards"]]
    cr = cues["credits"]
    a = at[cr["anchor"]]
    c0 = a["start"] + a["dur"] + cr["offset_from_line_end"]
    return {"lines": out, "cards": cs, "title_card": cues["title"], "credits": {"from": round(c0, 3), "to": round(c0 + cr.get("hold_s", 5.8), 3), "lines": cr["lines"]},
            "runtime": round(t + cues["tail_s"], 3)}


def cues_from_spec(spec) -> dict:
    """The director's cue sheet, taken from a spec: gaps before each line, and what each card hangs on."""
    return {"gaps": {l["id"]: l["gap_before"] for l in spec["lines"]},
            "cards": [{"id": c["id"], "anchor": c["anchor"], "offset": c["offset"]} for c in spec["cards"]],
            "title": spec["title_card"],
            "credits": {"anchor": spec["credits"]["anchor"], "offset_from_line_end": spec["credits"]["offset_from_line_end"],
                        "hold_s": round(spec["credits"]["to"] - spec["credits"]["from"], 3), "lines": spec["credits"]["lines"]},
            "tail_s": spec["tail_s"]}


# 7 ---------------------------------------------------------------------------------------------
def _ts(s):
    h, m = int(s // 3600), int(s % 3600 // 60)
    return f"{h:02d}:{m:02d}:{s % 60:06.3f}".replace(".", ",")


def render(tl, clips_dir, cards_png_dir, out_mp4, work_dir=None, fps=30) -> dict:
    """A plain renderer: the monitor cards full-frame, the cast's voices, burned-in subtitles.
    (The reference film's animated studio is not part of this starter; the spec checks timing, not pixels.)"""
    work = pathlib.Path(work_dir or pathlib.Path(out_mp4).parent / "work_render")
    work.mkdir(parents=True, exist_ok=True)
    R = tl["runtime"]
    # video: black, title, cards in order, credits on black
    from html import escape
    def text_card(name, rows):
        h = work / f"{name}.html"
        h.write_text('<html><body style="margin:0;width:1280px;height:720px;background:#000;color:#f3ecdc;font-family:monospace;'
                     'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center">'
                     + "".join(f'<div style="font-size:{s}px;color:{c}">{escape(t)}</div>' for t, s, c in rows) + "</body></html>")
        return h
    t0 = tl["title_card"]
    text_card("title", [(t0["lines"][0], 28, "#e7a23c"), (t0["lines"][1], 56, "#f3ecdc")])
    cr = tl["credits"]
    text_card("credits", [(x, 34 if i < 2 else 22, "#e7a23c" if i == 0 else "#f3ecdc") for i, x in enumerate(cr["lines"])])
    cards(work, work, ids=["title", "credits"])
    black = work / "black.png"
    _run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=black:s=1280x720", "-frames:v", "1", str(black)])
    segs = [(0, t0["from"], black), (t0["from"], t0["to"], work / "title.png")]
    cs = sorted(tl["cards"], key=lambda c: c["start"])
    segs.append((t0["to"], cs[0]["start"], black))
    for i, c in enumerate(cs):
        end = cs[i + 1]["start"] if i + 1 < len(cs) else R
        png = pathlib.Path(cards_png_dir) / f"{c['id']}.png"
        if c["start"] < cr["from"] <= end:
            segs += [(c["start"], cr["from"], png), (cr["from"], cr["to"], work / "credits.png"), (cr["to"], end, png)]
        else:
            segs.append((c["start"], end, png))
    lst = work / "video.txt"
    with open(lst, "w") as f:
        for a, b, p in segs:
            if b - a > 1e-3:
                f.write(f"file '{pathlib.Path(p).resolve()}'\nduration {b - a:.3f}\n")
        f.write(f"file '{pathlib.Path(segs[-1][2]).resolve()}'\n")
    # audio: every clip placed at its start, mixed in float
    import array
    SR = 48000
    mix = array.array("f", bytes(4 * int(SR * (R + 1))))
    for l in tl["lines"]:
        pcm = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(pathlib.Path(clips_dir) / f"{l['id']}.mp3"), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                             capture_output=True, check=True).stdout
        x = array.array("f"); x.frombytes(pcm)
        o = int(l["start"] * SR)
        for k in range(min(len(x), len(mix) - o)):
            mix[o + k] += x[k]
    wav = work / "voice.f32"
    wav.write_bytes(mix.tobytes())
    srt = work / "subs.srt"
    srt.write_text("\n".join(f"{n + 1}\n{_ts(l['start'])} --> {_ts(l['start'] + l['dur'] + 0.1)}\n{l['speaker']}: {l['text']}\n" for n, l in enumerate(tl["lines"])))
    _run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", str(wav),
          "-vf", f"fps={fps},format=yuv420p,subtitles={srt}:force_style='FontSize=18,MarginV=24'", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "192k", "-t", f"{R:.3f}", "-movflags", "+faststart", str(out_mp4)])
    return {"mp4": str(out_mp4), "runtime": round(probe_duration(out_mp4), 3), "segments": len(segs)}


# acceptance ----------------------------------------------------------------------------------
def accept(candidate: dict, reference: dict, mp4=None, mode="forward") -> dict:
    """forward: exact text and order, line starts and card starts within tolerance, runtime within tolerance.
    reverse: the same checks, scored as fractions (a blind remake is not expected to match word for word)."""
    tol = reference["tolerances"]
    R, C = reference["lines"], candidate["lines"]
    checks = []
    def add(name, ok, score, detail):
        checks.append({"check": name, "pass": bool(ok), "score": round(score, 3), "detail": detail})
    # line order
    if mode == "forward":
        same = [(r["id"], r["speaker"], r["text"]) for r in R] == [(c.get("id"), c["speaker"], c["text"]) for c in C]
        add("line order (exact)", same, 1.0 if same else 0.0, f"{len(C)} of {len(R)} lines")
    else:
        sp = SequenceMatcher(None, [r["speaker"] for r in R], [c["speaker"] for c in C]).ratio()
        tx = SequenceMatcher(None, " ".join(r["text"] for r in R).lower().split(), " ".join(c["text"] for c in C).lower().split()).ratio()
        add("line order (speakers)", sp == 1 and len(R) == len(C), sp, f"{len(C)} lines vs {len(R)}")
        add("words (similarity)", tx > 0.99, tx, "word-sequence similarity to the reference script")
    # line starts: by position
    n = min(len(R), len(C))
    within = sum(abs(R[i]["start"] - C[i]["start"]) <= tol["line_start_s"] for i in range(n))
    worst = max((abs(R[i]["start"] - C[i]["start"]) for i in range(n)), default=0)
    add(f"line starts within {tol['line_start_s']}s", within == len(R) == len(C), within / len(R), f"{within}/{len(R)}; worst {worst:.2f}s")
    # cards
    rc = {c["id"]: c["start"] for c in reference["cards"]}
    cc = {c["id"]: c["start"] for c in candidate.get("cards", [])}
    ok = [k for k in rc if k in cc and abs(rc[k] - cc[k]) <= tol["card_start_s"]]
    add(f"card starts within {tol['card_start_s']}s", len(ok) == len(rc), len(ok) / len(rc), f"{len(ok)}/{len(rc)}")
    # runtime
    rt = probe_duration(mp4) if mp4 else candidate["runtime"]
    d = abs(rt - reference["runtime"])
    add(f"runtime within {tol['runtime_s']}s", d <= tol["runtime_s"], max(0.0, 1 - d / max(1.0, reference["runtime"])),
        f"{rt:.2f}s vs {reference['runtime']}s" + (" (measured from the mp4)" if mp4 else ""))
    return {"mode": mode, "pass": all(c["pass"] for c in checks), "score": round(sum(c["score"] for c in checks) / len(checks), 3), "checks": checks}
