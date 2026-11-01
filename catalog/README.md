# Future Radio release catalog

This directory is the public index for the creative work and its immutable releases.

The distinction matters:

- A work is the stable creative identity (`work_id`). It can have an episode number, but smaller productions may be interludes or CTAs and need not pretend to be numbered episodes.
- A release is one rendered or published variant (`release_id`). The 35-minute E10 YouTube cut and the 8-minute E10 repository audio release are related releases, not the same file.
- An asset is a script, dialogue manifest, voice receipt, audio master, sound manifest, still, contact sheet, thumbnail, movie, description, or external receipt.

Rules

1. Never use a YouTube video ID as the canonical episode/work ID. YouTube is a publication surface.
2. Never infer identity from a directory name. Link by explicit `work_id`, `release_id`, and hashes.
3. Every published release gets a YouTube readback object and an asset list, even when its repository is missing.
4. `local_only` means the asset is indexed and hash-identified but has not yet been copied into a durable repository. It is not the same as missing.
5. `missing` means no verified artifact or receipt exists. Do not silently promote it to available.
6. Public catalog files must contain no OAuth tokens, API keys, provider request payloads, or private filesystem paths.

Minimum asset record

```json
{
  "asset_id": "stable-role-name",
  "kind": "master_video",
  "state": "verified_public | repo_release | local_only | missing | not_applicable",
  "sha256": "optional exact digest",
  "uri": "optional public durable URI"
}
```

Backfill order

1. Preserve each existing YouTube receipt and verify the channel, privacy, processing state, duration, and video ID.
2. Create one durable repository per work, or add one directory per work to a dedicated `future-radio-releases` catalog repository. Do not leave smaller releases in scratch alone.
3. Copy manifests and small metadata first; store large binaries with GitHub Releases, Git LFS, or object storage and retain the exact public URI plus SHA-256.
4. Add the repository URL and commit to the work record. Add the release path and artifact hashes to the release record.
5. Change `local_only` to `repo_release` only after an independent readback confirms the repository artifact exists and hashes match.
6. Keep the YouTube receipt as a separate immutable publication record; later reuploads create a new release, not an edit to history.

The validator is intentionally dependency-free:

```sh
node scripts/validate-catalog.mjs
```
