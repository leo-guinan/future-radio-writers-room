#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';

const file = new URL('../catalog/works.json', import.meta.url);
const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
const errors = [];
const ids = new Set();
const videoIds = new Set();
const sha256 = /^[0-9a-f]{64}$/;
const states = new Set(catalog.states || []);

if (catalog.schema_version !== 'future-radio.catalog.v1') errors.push('unsupported schema_version');
if (!catalog.identity?.youtube_channel_id) errors.push('missing YouTube channel identity');
for (const work of catalog.works || []) {
  if (!work.work_id || ids.has(work.work_id)) errors.push(`duplicate/missing work_id: ${work.work_id}`);
  ids.add(work.work_id);
  if (!Array.isArray(work.releases) || work.releases.length === 0) errors.push(`${work.work_id}: no releases`);
  for (const release of work.releases || []) {
    if (!release.release_id) errors.push(`${work.work_id}: release without release_id`);
    if (!states.has(release.state)) errors.push(`${release.release_id}: invalid state ${release.state}`);
    if (release.youtube?.video_id) {
      if (videoIds.has(release.youtube.video_id)) errors.push(`duplicate YouTube video_id: ${release.youtube.video_id}`);
      videoIds.add(release.youtube.video_id);
      if (release.youtube.privacy_status !== 'public' || release.youtube.processing_status !== 'succeeded') errors.push(`${release.release_id}: public release is not fully verified`);
      if (release.youtube.url !== `https://www.youtube.com/watch?v=${release.youtube.video_id}`) errors.push(`${release.release_id}: YouTube URL mismatch`);
    }
    for (const asset of release.assets || []) {
      if (!asset.asset_id || !asset.kind || !states.has(asset.state)) errors.push(`${release.release_id}: malformed asset`);
      if (asset.sha256 && !sha256.test(asset.sha256)) errors.push(`${asset.asset_id}: invalid SHA-256`);
    }
  }
  const published = (work.releases || []).filter(r => r.youtube?.video_id);
  if (work.youtube?.video_id && !published.some(r => r.youtube.video_id === work.youtube.video_id)) errors.push(`${work.work_id}: top-level YouTube pointer has no release target`);
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`catalog valid: ${catalog.works.length} works, ${videoIds.size} YouTube releases`);
