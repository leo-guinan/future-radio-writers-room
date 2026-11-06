# Architecture

How a Future Radio episode is made, from script to screen. Test 1 follows these steps forward. Test 2 starts from
[`PROMPT.md`](PROMPT.md) and this page, and works out what they produce.

## The show

Future Radio is a small animated studio with a monitor on the back wall. Each episode answers something real: a reply, a
post, a request. The cast research it on air and end by sending something out.

| Speaker | Role | Voice (ElevenLabs) |
|---|---|---|
| `LEONARDO` | Throws ideas. Enthusiastic, quick, lots of exclamation marks. | `s5t7B6IvxVOp3Y7HQT6Q` |
| `BORGES` | Reads the sources aloud. Precise, dry, the librarian. | `TLugb594bskyzPlFSOkh` |
| `AGNOLO` | Keeps the books. Strict about claims, tolerances and what is owed. | `yowh82B72eMNrxcxHgBh` |
| `MRS. BUS` | Dispatch. Brings the mail at the top and asks where the reply is going at the end. | `xN5u3GiLKTdbPJybr6kp` |
| `EVAL` | The monitor's voice. Rare; shouts a review. | `2WmCrP0cJGnh2QX210KX` |

All voices use the model `eleven_v4`.

### House rules

- **Real people who aren't in the cast don't speak.** Their own words appear as screenshots, or are quoted from public posts.
- **Every claim has a source.** Quotes come only from public posts, or from Leo's side of the Community Archive.
- **Proposals stay proposals.** Nothing is described as agreed or paid unless it is. The ending says so out loud.
- **Personal threads stay out.**

### The shape of an episode

1. **Cold open.** Mrs. Bus brings mail. Borges reads it.
2. **The record.** Borges reads the sources; Agnolo checks them; Leonardo reacts.
3. **The idea.** Leonardo throws one.
4. **The work.** The cast make it precise: steps, numbers, a test.
5. **The dispatch.** Mrs. Bus asks where it's going and what is owed. Leonardo turns to the camera. The credits roll, with the
   honesty notes.
6. **Post-credits.** A short gag of two to five lines.

The house length is five to six minutes, with seven scenes or fewer.

## The pipeline

### 1. Script: `fr_script`

A tab-separated table with one line per row:

```
e1_001	MRS. BUS	Mail for the station.
e1_002	LEONARDO	What does it say?
```

- **id:** `e<scene>_<nnn>`. The scene is the part before `_`.
- **speaker:** one of the five cast names above.
- **line:** the spoken text. Quotation marks in it are kept.

### 2. Voice: `fr_voice`

- Each character records **one take per scene**: all of that character's lines in the scene, joined by
  `\n\n[long pause]\n\n`.
- Takes are named `<scene>_<first 4 characters of the voice id>.mp3`, e.g. `e1_s5t7.mp3`.
- This is the only step that isn't deterministic: a new take has new timing.

### 3. Split: `fr_split`

- Each take is cut at its N−1 longest silences, where N is the number of lines in it.
- Silences come from ffmpeg's `silencedetect`. It tries -40 dB/0.35 s, then -35 dB/0.25 s, then -30 dB/0.18 s, stopping when
  it finds enough.
- Cuts sit at the middle of each silence. Each clip keeps 0.08 s before its speech and 0.12 s after.
- Each clip is re-encoded with 0.05 s of padding.

### 4. Prep: `fr_prep`

- Silence is trimmed at both ends: -45 dB threshold, 0.04 s kept.
- Each clip is sped up 4% (`atempo=1.04`, pitch kept): everyone talks a little slowly at first.
- Loudness is normalized to -18 LUFS, true peak -1.5 dB.
- **A line's duration** is how the studio's mouths count it: 30 envelope values a second from 16 kHz mono audio, so
  `floor(samples / 533) / 30`.

### 5. Cards: `fr_cards`

- The monitor shows one card at a time.
- Each card is an HTML page at 1280×720, photographed: dark ground, amber kicker, a big headline or a table, a grey footnote.
- A card can also be a screenshot of a source, such as a post.
- Cards are named `c0`, `c1`, … in the order they appear.

### 6. Timeline: `fr_timeline`

Every line is laid end to end with a cued gap before it:

| Event | Timing |
|---|---|
| Title card ("FUTURE RADIO" / the episode title) | 0.4–3.4 s |
| First line | 2.6 s |
| Between two lines by different speakers | 0.14 s |
| Between two lines by the same speaker | 0.22 s |
| Scene break | +1.0 to 1.4 s, with a sound sweep |
| Dramatic beat (a pause before a reveal) | +0.2 to 0.6 s |

- A card appears when the line that introduces it starts, and stays until the next card.
- The credits start 1.6 s after the last line before the post-credits scene, and run for 5.8 s.
- The post-credits scene starts about 8.6 s after that line.
- The film ends at the next whole second after the last line ends plus 2.6 s.

The cue sheet holds all of this: the gaps before each line, and the line each card and the credits hang on. `timeline.json`
is the result:

```json
{
  "lines":   [{"id": "e1_001", "speaker": "MRS. BUS", "text": "…", "start": 2.6, "dur": 4.3}],
  "cards":   [{"id": "c0", "start": 8.38}],
  "title_card": {"lines": ["FUTURE RADIO", "…"], "from": 0.4, "to": 3.4},
  "credits": {"from": 0.0, "to": 0.0, "lines": ["FUTURE RADIO", "…"]},
  "runtime": 0
}
```

### 7. Render: `fr_render`

- 1280×720 at 30 fps. Each voice clip is placed at its start, and the mix is normalized to -16 LUFS.
- The studio's own renderer draws the cast, the camera, the monitor and the music.
- This starter's renderer draws the cards full frame with subtitles.

## Acceptance

`acceptance/accept.py` compares a `timeline.json`, and optionally an mp4, with `spec/episode.json`.

| Check | Forward (test 1) | Reverse (test 2) |
|---|---|---|
| Line order | ids, speakers and text exact | speaker sequence and word-sequence similarity, scored |
| Line starts | every line within 0.5 s | fraction within 0.5 s |
| Card starts | every card within 0.5 s | fraction within 0.5 s |
| Runtime | within 1 s (measured from the mp4 if given) | same |
