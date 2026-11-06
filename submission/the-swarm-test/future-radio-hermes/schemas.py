"""What the model sees: one schema per step. Paths are relative to the agent's working directory."""

def _s(name, description, props, required=()):
    return {"name": name, "description": description,
            "parameters": {"type": "object", "properties": props, "required": list(required)}}

W = {"type": "string", "description": "Working folder for this episode (default fr-work)."}
SPEC = {"type": "string", "description": "Reference spec, for voices and cues (default spec/episode.json)."}

FR_SCRIPT = _s("fr_script", "Step 1. Read a tab-separated script (id, SPEAKER, line) and save it as <work>/script.json. "
               "Reports lines per scene and per speaker.", {"script": {"type": "string", "description": "Path to the .tsv script."}, "work": W}, ["script"])
FR_VOICE = _s("fr_voice", "Step 2. One take per scene per character, lines joined by long pauses. Reuses recorded takes from takes_dir "
              "when present; otherwise calls ElevenLabs (needs ELEVENLABS_API_KEY).",
              {"work": W, "spec": SPEC, "takes_dir": {"type": "string", "description": "Folder of recorded takes, named <scene>_<voice4>.mp3."}})
FR_SPLIT = _s("fr_split", "Step 3. Cut each take at its longest silences, one clip per line, into <work>/raw.", {"work": W})
FR_PREP = _s("fr_prep", "Step 4. Trim, level and speed up each clip (+4% by default) into <work>/clips, and measure durations.",
             {"work": W, "tempo": {"type": "number", "description": "Pitch-preserving speed-up (default 1.04)."}})
FR_CARDS = _s("fr_cards", "Step 5. Photograph each monitor card (an HTML page) at 1280x720 into <work>/cards.",
              {"work": W, "cards_dir": {"type": "string", "description": "Folder of <id>.html cards (default spec/cards)."}})
FR_TIMELINE = _s("fr_timeline", "Step 6. Place every line, card, title and credit on the clock from the clip durations and a cue sheet, "
                 "into <work>/timeline.json.", {"work": W, "spec": SPEC, "cues": {"type": "string", "description": "Optional cue-sheet JSON; defaults to the spec's cues."}})
FR_RENDER = _s("fr_render", "Step 7. Render <work>/timeline.json to an mp4: cards, voices and subtitles.",
               {"work": W, "out": {"type": "string", "description": "Output mp4 (default <work>/episode.mp4)."}})
FR_ACCEPT = _s("fr_accept", "Acceptance test. Compare a timeline (and optionally an mp4) with the reference spec. "
               "forward = the plugin's remake must match; reverse = a blind reconstruction, scored.",
               {"timeline": {"type": "string", "description": "Candidate timeline JSON (default fr-work/timeline.json)."}, "spec": SPEC,
                "mp4": {"type": "string", "description": "Optional mp4 whose measured runtime is checked."},
                "mode": {"type": "string", "enum": ["forward", "reverse"]}})
ALL = [FR_SCRIPT, FR_VOICE, FR_SPLIT, FR_PREP, FR_CARDS, FR_TIMELINE, FR_RENDER, FR_ACCEPT]
