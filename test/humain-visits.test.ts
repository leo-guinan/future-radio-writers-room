import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "humain-data-"));
import assert from "node:assert/strict";
import { EventStore } from "../src/core/events.ts";
import { Room } from "../src/core/room.ts";
import { humainRoutes } from "../src/humain/routes.ts";
import { injectCounts, nextFrameId, publishFrame, readFrame, serveFrame } from "../src/humain/frames.ts";
import { loadWorks, renderComparison } from "../src/humain/frame-maker.ts";

const setup = () => {
  const works = loadWorks();
  const id = nextFrameId();
  publishFrame(id, "H-0001", "hook", works[0].work_id, works[1].work_id, renderComparison(works[0], works[1], "hook"));
  return id;
};

test("repeat refreshes count views but not uniques", () => {
  const id = setup();
  serveFrame(id, { visitor: "alice" });
  serveFrame(id, { visitor: "alice" });
  serveFrame(id, { visitor: "alice" });
  assert.deepEqual(readFrame(id).counts, { human: 3, unique: 1, verification: 0 });
});

test("distinct visitors each count once as unique", () => {
  const id = setup();
  serveFrame(id, { visitor: "alice" });
  serveFrame(id, { visitor: "bob" });
  serveFrame(id, { visitor: "alice" });
  assert.deepEqual(readFrame(id).counts, { human: 3, unique: 2, verification: 0 });
});

test("verification views never land in human counts", () => {
  const id = setup();
  serveFrame(id, { visitor: "alice" });
  serveFrame(id, { verify: true });
  serveFrame(id, { verify: true });
  assert.deepEqual(readFrame(id).counts, { human: 1, unique: 1, verification: 2 });
});

test("legacy single counters migrate to human views", () => {
  const id = nextFrameId();
  const d = join(process.env.DATA_DIR!, "humain", "frames", id);
  mkdirSync(d, { recursive: true });
  const works = loadWorks();
  writeFileSync(join(d, "index.html"), renderComparison(works[0], works[1], "old"));
  writeFileSync(join(d, "meta.json"), JSON.stringify({ frameId: id }));
  writeFileSync(join(d, "visits.json"), JSON.stringify({ visits: 7 }));
  assert.deepEqual(readFrame(id).counts, { human: 7, unique: 0, verification: 0 });
  serveFrame(id, { visitor: "new" });
  assert.deepEqual(readFrame(id).counts, { human: 8, unique: 1, verification: 0 });
});

test("served pages carry live counts; legacy pages serve unchanged", () => {
  const id = setup();
  serveFrame(id, { visitor: "a" });
  serveFrame(id, { visitor: "b" });
  serveFrame(id, { verify: true });
  const { html, counts } = serveFrame(id, { visitor: "a" });
  assert.deepEqual(counts, { human: 3, unique: 2, verification: 1 });
  assert.ok(html.includes('data-c="human">3<'));
  assert.ok(html.includes('data-c="unique">2<'));
  assert.ok(html.includes('data-c="verify">1<'));
  assert.equal(injectCounts("<p>no spans</p>", counts), "<p>no spans</p>");
});

test("frames route hashes visitors and honors ?as=verify", async () => {
  const id = setup();
  const room = new Room(new EventStore(null));
  const routes = humainRoutes(room, "leo");
  const call = async (ip: string, suffix = "") => {
    const req = Readable.from([]);
    Object.assign(req, { method: "GET", url: `/api/humain/frames/${id}${suffix}`, headers: {}, socket: { remoteAddress: ip } });
    let status = 0;
    let body = "";
    const res = { writeHead: (s: number) => (status = s), end: (d: string) => (body = d) };
    for (const [m, re, h] of routes) {
      const mt = `/api/humain/frames/${id}`.match(re); // the server matches pathname, not the query
      if (mt && m === "GET") {
        await h(req as any, res as any, mt);
        break;
      }
    }
    assert.equal(status, 200);
    return body;
  };
  const first = await call("1.2.3.4");
  assert.ok(first.includes('data-c="unique">1<'), "first visitor counted unique");
  await call("1.2.3.4");
  const third = await call("5.6.7.8");
  assert.ok(third.includes('data-c="unique">2<'), "second address counted unique");
  assert.ok(!third.includes("1.2.3.4") && !third.includes("5.6.7.8"), "raw addresses never leak into pages");
  await call("9.9.9.9", "?as=verify");
  assert.deepEqual(readFrame(id).counts, { human: 3, unique: 2, verification: 1 });
});
