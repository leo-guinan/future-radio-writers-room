# Concepts the episode promises

The episode's catalog is not a generic list of uploads. It implements these distinctions:

- Work: stable creative identity.
- Release: frozen edition of a work.
- Asset: source or derivative file.
- Publication: external platform record pointing to a release asset.
- Provenance: evidence of origin and transformation.
- Readback: independent observation of the claimed external state.
- Uncertainty: explicit `verified`, `probable`, `observed`, `unresolved`, or `contradicted` linkage state.

Implementation receipts

- `catalog/works.json`: current work/release/publication index.
- `catalog/gaps.json`: unresolved preservation and linkage gaps.
- `catalog/schemas/release.schema.json`: machine-readable minimum release contract.
- `scripts/validate-catalog.mjs`: dependency-free consistency validator.
- `catalog/releases/ledger-of-what-happened/RELEASE.json`: this episode's local release record.

The event log remains authoritative for room actions. The catalog is a projection and must never erase a prior event when a linkage is corrected.
