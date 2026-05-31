# 0001 — postgres-uuid-pks

- **Status**: Accepted
- **Date**: 2026-05-31
- **Deciders**: @danil

## Context

Cue is a multi-device app: an iOS client (now), potentially a watchOS/macOS client (later), and a server. The iOS client persists locally via SwiftData and may eventually sync through CloudKit or a custom delta-sync. Either path requires that primary keys be **safe to mint client-side**, since a record can be created on the device before the server ever sees it.

Postgres offers three reasonable PK strategies:

1. `bigserial` / `bigint` — server-assigned, monotonic, 8 bytes.
2. `uuid` v4 — random, client-mintable, 16 bytes.
3. `uuid` v7 — time-ordered, client-mintable, 16 bytes (Postgres 17+ native; we're on 15).

## Decision

Every entity uses a Postgres `uuid` primary key, generated client-side or server-side as convenient, with the column declared via TypeORM's `@PrimaryGeneratedColumn('uuid')`.

## Consequences

- ✅ iOS can mint IDs before round-tripping to the server — required for offline-first writes.
- ✅ IDs are globally unique across environments — no risk of collision when restoring a prod backup into staging.
- ✅ No information leak in URLs (no "guess the next ID" enumeration).
- ⚠️ 16 bytes vs 8 bytes per row; ~2x the index size on the PK. Acceptable at our scale; revisit if any table exceeds ~10⁹ rows.
- ⚠️ Random UUIDs hurt B-tree locality on insert-heavy hot tables. We mitigate with **app-controlled ordering** (queries order by `createdAt`, not by PK).

## Alternatives considered

### `bigserial`

Smallest index, monotonic for cache-friendly inserts. Rejected because **client-side ID minting is non-negotiable** for the offline-first iOS use case, and reconciling client-generated temporary IDs with server-assigned final IDs is a class of bug we'd rather not own.

### `uuid` v7 (time-ordered)

Better B-tree locality than v4 while keeping client-mintability. Rejected **for now** because Postgres 15 doesn't have a native generator and we'd be either adding an extension or hand-rolling generation in TypeORM. Revisit when we upgrade to Postgres 17+ — at that point, switching the default column generator is a one-line entity change and no migration is required (existing v4 UUIDs remain valid).

### Composite natural keys (e.g. `(calendarId, slug)`)

Tempting for human-readable URLs. Rejected because Cue tasks/calendars don't have stable natural identifiers — names are user-mutable.

## References

- Recurrence model: [ADR 0002](0002-rrule-not-materialized.md)
- iOS persistence: [cue-ios architecture](../../../cue-ios/docs/architecture.md)
