# Future Radio — The Ledger of What Happened

## Draft production script

*[SFX: A drawer opening. Paper. A pencil placed precisely on a table.]*

**AGNOLO:** Close the doors.

**LEONARDO:** There are no doors.

**AGNOLO:** Then close whatever architectural compromise is currently pretending to be a door.

**BORGES:** I have found a door.

**AGNOLO:** Where?

**BORGES:** In the catalogue. It is not a door one enters. It is a door through which identities leave.

**LEONARDO:** Why have you called us?

**AGNOLO:** Because the accounts do not agree. The public account says there are six Future Radio publications. The local receipts say there are five. The episode repositories say there are two. The scratch directories say there are five production directories.

**LEONARDO:** That sounds like five.

**AGNOLO:** It is five directories. It is not necessarily five works.

**BORGES:** I have brought the library.

**AGNOLO:** You brought a library?

**BORGES:** No. I brought the part of it that disagrees with us.

*[SFX: Many pages turning at once, too far away to be useful.]*

**BORGES:** The first concept is provenance.

**LEONARDO:** Origin.

**BORGES:** More precisely: the record of where a thing came from, what happened to it, and which claims about it are supported by evidence.

**AGNOLO:** So a provenance record is a receipt.

**BORGES:** A receipt is one kind of provenance record. Provenance asks: what is this thing, and how did it become this thing?

**LEONARDO:** Then we need to distinguish the work from its versions.

**BORGES:** The library uses three shelves. Work. Release. Asset.

**LEONARDO:** Explain.

**BORGES:** A work is the durable creative identity. E10: The People vs. The Future. A release is one deliberate, frozen edition of that work. E10 audio, version one. E10 development movie, published to YouTube. An asset is a component or artifact: the script, the audio master, a still image, the thumbnail, the description, the movie, the upload receipt.

**AGNOLO:** So the eight-minute E10 audio and the thirty-five-minute E10 movie are not the same thing.

**BORGES:** They may belong to the same work. They are not the same release merely because the title is similar.

**LEONARDO:** If the movie contains the audio, we draw an edge between them. We do not collapse them.

**BORGES:** Correct.

*[SFX: A mechanical counter advances. It stops at five. A second counter advances to six.]*

**AGNOLO:** The immediate discrepancy: five local YouTube receipts, six actual Future Radio uploads.

**BORGES:** The missing receipt belongs to Future Radio 001: Leonardo da Vinci Invents the Radio. Then His Bookkeeper Sends the Bill.

**LEONARDO:** The First Transmission.

**AGNOLO:** The repository is E01. Its release is nine minutes and one second. The YouTube video is nine minutes and one second. The title and runtime agree. The original upload receipt is absent.

**LEONARDO:** Then it is E01.

**AGNOLO:** Probable.

**LEONARDO:** You say that as if the number has offended you.

**AGNOLO:** The evidence supports a probable linkage. It does not support pretending that we found the receipt.

**BORGES:** There are levels of certainty: verified, observed, inferred, unresolved, and contradicted.

**LEONARDO:** The E01 match is probable. The five later uploads are verified public because their receipts contain the video ID, channel identity, processing readback, privacy state, duration, source movie hash, and thumbnail hash.

**AGNOLO:** The catalog must preserve uncertainty instead of smoothing it away.

**BORGES:** A smooth archive is often a dishonest archive.

*[SFX: A pencil scratches a grid. Three columns are drawn.]*

**LEONARDO:** I see the structure. At the center: a work record. Under it: releases. Under each release: assets. Beside each asset: hashes, roles, parents, repository references, and states.

**AGNOLO:** And the event log?

**LEONARDO:** Append-only. It records what the room believed and when. The catalog is a projection derived from those events and from external evidence.

**AGNOLO:** So if the catalog is corrected, the old mistake remains in the event log.

**LEONARDO:** It must. Otherwise correction becomes erasure.

**BORGES:** A cryptographic hash gives each file a content fingerprint. Change one byte and the fingerprint changes.

**AGNOLO:** A number cannot tell us whether the file is a thumbnail or a bad tax return.

**BORGES:** Exactly. Identity is not interpretation.

**LEONARDO:** Every asset needs both a content identity, which is the hash, and a declared role: master video, thumbnail, dialogue manifest, voice receipt, description, or script.

**AGNOLO:** And local paths?

**BORGES:** A local path is a location in one person’s present tense. It is not a durable identity.

**LEONARDO:** We record the path as an observation, but anchor the artifact with its hash, role, and eventual durable URI.

**AGNOLO:** “Found here” is not the same as “belongs here.” Put that in the ledger.

**BORGES:** It is already in the margins.

*[SFX: A drawer shuts.]*

**AGNOLO:** What do we do with the smaller pieces?

**LEONARDO:** We create four repositories.

**AGNOLO:** No.

**LEONARDO:** You have not heard the rest.

**AGNOLO:** I have heard enough. Four small productions, four release systems, four places for the same mistake to acquire a different spelling.

**BORGES:** The archive recommends one dedicated repository: Future Radio Releases.

**LEONARDO:** One directory per work. One release manifest per publication unit. Small metadata and manifests in Git. Large binaries attached to tagged releases, Git LFS, or object storage. Every binary retains its SHA-256 and durable URI.

**AGNOLO:** And the pieces that are not numbered episodes?

**LEONARDO:** They do not need counterfeit numbers. Interlude. CTA. Companion. Stable work IDs, with relationships added later rather than history renamed.

**BORGES:** The library contains appendices that became books.

**AGNOLO:** Good. Now the final concept.

**BORGES:** Independent readback.

**AGNOLO:** We already have receipts.

**BORGES:** A receipt is a claim made by the process that performed the action. Readback is an independent observation that the claimed state exists.

**LEONARDO:** The upload script says public. We query YouTube and confirm public. The build script says the movie exists. We decode it and inspect its duration. The repository says the asset exists. We fetch it and compare the hash.

**AGNOLO:** Endpoint success is not state verification.

**LEONARDO:** Then the rule is simple: no verified claim without a readback.

**AGNOLO:** Better: no claim should hide its evidence ceiling.

*[SFX: The counters reset. Not to zero. To one.]*

**AGNOLO:** The decision. Borges prepares the concept notes: provenance, content-addressed identity, work-release-asset modeling, append-only logs, lineage, uncertainty, and independent readback.

**LEONARDO:** I design the catalog and repository structure.

**AGNOLO:** I audit every claim against the ledger.

**BORGES:** And the public archive?

**AGNOLO:** Not yet. A catalog that has not been independently checked is merely a confident list.

**LEONARDO:** Then we begin with the six public uploads.

**AGNOLO:** We begin with the missing receipt.

**BORGES:** E01.

**LEONARDO:** A work, a release, an asset, and a publication.

**AGNOLO:** A probable linkage. An unresolved gap. And, if we do this correctly, a future correction that will not require us to invent the past.

*[SFX: A radio signal resolves into silence.]*

**THE ARCHIVE:** At the meeting’s end, the archive contained six creative works, six public YouTube releases, two episode repositories, four productions awaiting durable repository homes, one probable E01 linkage, one E10 release whose documentation pointed to a path that no longer existed, and one hundred and eighty-one local artifacts waiting to be assigned a permanent address.

**BORGES:** A record is not a memory.

**LEONARDO:** A record is a mechanism for remembering.

**AGNOLO:** A record is a promise that the next discrepancy will be cheaper.

**THE ARCHIVE:** The promise was not yet verified.

**END.**
