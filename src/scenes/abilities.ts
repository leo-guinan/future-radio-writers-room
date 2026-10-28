// What characters can do in a scene besides talk.
//
// design-voice: describe a voice and have three candidates made (ElevenLabs Voice Design). The
// character either chooses one on the spot, for a guest who has no voice yet, or offers all
// three for review. It costs real money, so the bill arrives in the scene, addressed to whoever
// plays accounting, and the next line is theirs. The previews are kept, the design is on the
// record, and the cost is on the ledger (priced with VOICE_DESIGN_PRICE_USD, otherwise as
// previews of unknown cost, never as free).

import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Room, Scene } from "../core/room.ts";
import { RuleError } from "../core/room.ts";
import { isPrincipal, playedBy } from "../core/cast.ts";
import { nameOf } from "../agents/characters.ts";
import { cacheDir } from "./voice.ts";

export const DESIGN_MODEL = () => process.env.VOICE_DESIGN_MODEL ?? "eleven_ttv_v3";
export const designDir = () => join(cacheDir(), "designs");
const API = "https://api.elevenlabs.io/v1";

export interface ServiceOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

const key = (o: ServiceOptions) => o.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "";

export interface DesignRequest {
  by: string;
  forCharacter: string;
  description: string;
  sample?: string; // 100–1000 characters for the previews to speak; otherwise the service writes one
  mode: "choose" | "offer";
  sceneId?: string;
  afterTurn?: number;
}

/** Ask for three candidate voices; keep their audio; put the design on the record and the bill on the ledger. */
export async function designVoice(room: Room, r: DesignRequest, o: ServiceOptions = {}) {
  const apiKey = key(o);
  if (!apiKey) throw new RuleError("voice", "Voice design isn't switched on in this room (no ELEVENLABS_API_KEY).");
  const description = r.description.trim().slice(0, 1000);
  if (description.length < 20) throw new RuleError("voice", "Describe the voice in at least a sentence.");
  const sample = r.sample && r.sample.length >= 100 ? r.sample.slice(0, 1000) : undefined;
  const model = DESIGN_MODEL();
  const res = await (o.fetchImpl ?? fetch)(`${API}/text-to-voice/design`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ voice_description: description, model_id: model, ...(sample ? { text: sample } : { auto_generate_text: true }) }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(body.previews) || !body.previews.length)
    throw new RuleError("voice", `The voice designer said no (${res.status}${body.detail?.message ? `: ${body.detail.message}` : ""}).`);

  const designId = room.nextDesignId();
  mkdirSync(designDir(), { recursive: true });
  const previews = body.previews.slice(0, 3).map((p: any, i: number) => {
    const bytes = Buffer.from(String(p.audio_base_64), "base64");
    const file = join(designDir(), `${designId}-${i + 1}.mp3`);
    writeFileSync(`${file}.part`, bytes);
    renameSync(`${file}.part`, file);
    return { k: i + 1, generatedVoiceId: String(p.generated_voice_id), sha256: createHash("sha256").update(bytes).digest("hex"), file: `${designId}-${i + 1}.mp3`, durationSecs: Number.isFinite(p.duration_secs) ? p.duration_secs : null };
  });
  const price = Number(process.env.VOICE_DESIGN_PRICE_USD);
  const costUsd = Number.isFinite(price) && price > 0 ? price : null;
  room.recordVoiceDesign(r.by, {
    designId,
    by: r.by,
    forCharacter: r.forCharacter,
    description,
    sample: String(body.text ?? sample ?? ""),
    model,
    mode: r.mode,
    previews,
    costUsd,
    ...(r.sceneId ? { sceneId: r.sceneId, afterTurn: r.afterTurn } : {}),
  });
  // The vendor sends the bill; the room books it as it arrives.
  room.store.append(
    "ledger.entry",
    "elevenlabs",
    {
      entryId: `L-${String(room.ledger.length + 1).padStart(4, "0")}`,
      ledger: "operations",
      kind: "expense",
      amount: costUsd ?? previews.length,
      unit: costUsd === null ? "previews" : "usd",
      status: costUsd === null ? "unknown" : "observed",
      label: `Voice design ${designId}: ${previews.length} candidate voices for ${r.forCharacter}, ordered by ${r.by}${r.sceneId ? ` in ${r.sceneId}` : ""}`,
      evidence: `voice design ${designId}`,
      ...(r.sceneId ? { episodeId: room.scenes.get(r.sceneId)?.episodeId } : {}),
    },
    "public",
  );
  return room.voiceDesigns.get(designId)!;
}

/** Make one preview a voice and give it to a character, in a scene's lineage or room-wide. */
export async function selectDesignedVoice(
  room: Room,
  designId: string,
  k: number,
  opts: ServiceOptions & { by: string; character?: string; name?: string; sceneId?: string },
) {
  const d = room.voiceDesigns.get(designId);
  if (!d) throw new RuleError("voice", `No voice design ${designId}.`);
  const p = d.previews.find((x) => x.k === k);
  if (!p) throw new RuleError("voice", `${designId} has no preview ${k}.`);
  const apiKey = key(opts);
  if (!apiKey) throw new RuleError("voice", "Voice design isn't switched on in this room (no ELEVENLABS_API_KEY).");
  const character = opts.character ?? d.forCharacter;
  const name = (opts.name ?? `${nameOf(character)} — ${designId}.${k}`).slice(0, 100);
  const res = await (opts.fetchImpl ?? fetch)(`${API}/text-to-voice`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ voice_name: name, voice_description: d.description, generated_voice_id: p.generatedVoiceId }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.voice_id) throw new RuleError("voice", `The voice service wouldn't save it (${res.status}).`);
  room.selectVoice(opts.by, { designId, k, character, voiceId: String(body.voice_id), name, by: opts.by, ...(opts.sceneId ? { sceneId: opts.sceneId } : {}) });
  return { voiceId: String(body.voice_id), name, character };
}

// ---------------------------------------------------------------- in a scene

export interface DesignAction {
  forCharacter: string;
  description: string;
  mode: "choose" | "offer";
  pick: number;
}

const ACTION = /^[ \t]*\**DESIGN VOICE\**\b[: ]*(.*)$/im;

/** Split a reply into the spoken line and the action line, if there is one. */
export function parseAction(text: string): { text: string; action: DesignAction | null } {
  const m = ACTION.exec(text ?? "");
  if (!m) return { text, action: null };
  const rest = text.replace(m[0], "").trim();
  const parts = m[1].split("|").map((x) => x.trim());
  const forCharacter = (parts[0] ?? "").replace(/^for\s+/i, "").trim().toLowerCase();
  const description = (parts[1] ?? "").replace(/^["“]|["”]$/g, "").trim();
  const how = (parts[2] ?? "").toLowerCase();
  const pick = Math.min(3, Math.max(1, Number(/([123])/.exec(how)?.[1] ?? 1)));
  return { text: rest, action: forCharacter && description ? { forCharacter, description, mode: /offer|review/.test(how) ? "offer" : "choose", pick } : null };
}

export const can = (s: Scene, who: string, ability: string) => !!s.abilities?.[who]?.includes(ability);

/** What the speaker is told about an ability, if they have one and haven't used it here yet. */
export function abilityNote(room: Room, s: Scene, who: string, nameIn: (s: Scene, c: string) => string): string {
  if (!can(s, who, "design-voice")) return "";
  if ([...room.voiceDesigns.values()].some((d) => d.sceneId === s.sceneId && d.by === who)) return "";
  const targets = s.cast.filter((c) => c !== who).map((c) => `${c} (${nameIn(s, c)})`).join(", ");
  return `

You can design a voice in this scene, once: describe it, and a voice-design service makes three candidate voices. It costs real money, and the bill goes to the room. Use it only if the moment calls for it. To use it, after your spoken words add one line exactly like this:
DESIGN VOICE for <slug> | <the voice in one to three sentences: age, timbre, pace, accent, character> | choose 1, 2 or 3, or offer
"choose" gives them the one you pick now; "offer" leaves all three for the producer to review. Characters who already have a voice of their own can only be offered one. Slugs here: ${targets}.`;
}

/** Carry out a design the speaker asked for, and let the scene feel it. */
export async function performAction(
  room: Room,
  s: Scene,
  who: string,
  a: DesignAction,
  nameIn: (s: Scene, c: string) => string,
  o: ServiceOptions = {},
): Promise<void> {
  const afterTurn = s.turns.length;
  const accountant = playedBy("accounting");
  const note = (kind: "bill" | "voice" | "notice", text: string, addressee?: string, ref?: string) =>
    room.recordHappening(who, { sceneId: s.sceneId, afterTurn, kind, text, ...(addressee ? { addressee } : {}), ...(ref ? { ref } : {}) });
  if (!s.cast.includes(a.forCharacter) || a.forCharacter === who) return void note("notice", `${nameIn(s, who)} reaches for the voice designer, but there's no one called ${a.forCharacter} here to give a voice to.`);
  if (!key(o)) return void note("notice", `${nameIn(s, who)} orders three voices for ${nameIn(s, a.forCharacter)}. Nothing answers: voice design isn't switched on in this room. No bill.`);
  // A principal's production voice is theirs; a guest can be given one on the spot.
  const mode = isPrincipal(a.forCharacter) ? "offer" : a.mode;
  const sample = s.turns.filter((t) => t.character === a.forCharacter && !/^\(offline/.test(t.line)).map((t) => t.line).join(" ");
  let design;
  try {
    design = await designVoice(room, { by: who, forCharacter: a.forCharacter, description: a.description, sample, mode, sceneId: s.sceneId, afterTurn }, o);
  } catch (e) {
    return void note("notice", `${nameIn(s, who)} orders three voices for ${nameIn(s, a.forCharacter)}. The service refuses: ${(e as Error).message} No bill.`);
  }
  const amount = design.costUsd === null ? "amount not stated; it comes out of the account in credits" : `$${design.costUsd.toFixed(2)}`;
  if (mode === "choose") {
    try {
      await selectDesignedVoice(room, design.designId, a.pick, { ...o, by: who, sceneId: s.sceneId });
      note("voice", `${nameIn(s, a.forCharacter)} has a voice now: ${nameIn(s, who)} chose candidate ${a.pick} of 3 (${design.designId}). "${a.description}"`, undefined, design.designId);
    } catch (e) {
      note("notice", `Three voices arrive for ${nameIn(s, a.forCharacter)}, but saving candidate ${a.pick} fails: ${(e as Error).message}`, undefined, design.designId);
    }
  } else {
    note("voice", `Three candidate voices for ${nameIn(s, a.forCharacter)} wait for review (${design.designId}). "${a.description}"`, undefined, design.designId);
  }
  if (s.cast.includes(accountant))
    note("bill", `A bill arrives, addressed to ${nameIn(s, accountant)}: ElevenLabs, voice design ${design.designId}, three candidate voices for ${nameIn(s, a.forCharacter)}, ordered by ${nameIn(s, who)} just now. ${amount[0].toUpperCase()}${amount.slice(1)}.`, accountant, design.designId);
  else note("bill", `A bill for voice design ${design.designId} lands on the ledger (${amount}). ${nameOf(accountant)} isn't here to see it yet.`, undefined, design.designId);
}
