# Full Calendar Replica Sync — Bootstrap + Delta + Outbox (Design, rev 1.1)

**Status:** Draft — awaiting user sign-off on the pivotal decision in §2.
**Rev 1.1:** offline write queueing added by user direction (§3.7, §4.8) — the rev-1
non-goal is reversed.
**Date:** 2026-07-04.
**Target repos:** `~/personal-projects/cue-api` (BE) and `~/personal-projects/cue-ios` (FE).
**Relationship to prior specs:** supersedes the *windowed-fetch* half of
[sync-multi-layer-strategy.md](sync-multi-layer-strategy.md) (rev 2) — the change-signal,
revision-bump wiring, tombstones, and heartbeat *lifecycle* all survive; the SWR window
cache, memo invalidation, and per-window server fetching are replaced. It also **overturns
one locked decision** of [recurrence-occurrence-overrides.md](recurrence-occurrence-overrides.md)
§5 ("expansion stays server-side") — see §2. All file:line references verified against the
working trees on 2026-07-04.

---

## 0. Executive summary

Two fetch concepts replace the windowed SWR cache:

- **Initial fetch (bootstrap)** — when the local store has no calendar data for the
  signed-in user, `GET /sync/bootstrap` streams the user's ENTIRE dataset (calendars,
  groups, all live tasks — recurring rules and one-time rows alike — and all occurrence
  exceptions) as **NDJSON with record-level checkpoints**. The client commits every N
  records together with the checkpoint in one SwiftData transaction; a dropped connection
  resumes from `?section=…&after=…` and costs only the unread tail.
- **Sync fetch (delta)** — every trigger (25 s heartbeat, foreground, own mutation,
  `X-Sync-Revision` header movement) calls the new per-user `GET /sync/delta?since=…`
  **directly** — *delta-fetch-always*: an empty response IS the staleness check
  (~300–600 B), a non-empty response is already the payload. The separate
  `GET /sync/state` probe leaves the foreground loop (kept for BGAppRefresh/debugging).
- **Offline write queue (outbox)** — every user write commits to the local replica
  immediately and enqueues a durable outbox entry; a serialized flusher pushes entries
  FIFO when connectivity allows, with exponential backoff capped at 30 s (then locked
  to steady 30 s retries). A failed push surfaces a YELLOW "not synced yet" warning —
  never a blocking error, never a lost edit (§4.8).

The iOS client becomes a **full replica**: it stores raw task rows + rules + exceptions
(new `TaskRecord`/`ExceptionRecord` models keyed to the user), **expands recurrence
locally** with a Swift port of the backend engine (§4.4, kept honest by a shared
golden-fixture corpus), and projects occurrences into the existing `TaskItem` table —
so every current UI read path (`@Query` in Today, `CalendarDataAdapter` windowed fetches,
day counts) keeps working unchanged while the loaders, month memos, and per-window
network fetches are deleted. Any month, any year, renders instantly from local data.

All fetch/sync logic moves into one module — `cue/Features/Sync/` (`SyncEngine`) — the
single source of truth for how task data enters the device.

---

## 1. Context, goals, non-goals

**Context.** Today the client caches *server-expanded occurrences* per month window
(`WindowSyncMeta`, 5-min TTL, `CalendarStore.ensureMonthSynced` →
`GET /tasks?from&to&includeCompleted=true`). The delta (`GET /tasks/changes`) only
*invalidates* memos — it never upserts — so every convergence path ends in another
window fetch, and any window not yet fetched shows a loader (or nothing). Navigating to
an uncached month = network round trip. Year scope, far navigation, offline, widgets,
Siri — all bounded by what windows happen to be cached.

**Goals.**
1. The user always sees ALL their tasks in the calendar — any month/year scope, no
   loaders, no empty uncached windows.
2. One module owns fetching/sync on iOS (single source of truth).
3. Two explicit fetch modes: initial (bootstrap-everything) and sync (delta-only-changes).
4. Interrupted transfers resume cheaply (record-level checkpoints, not restart-from-zero).
5. Staleness detection costs ~zero (delta-as-probe + revision piggyback header).
6. Sync activity is *communicated*, never *blocking*: a subtle status indicator replaces
   per-window loaders.
7. **(rev 1.1)** Writes survive offline: a save/update lands locally immediately and is
   pushed when connectivity allows; a pending/failed push shows a yellow non-blocking
   warning, never loses the edit (§4.8).

**Non-goals.**
- Multi-user/shared calendars (replica is keyed per user; sharing later re-scopes the
  bootstrap, not the architecture).
- Removing the server-side expansion engine — it remains authoritative for the
  assistant, reports, conflicts, daily counts, and old clients (§2 parity note).
- Silent push (still the future L8 slot; this design slots it in unchanged).

---

## 2. The pivotal decision: client-side recurrence expansion

A full replica of *raw tasks* only renders a calendar if the client can expand
recurrence rules itself. This overturns the overrides-spec decision "the client never
expands RRULE" — deliberately, with eyes open.

| Option | Verdict |
|---|---|
| **A. Full replica + local expansion (chosen).** Client stores rules + exceptions + override children; a Swift engine expands windows on demand; occurrences are a local, rebuildable projection. | Only option that meets "no loaders, always all tasks". Cost: a second expansion engine that must agree with the backend's. Mitigated by a **shared golden-fixture corpus** (§3.6/§4.4) generated by the BE engine and replayed by the Swift engine in CI — divergence is a test failure, not a user-visible wrong calendar. |
| B. Replica of raw tasks, windows still server-expanded. | Rejected: keeps the loader problem — an uncached month still needs a round trip; the replica buys little. |
| C. Server pre-materializes an occurrence horizon and streams occurrences. | Rejected: violates ADR 0002 (RRULE never materialized server-side), unbounded for Year scope / infinite rules, needs horizon-extension jobs, and re-keys on every rule edit (mass tombstones). |
| D. GraphQL @defer / gRPC streams for transport. | Rejected in the transport family already: mid-transfer drop discards the whole operation / second transport stack for no gain over NDJSON. |

**ADR 0002 note:** local materialization does NOT violate it. The ADR governs the
server's persisted truth (rules, not rows). The client projection is a rebuildable
cache — exactly what the `TaskItem` table already is today; only the *writer* changes
(local engine instead of server window responses).

**Engine scope is bounded and known** (verified `recurrence-rule.service.ts:500–619`,
`recurrence.types.ts:40–76`): 4 frequencies, `interval`, `byWeekday` (0=Mon),
`byMonthDay`, `byMonth`, `bySetPos`, `monthlyAnchor`
(FIRST/LAST/DAY_BEFORE_LAST_WORKDAY), end NEVER/UNTIL_DATE/COUNT, per-task IANA
timezone with DST-correct wall-clock stepping, all-day date anchoring, caps
`MAX_OCCURRENCES_PER_WINDOW=1000` and `MAX_GENERATION_STEPS=64000`. The iOS
recurrence *editor* already constrains user input to exactly this shape
(`RecurrenceEditor.swift`, `RecurrenceRuleInput`), so there is no long tail of exotic
RRULEs to port.

Also ported (these are the parts that would silently diverge if forgotten):
- **effective-settings resolution** — rule/`requiresCompletion`/`color` = task ?? group
  ?? default; a child (`parentTaskId != nil`) NEVER recurs (all three backend gates).
- **exception application** — skip / overrideStartAt / overrideEndAt / overrideTitle /
  completedAt at epoch-ms `originalStartAt` equality.
- **override-child suppression** — a live child suppresses the generated slot keyed on
  `(parentTaskId, originalStartAt)`; plus the one-off-wrap suppression for former
  parents (child at anchor slot when a rule was cleared).
- **detached children** — render at own `startAt`, suppress nothing.

**When engines still disagree** (bug escaped fixtures): the server stays authoritative
for every *write* (membership checks on override/skip run server-side), so divergence
is a *rendering* error only, corrected the moment the fixture corpus gains the case.
This is the accepted residual risk of option A.

---

## 3. Backend design (cue-api)

### 3.1 `GET /sync/bootstrap` — streaming NDJSON with record checkpoints

New controller in `src/modules/sync/` (guarded by `AccessTokenGuard`; Express platform —
`@Res()` + `res.write` per line; `Content-Type: application/x-ndjson`,
`X-Accel-Buffering: no`, flush per batch).

**Line protocol** (one JSON object per line):

```jsonc
{"type":"snapshot","revision":"42","serverTime":"2026-07-04T10:00:00.123Z",
 "counts":{"calendars":1,"groups":6,"tasks":840,"exceptions":310}}   // first line
{"type":"calendar","data":{ CalendarDTO }}
{"type":"group","data":{ TaskGroupDTO }}          // includes `recurrence` (already on the wire)
{"type":"task","data":{ TaskDTO }}                 // includes `recurrence` + `reminders` + override cols
{"type":"exception","data":{ TaskOccurrenceExceptionFullDTO }}   // FULL shape, see below
{"type":"end","complete":true}                     // last line — absence ⇒ truncated stream
```

- **Ordering & checkpoints:** fixed section order `calendars → groups → tasks →
  exceptions`; within a section rows are keyset-ordered by `id ASC` and read in batches
  of 500 (no long-lived transaction). The checkpoint is `(section, lastId)`.
- **Resume:** `?section=tasks&after=<uuid>` skips completed sections and the consumed
  prefix. The `snapshot` line is re-emitted with a **fresh** `serverTime`; the client
  keeps the FIRST attempt's `serverTime` as its catch-up cursor (§5.1).
- **Content:** live rows only (`deletedAt IS NULL`); soft-deleted tasks are irrelevant
  to a fresh replica. Timeless todos (`startAt IS NULL`) included. `counts` in the
  header power the client progress indicator.
- **Consistency model:** the stream is NOT a snapshot — batched reads see concurrent
  commits. Deliberate: consistency is restored by the mandatory **catch-up delta**
  (`since = first-attempt serverTime`, §5.1), which reports anything created/updated/
  deleted during the stream. This is the standard bootstrap-then-delta contract and
  avoids holding a transaction open across a mobile-speed download.
- **`TaskOccurrenceExceptionFullDTO`** (new): the delta DTO today carries only
  `id/taskId/originalStartAt/overrideStartAt` (changes.dto.ts) — the replica needs the
  full row: += `isSkipped`, `overrideEndAt`, `overrideTitle`, `completedAt`,
  `updatedAt`. Used by both bootstrap and the new delta (§3.2).

### 3.2 `GET /sync/delta` — per-user envelope, paged, replica-grade

A NEW endpoint (the per-calendar `GET /tasks/changes` stays untouched for old clients).
Per-user because the replica spans all the user's calendars.

```
GET /sync/delta?since=<cursor>&pageToken=<opaque>
```

Response:

```jsonc
{
  "tasks":       [ TaskDTO … ],            // updatedAt > since−5s, ALL user calendars, +reminders
  "deletedTaskIds": [ "…" ],               // deletedAt > since−5s, withDeleted (tombstones)
  "exceptionsByTask": { "<taskId>": [ TaskOccurrenceExceptionFullDTO … ] },
                                           // FULL live set per task in tasks[] — replace-set semantics
  "groups":     [ TaskGroupDTO … ],        // FULL live set, always (snapshot semantics)
  "calendars":  [ CalendarDTO … ],         // FULL live set, always (snapshot semantics)
  "hasMore":    false,
  "nextPageToken": null,                   // present iff hasMore — ephemeral keyset (updatedAt,id)
  "serverTime": "…"                        // durable cursor — ONLY meaningful on the final page
}
```

Contract decisions, each closing a known replica-consistency hole:

1. **Cursor stays a server timestamp + 5 s overlap lag** (reuses the shipped, tested
   `DELTA_OVERLAP_LAG_MS` mechanics, task.service.ts:72,468). Re-reports within the lag
   are harmless — every apply is an idempotent upsert now. *Alternative considered:*
   per-row `syncRevision` stamping (exact CalDAV-style cursors, no lag needed) — solid,
   but requires stamping every replicated row inside every mutation and a migration;
   deferred as a Phase-2 upgrade unless the lag ever bites (§8 Q5).
2. **Exceptions = replace-set per changed task.** Exceptions are HARD-deleted (e.g.
   absorbed into an override child) and have no tombstones — but *every* exception
   write also touches the parent task (verified: both branches of `upsertOverride`
   touch, and absorption touches, task.service.ts). So: whenever a task appears in
   `tasks[]`, ship its FULL live exception set; the client replaces that task's local
   exceptions wholesale. Deletions become invisible-by-omission — structurally correct.
3. **Groups & calendars = full-set snapshots.** Both are hard-deleted with no
   tombstones (task-group.service.ts remove; calendar CASCADE). At personal-planner
   cardinality (a handful of rows, ~1–2 KB) shipping the full live set on every delta
   is cheaper than inventing tombstones. Client replace-all: upsert every row, delete
   local rows absent from the set. **This closes the calendar-hard-delete hole** the
   old design needed the daily reconcile for: a calendar vanishing from the snapshot
   ⇒ client drops that calendar's `TaskRecord`s locally (server hard-deleted them via
   FK CASCADE with no tombstones — the snapshot is the only signal possible).
4. **Paging with cursor-on-last-page-only.** Order `updatedAt ASC, id ASC`, page size
   500. Intermediate pages: `hasMore:true` + `nextPageToken` (opaque keyset), and the
   client APPLIES each page as it arrives (idempotent) but advances its durable
   `since` cursor ONLY from the final page's `serverTime`. An interrupted paged delta
   re-runs from the old cursor — re-applied rows are no-ops. A returning long-offline
   client can never lose changes to an interruption.
5. **`tasks[]` includes `reminders`** (the old delta omits them, task.controller.ts) —
   the replica stores reminders inline on `TaskRecord` for detail views and the future
   notification engine.

### 3.3 `X-Sync-Revision` piggyback header

A tiny NestJS interceptor (new `src/common/interceptors/sync-revision.interceptor.ts`,
registered on the authenticated controllers or globally with a guard for `req.user`):
after each response, stamp `X-Sync-Revision: <current user revision>` (one PK read on
`user_sync_state`; ~30 B after HPACK). Every API interaction becomes a free staleness
check; mutation responses carry the post-commit revision for free.

To keep it one PK read and not a bump-then-read race, the interceptor calls
`SyncStateService.getState(userId)` post-handler — the handler's own `@Transactional`
has committed by then (interceptor `tap()` runs after the method resolves).

### 3.4 What stays / what is NOT touched

- **All revision-bump wiring** (every TaskService/TaskGroupService/CalendarService
  mutation, `@Transactional`, atomic upsert — shipped and tested) — unchanged; it is
  what makes the header + delta-always cheap and correct.
- `GET /sync/state` — kept (BGAppRefresh fast no-op decision, debugging).
- `GET /tasks` (windows), `GET /tasks/changes` (per-calendar delta),
  `GET /tasks/daily-counts` — kept verbatim for old clients; the new iOS build stops
  calling them. Mark deprecated in `openapi.yaml`; removal decision in §8 Q4.
- The server expansion engine and every consumer of `findOccurrencesInRange`
  (assistant, reports, conflicts, counts) — untouched and still authoritative.
- Override/exception write semantics (overrides spec) — untouched.

### 3.5 Idempotent creates for the outbox (client-supplied ids) — rev 1.1

The outbox (§4.8) must be able to replay a timed-out request without duplicating data.
Every mutation is already replay-safe except creates: PATCH sets absolute values
(tri-state — naturally idempotent), DELETE treats already-deleted as success, skip and
override are server-side upserts. Fix for creates: `POST /tasks`, `POST /task-groups`
(and `POST /calendars`) accept an OPTIONAL client-generated `id: string` (UUID v4,
validated). If a row with that id already exists and belongs to the same user, return
it with `200` instead of erroring — the retried create becomes a read. UUID PKs are
already the schema-wide convention, so this is additive and small.

### 3.6 Recurrence parity fixture generator (the honesty mechanism)

New jest spec `recurrence-parity-fixtures.spec.ts` that RUNS the real
`RecurrenceRuleService` over a curated case matrix and WRITES
`docs/fixtures/recurrence-parity.json` (committed; regenerated via
`GENERATE_FIXTURES=1 pnpm jest …`). Case axes:

- each frequency × intervals {1,2,5} × representative selectors (`byWeekday` sets,
  `byMonthDay` incl. 29/30/31 overflow, `bySetPos` {1,2,-1} × weekday, all three
  `monthlyAnchor` modes, `byMonth` filters);
- end conditions NEVER / UNTIL_DATE (boundary-inclusive) / COUNT (window-straddling);
- timezones: `Europe/Kyiv` + `America/New_York` across BOTH DST transitions
  (spring-forward skipped hour, fall-back repeated hour), UTC control;
- all-day vs timed; multi-day durations crossing window edges;
- exceptions: skip, move (incl. cross-month), resize, retitle, complete;
- override children: suppression, detached child, anchor-slot child after rule clear;
- group-inherited rules (task rule null, group rule set) + child-never-inherits;
- cap behavior: window that would exceed 1000 occurrences (truncation point equality).

Each fixture: `{ name, task, group?, exceptions[], children[], window, expected: [{
originalStart, occurrenceStart, occurrenceEnd, title, completedAt, isException,
suppressed? }] }`. The iOS test target replays the SAME file (§4.4). **Rule: any BE
engine change regenerates fixtures in the same MR; the iOS suite failing on the new
corpus is the desired alarm.**

### 3.7 Backend tests

- Bootstrap: streams all sections in order; resume from every section boundary and
  mid-section; `end` line present; counts accurate; excludes soft-deleted; 401.
- Delta: page-boundary interruption loses nothing (re-run from old cursor);
  exceptions replace-set exactly matches live rows; group/calendar snapshot reflects
  hard deletes; tombstones present; 5 s lag honored (existing e2e pattern); reminders
  present in `tasks[]`.
- Interceptor: header present on GET and mutation responses; reflects post-commit
  revision after a mutation.
- Idempotent creates: replayed POST with the same client id returns the existing row
  (200, no duplicate); a foreign user's id collision is rejected.

---

## 4. iOS design (cue-ios)

### 4.1 The sync module — single source of truth

New/moved files under `cue/Features/Sync/`:

```
Sync/
  SyncEngine.swift          // @MainActor @Observable — owns bootstrap+delta+cursor+status
  BootstrapClient.swift     // NDJSON streaming reader (URLSession.bytes + AsyncLineSequence)
  DeltaApplier.swift        // envelope → replica upserts/deletes → dirty series set
  OutboxFlusher.swift       // FIFO write queue drain — backoff 1s→30s cap, steady 30s (§4.8)
  SyncHeartbeat.swift       // (exists) ticker — now calls SyncEngine.tick
  SyncStatus.swift          // enum + tiny indicator view model
Domain/Recurrence/
  RecurrenceEngine.swift    // pure port of expandOccurrences (no SwiftData imports)
  EffectiveSettings.swift   // task ?? group ?? default resolver (+ child gate)
  OccurrenceProjector.swift // replica → TaskItem rows for a series over the horizon
```

`CalendarStore` slims to UI-facing reads + mutations; after any mutation ack it hands
the returned `TaskDTO` to `SyncEngine.applyOwnMutation(dto)` (replica upsert +
reprojection — replaces `invalidateAndResync`'s ±1-month window fetches) and kicks a
debounced delta. `APIClient` gains a header hook: every response's `X-Sync-Revision`
is compared to the engine's last-applied revision; movement ⇒ `SyncEngine.kick()`.

Single-flight: ONE serialized task guard for bootstrap/delta/own-mutation-apply (the
existing `refreshTask` pattern, hoisted into `SyncEngine`). Bootstrap excludes deltas
until complete.

### 4.2 Replica models (new @Model set)

```
TaskRecord      — @Attribute(.unique) id; calendarId, groupId?, title, notes?,
                  startAt?, endAt?, isAllDay, timezone, requiresCompletion?(tri-state!),
                  color?, icon?, completedAt?, recurrence: RecurrenceRuleData?
                  (Codable struct, stored inline), notificationStrategyId?,
                  parentTaskId?, originalStartAt?, detachedAt?, recurrenceUpdatedAt?,
                  reminders: [TaskReminder], createdAt, updatedAt
ExceptionRecord — @Attribute(.unique) id; taskId (#Index), originalStartAt,
                  isSkipped, overrideStartAt?, overrideEndAt?, overrideTitle?,
                  completedAt?, updatedAt
EventTaskGroup  — EXTEND: += recurrence: RecurrenceRuleData? (wire DTO already
                  decodes it — APIModels.swift:667 — the local model just drops it today)
EventCalendar   — unchanged
SyncMeta        — REWORK: += ownerUserId: String?, deltaCursor: String?,
                  bootstrapPhase (raw enum: none/inProgress/done),
                  bootstrapCheckpointSection: String?, bootstrapCheckpointAfter: String?,
                  bootstrapFirstServerTime: String?   // catch-up cursor, first attempt
                  (lastSeenRevision stays for the header comparison)
TaskItem        — UNCHANGED SCHEMA; becomes a pure local projection (writer swaps)
PendingMutation — (rev 1.1) outbox row: @Attribute(.unique) id (client UUID),
                  sequence (monotonic Int), kind (enum raw), payload (Data — encoded
                  request body), targetId, attemptCount, lastAttemptAt?,
                  state (pending | inFlight | failed)
DELETED from schema: WindowSyncMeta, SyncCursorState (per-calendar cursor and window
memos have no role; SwiftData destroy-and-recreate fallback covers the schema change)
```

Notes:
- `requiresCompletion` on `TaskRecord` must be **tri-state** (nil = inherit) unlike
  today's `TaskItem.requiresCompletion: Bool` which stores the resolved value — the
  resolver runs at projection time.
- **Account keying / switch:** on engine start, if `SyncMeta.ownerUserId != user.id`
  (or bootstrapPhase != done), wipe replica + projection and bootstrap. This also
  closes today's acknowledged logout gap (old user's rows persisting in the store —
  AuthStore.signOut never wipes SwiftData).

### 4.3 Bootstrap client

- `URLSession.bytes(for:)` + `AsyncLineSequence`; decode each line's `type`; batch
  records; every 500 records (or section end) commit ONE SwiftData transaction:
  upserts + updated checkpoint on `SyncMeta`. Kill the app mid-stream → next launch
  resumes with `?section=&after=` from the committed checkpoint.
- First `snapshot` line: persist `bootstrapFirstServerTime` ONLY if not already set
  (resume keeps the original), stash `counts` for progress.
- Missing `end` line (connection died) → keep checkpoint, schedule retry with the
  existing backoff pattern; the UI stays in `.bootstrapping(progress)`.
- After `end`: run the **catch-up delta** with `since = bootstrapFirstServerTime`;
  on success set `bootstrapPhase = done`, `deltaCursor` = that delta's `serverTime`,
  then project the full horizon (§4.5) and commit. Only then does the calendar flip
  from progress to content — one flip, no partial ghosts.
- Projection during bootstrap: none (records only). Projection is one pass at the end —
  cheaper and avoids rendering a half-loaded calendar.

### 4.4 Swift recurrence engine + parity harness

Pure functions, no SwiftData: input `(task snapshot, effective config, exceptions,
children, window)` → `[ProjectedOccurrence]`. Port the luxon semantics with
`Foundation.Calendar(identifier: .gregorian)` pinned to the task's IANA `TimeZone`:
wall-clock stepping via `DateComponents` arithmetic (preserves local time across DST,
matching luxon's `plus({months:1})` behavior), all-day = date-anchored midnight in the
task tz. Same caps (1000/window, 64 000 steps). Same selector semantics — including
`byWeekday` 0=Monday and `bySetPos` applied to the in-month weekday matches, workday
anchors Mon–Fri.

**Parity tests:** an iOS test target loads `docs/fixtures/recurrence-parity.json`
(vendored copy in the repo, refreshed from cue-api; per the vendoring preference a
build-phase copy beats a package dependency) and asserts exact equality — occurrence
sets compared at epoch-ms. This suite is the gate for every engine edit on either side.
Engine work happens FIRST in the phasing (§7 Phase 0) so the riskiest piece is de-risked
before any plumbing lands on top of it.

### 4.5 Projection: replica → `TaskItem`

The projection unit is a **series** (one `TaskRecord` + its exceptions + its live
children): `projectSeries(record, horizon, context)` deletes `TaskItem` rows with
`seriesId == record.id` (sparing in-flight completion keys, as every delete loop does
today) and re-inserts freshly expanded rows. Precise, cheap, and replaces the entire
memo-invalidation apparatus: *changed series ⇒ reproject that series*. No more
footprint walks, audit spans, or all-memo wipes.

- **Keys:** identical `occurrenceKey = seriesId#wholeSecondISO(occurrenceStart)` scheme
  (children keep `childId#iso`) — UI diffing and the in-flight completion map behave
  exactly as today.
- **Fields:** effective color/icon/requiresCompletion resolved at projection time
  (task ?? group ?? default); `groupColorToken` from the group row; `isException`,
  `parentSeriesId`, `isDetached` set per the ported rules; completed occurrences ARE
  projected (with `completedAt`) — the old includeCompleted plumbing dies; UI already
  filters where it wants (`TodayView`'s `@Query` excludes completed).
- **Todos** (`startAt == nil`): projected as the single `seriesId#`-keyed row, as today.
- **Horizon:** materialize `[now − 12 months, now + 24 months]` by default. Navigation
  outside the horizon (Year scope paging, date jumps) triggers *synchronous local*
  projection of the missing months for the visible series set — local expansion at this
  scale is sub-frame; still no loader. A `projectedFrom/projectedTo` pair on `SyncMeta`
  tracks the materialized span; a rolling monthly tick advances it. (Rows outside the
  horizon are pruned on the same tick — bounded store, replica can always re-project.)
- **Day counts:** computed locally from projection (the `CalendarDataAdapter.
  indicatorsByDay` pattern generalizes); `ensureCountsSynced` + the `countsWeek`
  memos + the `/tasks/daily-counts` calls are deleted. `countsEpoch` stays as the UI
  signal, bumped on any projection commit.
- **Dirty-series propagation from a delta:** the changed-series ids come straight from
  `tasks[]`/`deletedTaskIds` (plus parents of changed children via `parentTaskId`).
  A group change with `recurrence`/`color`/`requiresCompletion` movement marks all
  member series dirty (the server also touches members — belt and braces). Calendar
  removal marks the whole calendar's series deleted.

### 4.6 Sync loop rewiring (what changes, what dies)

**The tick** (single-flight, silent on failure, backoff as today):

```
tick():
  guard bootstrapPhase == done else { return runBootstrapIfNeeded() }
  page-loop: GET /sync/delta?since=deltaCursor[&pageToken]
    apply page → replica upserts/deletes → collect dirty series → reproject → commit
  advance deltaCursor from FINAL page serverTime only
  status = .idle (empty delta ⇒ no UI revision bump — no churn)
```

**Triggers → tick:** 25 s heartbeat (jittered, foreground-only — unchanged lifecycle
in `MainTabs`); scenePhase `.active` + cold launch (unchanged hoist); pull-to-refresh
(force); deep-link open; outbox-entry ack (debounced ~2 s — the local replica write
already made the UI correct at enqueue time, §4.8); **`X-Sync-Revision` header movement**
on any API response (debounced) — this catches assistant writes mid-session between
heartbeats for free. The revision-equality gate and the unconditional-delta floor
DISAPPEAR — delta-always makes both meaningless (the delta is its own probe).

**Deleted outright** (the kill list, all in CalendarStore today):
`ensureMonthSynced`/`ensureDaySynced` network paths + `quiet:` plumbing,
`WindowSyncMeta` + `isFresh` + TTL, `SyncCursorState`, `applyDelta`'s
invalidation logic (ghost sweep / destination months / audit span /
`ruleChangedSince` / `deleteAllMonthMemos`), `resyncVisibleWindows`,
`invalidateAndResync`'s refetch, `evictMonthWindows`' memo half,
`ensureCountsSynced`, the `.seeded/.fellBack` cursor-failure choreography,
`includeCompleted` query plumbing, and every `isLoading` month-loader path.

**Kept, generalized:** the optimistic completion toggle survives in UX terms but is
re-founded on the outbox — the `inFlightCompletions` shield generalizes into the
per-target *pending-mutation shield* (§4.8), guarding projection deletes and wire
overwrites alike; `commit()`/`revision`/`countsEpoch` reactivity; RED error banners
now reserved for *permanent* rejections (yellow covers the retrying state, §4.8).

### 4.7 Sync status UI (replaces loaders)

`SyncStatus`: `.idle | .bootstrapping(done: Int, total: Int) | .syncing |
.pendingWrites(count: Int) | .offline`.
- **Bootstrap (first run / account switch):** a real progress surface in place of the
  empty calendar (records applied / total from header counts). The only blocking state
  in the design — and it blocks precisely once per account.
- **Delta:** if a non-empty delta is applying and takes > ~300 ms, show a subtle
  transient indicator (small pill/glyph in the nav area — placement per CUE — Clean
  design system, not a spinner overlay); hide on commit. Empty deltas show nothing.
- **Pending writes (rev 1.1):** while the outbox is non-empty after a failed attempt,
  an AMBER glyph/pill (count optional) holds until the queue drains — the standing
  visual companion to the one-shot yellow banner of §4.8.
- **Offline:** passive glyph state, no banners (RED banners are reserved for permanent
  mutation rejections; the retrying state is yellow, §4.8).

### 4.8 Offline write queue — the outbox (rev 1.1)

**One write path, online or not.** Every user mutation (task create/update/delete,
completion toggle, skip, override create, group CRUD) goes through the outbox:

1. Apply the mutation to the local replica (`TaskRecord` / `ExceptionRecord` / group
   row) and reproject the affected series — the UI is correct in the same interaction,
   with zero network on the critical path.
2. Enqueue a durable `PendingMutation` row (§4.2): client-generated `id`, monotonic
   `sequence`, `kind`, encoded request `payload`, `targetId`.
3. `OutboxFlusher` — one serialized loop inside `SyncEngine`'s single-flight family —
   sends entries strictly FIFO, one at a time. Online, the queue drains within one
   RTT: the "online path" is simply an outbox that never waits.

**Retry policy (as directed):** exponential backoff per queue (not per entry):
1 s → 2 → 4 → 8 → 16 → **30 s cap**, then LOCKED to a steady every-30 s retry
indefinitely while foregrounded. Any of these short-circuits the wait: connectivity
restored (`NWPathMonitor` satisfied), scenePhase `.active`, a new mutation enqueued,
or any successful delta tick (proof of reachability). Backoff resets on first success.

**Yellow warning (as directed):** on the FIRST failed push attempt, surface a
non-blocking YELLOW banner ("Changes saved on this iPhone — will sync when the
connection returns") via a new `.warning` severity on the existing notification-banner
system, and hold `SyncStatus.pendingWrites(count:)` until the queue drains. Yellow
means *pending, retrying automatically*; red stays reserved for permanent rejections.

**Failure classification:**
- *Retryable* (transport, timeout, 5xx): backoff + retry forever; the queue HALTS at
  the failed entry — FIFO preserves causality (an update must never overtake its
  create; a delete must never overtake the edit it follows).
- *Permanent* (4xx validation, 404 target hard-gone): drop the entry, kick a delta so
  the target reverts to server truth locally, and show a RED banner naming the
  rejected change. Local form validation plus the local recurrence engine (membership
  checks for skips/overrides can now run on-device) prevent most of this class from
  ever being enqueued.
- *401:* pause the queue, defer to the auth flow (same posture as the heartbeat).

**Idempotent replay:** a timeout is ambiguous — the server may have committed — so
every entry must be safe to send twice. Creates carry the client-generated UUID the
server dedupes on (§3.5); PATCHes set absolute values (tri-state — naturally
idempotent); DELETE treats already-deleted as success; skip and override are
server-side upserts already.

**Compaction (minimal, v1):** a new completion toggle on the same occurrence key
REPLACES a pending one (the payload is the whole intent — safe). Nothing else
compacts: two partial updates to one task must both replay in order — merging
tri-state payloads is exactly where lost-field bugs live. Chatty but correct.

**Interplay with pulls — the pending shield:** while a target id has pending outbox
entries, `DeltaApplier` and the projector skip overwriting that target from the wire
(per-row for v1, not per-field). After an entry acks, the returned DTO applies as
server truth (the §4.6 own-mutation path) and the shield lifts. Two exceptions:
- a server TOMBSTONE for a shielded target WINS — the row is gone; its pending
  entries are dropped with the permanent-failure notice (deletion beats edition);
- bootstrap never wipes the outbox, and a re-bootstrap flushes the queue first when
  reachable (an offline re-bootstrap cannot happen — same missing network).

**Launch:** a non-empty outbox at cold start immediately shows the yellow state and
schedules a flush — nothing is lost across relaunches or crashes (entries commit in
the same SwiftData transaction as the optimistic replica write).

---

## 5. Consistency model & edge cases

### 5.1 Bootstrap correctness

Anything mutated DURING the stream (including across resume attempts) is healed by the
mandatory catch-up delta at `since = bootstrapFirstServerTime` (first attempt's — the
oldest snapshot line seen): created rows arrive in `tasks[]`, updates likewise, task
deletions as tombstones, exception churn via replace-sets (parents touched), group/
calendar deletions via the full-set snapshots. The 5 s lag covers in-flight commits at
capture time. Resume across a NEW server state is therefore safe: later segments may be
newer than earlier ones, and the catch-up delta reconciles both directions.

### 5.2 Structural drift holes — status under this design

| Hole (old design's reconcile existed for these) | Now |
|---|---|
| Calendar hard-delete (FK CASCADE, no tombstones) | CLOSED — calendars full-set snapshot on every delta (§3.2.3) |
| Group hard-delete (SET NULL members, no tombstones) | CLOSED — groups full-set snapshot + member touches |
| Exception hard-delete (absorption) | CLOSED — replace-set per touched parent (§3.2.2) |
| Task tombstones never purged | unchanged — any cursor age remains valid |
| Lost bump / cursor corruption | delta-always removes the revision gate entirely; a corrupted `deltaCursor` (unparseable/way-future) → wipe replica + re-bootstrap (cheap, resumable, and now the ONLY fallback path — one recovery mechanism instead of four) |

The daily full-reconcile layer (old §3.6) is therefore **not carried over**. Optional
belt-and-braces: a weekly integrity probe comparing `counts` from a HEAD-style
bootstrap header against local counts → mismatch triggers re-bootstrap. Backlog, not
v1 (§8 Q6).

### 5.3 Other edge cases

- **Concurrent triggers:** one single-flight guard for the whole engine; header-kick
  and heartbeat collapsing into one tick is the designed behavior.
- **Own mutation UX (rev 1.1 — outbox-first):** the local replica write + reprojection
  happen at ENQUEUE time, so the UI is correct in the same interaction with zero
  network on the critical path; the flush ack then applies the server's DTO as truth,
  and the follow-up debounced delta reconciles only *other* concurrent changes.
- **Writes vs pulls:** the per-target pending-mutation shield (§4.8) keeps deltas and
  projection from clobbering optimistic state while entries are in flight; server
  tombstones override the shield (deletion beats edition).
- **Midnight / timezone jump:** projection rows are absolute instants — nothing to
  recompute except the Today anchor (the deferred `.NSCalendarDayChanged` item stands);
  `significantTimeChangeNotification` additionally triggers a horizon-window check.
- **DST correctness burden** moves to the fixture corpus — both engines replay the
  same skipped/repeated-hour cases.
- **Old clients:** unaffected (old endpoints intact). New client never mixes modes —
  windows are never fetched once bootstrapped.
- **Store schema wipe** (SwiftData destroy-and-recreate on mismatch): `SyncMeta` dies
  with it ⇒ `bootstrapPhase = none` ⇒ automatic clean re-bootstrap. Self-healing by
  construction. **Rev 1.1 caveat:** the outbox lives in the same store, so a schema
  wipe drops pending unsynced writes — bounded, rare (only on an app update whose
  schema fails lightweight migration), and honest to accept for v1; if it ever
  matters, the outbox can move to its own single-model container.
- **Payload sizing honesty:** a personal-planner dataset (~10² –10³ tasks) bootstraps
  in one connection of a few hundred KB; checkpoints are cheap insurance for bad
  networks, not a necessity at this scale. The design still pays for them because the
  retry cost asymmetry (tail-only vs restart) is exactly what matters on mobile.

---

## 6. Supersedes / keeps (vs sync-multi-layer-strategy rev 2)

| rev-2 mechanism | Fate |
|---|---|
| Per-user revision counter + bump wiring + @Transactional | KEPT (unchanged, load-bearing) |
| `GET /sync/state` heartbeat gate + `lastSeenRevision` watermark + unconditional floor | REPLACED by delta-always (+ header piggyback) |
| `GET /tasks/changes` per-calendar delta + `SyncCursorState` | REPLACED by per-user `/sync/delta` + `SyncMeta.deltaCursor` (old endpoint kept for legacy) |
| 5 s overlap lag | KEPT (inherited by the new delta) |
| Window SWR (`WindowSyncMeta`, TTL, `ensure*Synced`) | DELETED — projection from local replica |
| Footprint invalidation / audit span / rule-change memo wipe | DELETED — per-series reprojection |
| `includeCompleted=true` window plumbing | DELETED — projection includes completed rows natively |
| Daily full reconcile (L6) + calendar-prune guards | DELETED — holes closed structurally (§5.2); optional integrity probe as backlog |
| Heartbeat lifecycle, MainTabs hoist, scenePhase, cold-launch kick, single-flight, jitter/backoff | KEPT (retargeted at `SyncEngine.tick`) |
| In-flight completion shield (+ pending generation-token redesign) | GENERALIZED into the outbox pending-mutation shield (§4.8); the generation-token concern dissolves — resolve-by-key + replay-safe entries subsume it |
| Offline stance: "reads-fresh, not writes-durable"; mutations fail with a red banner | REVERSED (rev 1.1) — durable outbox, exponential backoff to a 30 s steady retry, yellow pending warning (§4.8) |
| Overrides spec — all WRITE semantics, server authority | KEPT; only its §5 "client never expands" READ stance is overturned (§2) |
| BGAppRefresh / silent push slots | KEPT as future phases (push now simply triggers `tick`) |

---

## 7. Phased implementation checklist

**Phase 0 — the engine, de-risked first (both repos, no product change)**
- [ ] 0.1 BE: parity fixture generator + committed `recurrence-parity.json` (§3.5).
- [ ] 0.2 iOS: `RecurrenceEngine` + `EffectiveSettings` port (pure, no SwiftData).
- [ ] 0.3 iOS: fixture replay suite green — **gate for everything below.**

**Phase 1 — backend contract**
- [ ] 1.1 `GET /sync/bootstrap` NDJSON + resume (+ counts header, `end` sentinel).
- [ ] 1.2 `GET /sync/delta` per-user envelope (reminders, exception replace-sets,
      group/calendar snapshots, tombstones, keyset paging, final-page cursor).
- [ ] 1.3 `TaskOccurrenceExceptionFullDTO`; `X-Sync-Revision` interceptor.
- [ ] 1.4 Tests (§3.6); `openapi.yaml`; deprecation notes on old read endpoints.

**Phase 2 — iOS replica + bootstrap**
- [ ] 2.1 Models: `TaskRecord`, `ExceptionRecord`, group `recurrence`, `SyncMeta`
      rework; drop `WindowSyncMeta`/`SyncCursorState` from the schema.
- [ ] 2.2 `BootstrapClient` (bytes/lines, batched commits, checkpoints, resume,
      progress); account-switch wipe keyed on `ownerUserId`.
- [ ] 2.3 `DeltaApplier` (envelope → replica → dirty series), paged apply,
      final-page cursor advance.

**Phase 3 — projection + loop swap**
- [ ] 3.1 `OccurrenceProjector` (per-series projection, horizon, local day counts,
      in-flight shield, key parity).
- [ ] 3.2 `SyncEngine` single-flight tick; heartbeat/scenePhase/deep-link/pull
      retargeting; own-mutation `applyOwnMutation` + debounced kick; APIClient
      header hook.
- [ ] 3.3 Kill list (§4.6) + `SyncStatus` UI (bootstrap progress + subtle delta
      indicator); delete dead loaders.

**Phase 4 — offline write outbox (rev 1.1)**
- [ ] 4.1 BE: optional client-supplied `id` on creates + same-owner dedupe (§3.5).
- [ ] 4.2 iOS: `PendingMutation` model + `OutboxFlusher` (FIFO, backoff 1 s→30 s cap
      then steady 30 s, flush triggers, halt-on-retryable / drop-on-permanent);
      reroute ALL mutation call sites through the outbox (replica write + enqueue in
      one transaction).
- [ ] 4.3 iOS: pending-mutation shield in `DeltaApplier`/projector (tombstone
      override included); completion-toggle compaction.
- [ ] 4.4 iOS: `.warning` banner severity + `pendingWrites` amber status; permanent
      failure → drop + delta kick + red notice.

**Phase 5 — verification**
- [ ] 5.1 Unit: bootstrap resume mid-section; paged-delta interruption; replace-set
      exception apply; snapshot group/calendar deletion; projection key parity;
      outbox FIFO halt/backoff schedule, replayed-create dedupe, shield vs tombstone.
- [ ] 5.2 Acceptance: (a) fresh install → bootstrap progress → full calendar, then
      airplane-mode month/year navigation with ZERO loaders; (b) kill app mid-
      bootstrap → resume completes; (c) assistant (Telegram) edit lands ≤30 s while
      parked on Today; (d) rule change on a series with an override child renders
      correctly (child kept, slot suppressed) — from the fixture corpus, live;
      (e) account switch wipes and re-bootstraps; (f) airplane mode: create + edit +
      complete + delete render instantly, yellow warning appears on first failed
      push; restore network → queue drains within ≤30 s, yellow clears, server
      converges (verify via a second client/assistant read); (g) kill the app with a
      non-empty outbox → relaunch flushes without loss or duplication.

---

## 8. Open questions

1. **Sign-off on the pivot (§2):** client-side expansion with the parity-fixture gate —
   this is the load-bearing decision; an ADR should be cut on approval (supersedes the
   overrides-spec §5 read stance; ADR 0002 untouched).
2. **Bootstrap UX:** progress surface in place of the empty calendar (recommended) vs
   skeleton rows. First-run-only either way.
3. **Horizon defaults:** −12/+24 months materialized, project-on-demand outside
   (recommended) — acceptable, or prefer a full "everything until rule end" horizon?
4. **Old read endpoints** (`GET /tasks` windows, `/tasks/changes`, `/tasks/daily-counts`):
   keep-deprecated for one release then delete, or delete immediately (app unreleased)?
5. **Cursor upgrade:** timestamp+5 s lag (recommended, shipped mechanics) vs per-row
   `syncRevision` stamping (exact, but touches every mutation + migration) — revisit
   only if lag re-reports ever measurably hurt.
6. **Weekly integrity probe** (counts-only bootstrap HEAD vs local counts →
   re-bootstrap on mismatch): backlog or v1?
7. **(rev 1.1) Outbox shield granularity:** v1 shields the whole target row while its
   entries are pending — a concurrent assistant edit to a DIFFERENT field of the same
   task waits until the queue drains. Per-field merge is the upgrade if that proves
   common. Also: should pending (unsynced) rows carry a subtle per-row affordance, or
   is the global amber indicator enough (recommended: global only)?
