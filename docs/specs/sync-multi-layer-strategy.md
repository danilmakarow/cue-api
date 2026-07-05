# CUE Multi-Layer Sync Strategy — Design Document (rev 2, post-review)

**Goal:** the local SwiftData store is never *meaningfully* stale, even though tasks mutate server-side at any time via the Telegram assistant. Achieved by layering redundant, cheap sync triggers on top of the existing SWR cache + delta endpoint — extending, not replacing, what exists.

**What changed in rev 2 (review fold-in, summary):**
1. The heartbeat cycle is now **three steps, not two**: cheap `/sync/state` check → delta → **explicit re-pull of the invalidated windows that are currently on screen** (plus a `GET /task-groups` refresh). Rev 1 wrongly assumed the delta's memo-invalidation alone made changes visible; verified false — `applyDelta` never upserts and nothing re-triggers `ensure*Synced` for a parked user (CalendarStore.swift:518-527 "The TaskDTO row itself is NOT upserted", DayScopeViewController.swift:222-236 `reload()` re-buckets local rows only, TodayView.swift has no revision observer — its only sync is `ensureDaySynced` in `.task` at :131).
2. Delta month-invalidation is widened from the record-audit span `[createdAt, updatedAt+1s]` to the **occurrence footprint** (local ghost months + `startAt`/`endAt` months + all cached memos for recurring series; exceptions invalidate both original and override-target months).
3. `lastSeenRevision` moves off `SyncCursorState` (whose row the failure path deletes, CalendarStore.swift:648-652) onto a new single-row `SyncMeta` model, and is persisted **only after a successful delta round-trip** — `refresh()` gets an outcome return instead of swallowing errors into the ±1-month fallback.
4. The rev-1 "adopt revision after own mutations" optimization is **deleted** — it could swallow a concurrent assistant change for the rest of the session.
5. Every bump-carrying backend mutation gets `@Transactional` (only `TaskService.create/update` and `TaskGroupService.reorder` have it today — verified by grep: task.service.ts:218, :717; task-group.service.ts:129), and the delta query gains a 5s overlap lag to close the in-flight-transaction visibility race.
6. Window fetches send `includeCompleted=true` so a heartbeat-driven re-pull no longer makes completed rows vanish (`GET /tasks` defaults it to false — list-tasks.query.ts:36-47, filter at task.service.ts:488 — and iOS never sends it: zero grep hits under cue-ios).
7. The in-flight completion mechanism is rebuilt around **resolve-by-key + generation tokens** instead of held `@Model` references (toggleCompletion writes through a reference captured across the network await, CalendarStore.swift:793-833), making the shield TTL and the L6 calendar-prune cascade safe.
8. Heartbeat participates in the `refreshTask` single-flight for its whole cycle; counts badges get a `countsEpoch` so the same-week guard (DayScopeViewController.swift:251) no longer suppresses post-delta refreshes.

---

## 1. Architecture overview

```
                        ┌─────────────────────────────────────────────┐
                        │              cue-api (NestJS)               │
                        │                                             │
  REST controllers ──►  │  TaskService / TaskGroupService /           │
  Telegram dispatcher ► │  CalendarService   (single funnel, verified) │
                        │        │ every mutation (@Transactional)     │
                        │        ▼                                     │
                        │  SyncStateService.bump(userId)  ── NEW       │
                        │  user_sync_state (userId PK, revision++)     │
                        │                                             │
                        │  GET /sync/state      ◄── NEW (cheap check)  │
                        │  GET /tasks/changes   ◄── existing delta     │
                        │                          (+5s overlap lag)   │
                        │  GET /tasks?from&to&includeCompleted=true    │
                        │  GET /task-groups     ◄── group freshness    │
                        └─────────────────────────────────────────────┘
                                     ▲
        ┌────────────────────────────┼───────────────────────────────┐
        │                    cue-ios triggers                        │
        │  L1 own-mutation resync (exists)                           │
        │  L2 scenePhase foreground + cold launch (hoisted, fixed)   │
        │  L3 25s heartbeat while active  ── NEW                     │
        │  L4 pull-to-refresh (exists, force)                        │
        │  L5 SWR window TTL 5min (exists)                           │
        │  L6 daily full reconciliation ── NEW safety net            │
        │  L7 BGAppRefresh (optional)                                │
        │  L8 silent push (future Phase-4 slot)                      │
        │                                                            │
        │  All fetch layers converge on ONE single-flight funnel:    │
        │  CalendarStore sync cycle =                                │
        │    delta (footprint invalidation)                          │
        │    → RE-PULL invalidated VISIBLE windows (ensure*Synced)   │
        │    → GET /task-groups upsert+prune                         │
        │  Non-visible invalidated windows heal lazily via L5        │
        │  triggers — correct, because they are not on screen.       │
        └────────────────────────────────────────────────────────────┘
```

Key principle: every layer funnels into one single-flight sync cycle. The delta invalidates precisely; **the cycle itself then re-pulls whatever invalidated window is currently visible** (month of `selectedDate`, month(s) of the visible week if it straddles a boundary, and today's day window for the Today tab). Windows that are invalidated but off-screen stay invalidated (durable memo deleted) and re-pull on their normal interaction triggers — the durable memo delete, not the revision watermark, is the "work remaining" marker. The revision watermark only vouches for *delta application*, never for window freshness.

### Change-signal choice: per-user monotonic revision (not max(updatedAt))

Unchanged from rev 1, with one strengthened requirement (transactionality, §2.4).

Recommendation: **a per-user monotonic revision counter** in a new `user_sync_state` table, bumped explicitly by the feature services.

Why not `GREATEST(max(task.updatedAt withDeleted), max(task_group.updatedAt), max(calendar.updatedAt))`? It is cheap (the `(calendarId, updatedAt)` index from migration `1782700000000` makes it an index-tail read), but it has verified holes:
- **Reminder-only edits** don't bump `task.updatedAt` (task.service.ts:784-798 returns without `.save()`).
- **Group hard delete** (task-group.service.ts:236-240, FK `SET NULL` on members, task.entity.ts:38) removes a row — `max(task_group.updatedAt)` can silently *not change* (or even decrease) while member tasks' effective color/recurrence changed.
- It relies on DB clock semantics and `withDeleted:true` discipline.

An explicit counter closes these holes **provided data write and bump commit atomically** (§2.4) — both write paths already funnel through the same feature services (the Telegram tool dispatcher injects only `TaskService`/`TaskGroupService`/`CalendarService`/`ScheduleReaderService` and never touches repositories — tool-dispatcher.service.ts:192-194, 216-219). TypeORM subscribers were rejected: they do NOT fire for query-builder `.update()` (used by `touchUpdatedAt`, task-database.service.ts:26-28) nor `.delete()`.

Known residual (accepted, bounded): the counter gate makes a *lost* bump worse than under today's ungated delta — mitigated three ways: `@Transactional` everywhere a bump lives (§2.4), the scenePhase path stays revision-**un**gated (L2 always runs the delta), and the heartbeat runs an unconditional delta every Nth tick (§3.2, the "floor").

### Deletion propagation: BOTH tombstones and periodic full reconciliation

- **Primary — tombstones (exists, keep):** `Task` soft-delete (`deletedAt`, task.entity.ts:109-110) surfaces in `GET /tasks/changes` `deleted[]` (task.service.ts:422-429); client series-deletes on them (CalendarStore.swift:544-551). Window prune-then-upsert (CalendarStore.swift:154-165) corrects any window it refetches. Tombstones are never purged today, so cursors of any age remain valid.
- **Safety net — daily full reconciliation (new, client-side):** catches what tombstones structurally cannot: group hard-deletes from other clients (`EventTaskGroup` never pruned — GroupsScreen.swift:123-131), **calendar hard-deletes** (backend `task.calendarId` FK CASCADE hard-deletes tasks with no tombstone — the delta can never report them; §3.6 is the only correction path), delta-fallback misses, exception hard-deletes, cursor corruption. Cost: one memo wipe **plus an immediate re-pull of the visible windows**, bounded row prune, two list GETs, once per 24h.

---

## 2. Backend design (cue-api)

### 2.1 New table + entity

Migration `src/migrations/17xxx-add-user-sync-state.ts`:

```sql
CREATE TABLE "user_sync_state" (
  "userId"    uuid PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "revision"  bigint NOT NULL DEFAULT 0,
  "changedAt" timestamptz NOT NULL DEFAULT now()
);
```

Entity `src/modules/database/entities/user-sync-state.entity.ts` (`@PrimaryColumn('uuid') userId` — deliberately not `BaseEntity`). Per the strict 3-layer convention: `UserSyncStateRepository` + `UserSyncStateDatabaseService` with one custom method:

```ts
/** Atomically increments the user's sync revision (creates the row on first write). */
bump(userId: string): Promise<void>
// INSERT INTO user_sync_state ("userId", revision, "changedAt") VALUES ($1, 1, now())
// ON CONFLICT ("userId") DO UPDATE
//   SET revision = user_sync_state.revision + 1, "changedAt" = now();
```

Atomic upsert — no read-modify-write race. Single-row-per-user contention is negligible at this scale. (Note for the tx work in §2.4: a per-user row briefly serializes concurrent same-user transactions that both bump — acceptable; a single user's REST + assistant writes rarely overlap, and the lock window is the tail of the tx.)

### 2.2 New module: `src/modules/sync/`

- `sync.module.ts` — imports DatabaseModule, exports `SyncStateService`.
- `sync-state.service.ts` — `bump(userId)` (delegates to db-service) and `getState(userId)`.
- `sync.controller.ts` — guarded by `AccessTokenGuard` like task.controller.ts:49.

### 2.3 Endpoint contract — the cheap check

```
GET /sync/state
Authorization: Bearer <JWT>       (no other params — per-USER, unlike the per-calendar delta)

200 OK
{
  "revision": "42",                       // bigint as string; monotonic per user; "0" if no row yet
  "changedAt": "2026-07-02T09:59:58.101Z", // null if revision is "0"
  "serverTime": "2026-07-02T10:00:12.345Z"
}
```

- `revision` is an **opaque equality token**: `revision != lastSeenRevision` ⇒ pull; equal ⇒ skip. String on the wire (PG bigint → TypeORM string), compared as strings.
- Cost: one PK lookup, < 150 bytes. Optional refinement (deferred): `If-None-Match: "<revision>"` → `304`.
- Deliberately per-user while `GET /tasks/changes` stays per-calendar (task.controller.ts:119-144): a bump from an untracked calendar yields an empty delta — harmless, still advances `lastSeenRevision`.

### 2.4 Bump wiring — exact call sites + transactionality (covers REST **and** Telegram automatically)

Inject `SyncStateService` and call `bump(userId)` as the last statement **inside a `@Transactional` boundary on every bump-carrying method**, so data commit and revision commit are atomic. Verified current coverage is only `TaskService.create` (:218), `TaskService.update` (:717) and `TaskGroupService.reorder` (task-group.service.ts:129) — **add `@Transactional` to all of the following** (the lib is already a dependency; matches the f2bea1e precedent). Without this, a crash/blip between data commit and bump leaves a committed change the revision gate then actively hides (worse than today's ungated behavior).

**TaskService** (src/modules/task/task.service.ts) — add `@Transactional` where missing, then bump in:
- `create` (:219), `update` (:718 — bump unconditionally when reminders were provided or any column changed, i.e. including the reminder-only early-return path), `remove` (:940), `setOccurrenceCompleted` (:582), `applyOccurrenceOverride` (:618), `splitSeries` (:847 — multi-row UPDATE+INSERT, the strongest case for a tx), `endSeriesAt` (:964).
- `setCompleted` (:542) currently lacks `userId` — **add it** (`setCompleted(userId, id, isCompleted)`); both callers already hold it: task.controller.ts:321 and tool-dispatcher.service.ts:1473. Lets `setCompleted` own its ownership check, removing the compensating comment at task.controller.ts:317-320.
- **Delegation note (verified):** `setOccurrenceCompleted` collapses to `setCompleted` for non-recurring tasks (task.service.ts:588-593), and the non-recurring override collapse calls `update()`/`remove()`/`setCompleted()` internally (`collapseOverrideToMaster`, :1519-1546). With service-level bumps these paths bump **more than once per request**. This is harmless for a monotonic equality token (the client compares, never counts) and is explicitly accepted — see §2.6 and Appendix A.1.

**TaskGroupService** (src/modules/task-group/task-group.service.ts): `create` (:52), `update` (:80), `reorder` (:130, already tx), `rename` (:218), `remove` (:236) — each `@Transactional`, bump inside.

**CalendarService** (src/modules/calendar/calendar.service.ts): `create` (:19), `@Transactional`, bump inside.

Because the Telegram pipeline terminates in exactly these methods (verified dispatcher call sites: :840, :974, :1019, :1069, :1420, :1466, :1473, :1532, :1543, :1552, :1601, :1635), **the assistant path bumps with zero assistant-side code.** Side benefit: `@Transactional` on `splitSeries`/`remove` also removes the partial-write risk under the assistant queue's `attempts:5` replay.

### 2.5 Delta hardening (fixes known gaps + two review-found races)

1. **Reminder-only edits:** in `TaskService.update`, when `replaceForTask` ran but the field diff is empty (task.service.ts:784-798), call `taskDatabaseService.touchUpdatedAt(taskId)` (exists, task-database.service.ts:26-28) before returning — now inside the same `@Transactional`.
2. **Group changes affecting effective settings:** add `TaskDatabaseService.touchAllInGroup(groupId)` — `UPDATE task SET "updatedAt" = now() WHERE "groupId" = :groupId` — called from `TaskGroupService.update`/`rename` when `color`/`recurrenceConfig`/`requiresCompletion` changed, **inside the method's `@Transactional`** so the group save, the member touch, and the bump become visible atomically (no mid-operation delta can observe the group row changed but members untouched, or vice versa).
3. **Group hard delete (ordering fixed):** in `TaskGroupService.remove` (now `@Transactional`): capture member ids first (`SELECT id FROM task WHERE "groupId" = :groupId`), `delete(group.id)` (FK `SET NULL` fires inside the tx), then `touchByIds(memberIds)` (`UPDATE task SET "updatedAt" = now() WHERE id = ANY(:ids)`), then bump. Touch-**after**-delete means any delta that sees these rows sees the post-delete state (`groupId = null`, fresh `updatedAt`); the tx means no delta can see an intermediate state at all. (Rev 1's touch-before-delete across two commits let a delta cache pre-delete effective settings that no future delta would ever correct.) Add `TaskDatabaseService.findIdsByGroup(groupId)` + `touchByIds(ids)`; the rev-1 `touchAllInGroup(groupId)` remains for §2.5.2 where the group survives.
4. **NEW — 5s overlap lag on the delta cursor (in-flight tx visibility race):** TypeORM stamps `updatedAt`/`deletedAt` when the statement executes inside the transaction, but rows become visible at COMMIT. `findChangedSince` captures `serverTime` before its reads (task.service.ts:402) — that protects the read snapshot, **not** transactions already open whose timestamps predate `serverTime`. A row can commit after a delta read with `updatedAt` earlier than that delta's cursor → invisible to every future delta ("lost update"; the same applies to `deletedAt` tombstones). Rev 1's edge-case claim "at-worst re-reporting, never loss" was wrong. Fix: in `findChangedSince`, apply the predicates against `effectiveSince = since − 5s` (`updatedAt: MoreThan(effectiveSince)`, `deletedAt: MoreThan(effectiveSince)`, and the exceptions query — task.service.ts:410-443); `serverTime` is returned unchanged. Cost: changes made within 5s of the previous delta are re-reported once — the client apply is idempotent (memo deletes, series-row deletes, footprint invalidation are all idempotent). 5s comfortably exceeds any `@Transactional` span here. Residual beyond 5s: acknowledged, bounded by L5/L6 — no longer claimed impossible.

**No other changes to `GET /tasks/changes` semantics.** Group renames/reorders are deliberately NOT added to the delta payload (ChangesDTO carries only `tasks`/`deleted`/`exceptions` — changes.dto.ts:97-109); group freshness is handled client-side by the heartbeat cycle's `GET /task-groups` re-pull (§3.2 step 4), which is simpler than a wire-contract change and covers name/order/color of the group rows themselves.

### 2.6 Backend tests

- Unit: `bump` monotonicity + first-row creation; `getState` zero-state.
- e2e: (a) `GET /sync/state` 401 without JWT; (b) each REST mutation route increments revision **at least once** (delegating methods legitimately bump more than once — see §2.4 delegation note; do not assert exact counts); (c) an assistant tool-dispatch mutation increments revision; (d) reminder-only PATCH now appears in `/tasks/changes`; (e) group color change surfaces member tasks in the delta; (f) group delete reports members with `groupId = null` (post-delete state, per §2.5.3); (g) a change made 3s before a cursor is still reported on the next delta (overlap lag).

---

## 3. iOS design (cue-ios)

### 3.1 Types to add / modify

| Change | File |
|---|---|
| ADD `SyncStateDTO` (`revision: String`, `changedAt: String?`, `serverTime: String`) | cue/Networking/APIModels.swift |
| MODIFY `TaskOccurrenceExceptionDTO`: decode `overrideStartAt: String?` (server already sends it — changes.dto.ts:73, :121-122; client currently decodes only `originalStartAt`, APIModels.swift:522-527) | cue/Networking/APIModels.swift |
| ADD `func syncState() async throws -> SyncStateDTO` (`GET /sync/state`) | cue/Networking/APIClient+Resources.swift |
| ADD **`SyncMeta`** `@Model` — single row: `lastSeenRevision: String?`, `lastFullReconcileAt: Date?` | NEW cue/Models/SyncMeta.swift |
| `SyncCursorState` — **UNCHANGED** (its row is deleted by the delta-failure path, CalendarStore.swift:648-652, and its `cursor` is non-optional, SyncCursorState.swift:35 — it cannot host the watermark) | cue/Models/SyncCursorState.swift |
| MODIFY `CalendarStore`: sync-cycle funnel, `RefreshOutcome`, footprint invalidation, post-delta visible re-pull, `countsEpoch`, in-flight generation map, full reconcile, `includeCompleted=true`, `quiet:` variants of `ensure*Synced` | cue/Features/Calendar/CalendarStore.swift |
| ADD `SyncHeartbeat` (ticker lifecycle) | NEW cue/Features/Sync/SyncHeartbeat.swift |
| MODIFY `MainTabs`: hoist scenePhase, cold-launch kick, own heartbeat | cue/App/RootView.swift:58-175 |
| MODIFY `CalendarHostView`: remove the tab-gated scenePhase handler | cue/Features/Calendar/CalendarHostView.swift:70-72, 135-141 |
| MODIFY `DayScopeViewController`: `countsEpoch` comparison in `loadVisibleCounts` | cue/Features/Calendar/UIKit/Day/DayScopeViewController.swift:242-255 |
| MODIFY `TodayView`: midnight rollover | cue/Features/Calendar/Today/TodayView.swift |
| MODIFY `GroupsScreen.loadGroups`: prune stale `EventTaskGroup` rows | cue/Features/Calendar/Groups/GroupsScreen.swift:123-131 |
| MODIFY deep-link handling: force refresh on `.onOpenURL` | cue/App/cueApp.swift / RootView.swift |
| (Optional) Info.plist `UIBackgroundModes: [fetch]` + `.backgroundTask` scene | cue/Config/Info.plist, cue/App/cueApp.swift |

Adding the new `SyncMeta` model (and any attribute changes) usually survives SwiftData lightweight migration; if not, `cueApp`'s destroy-and-recreate on schema mismatch (cueApp.swift:26-60) wipes the store — acceptable, it is a cache (see edge case 9).

### 3.2 Layer L3 — periodic heartbeat while active (NEW, the centerpiece)

**`refresh()` gets an outcome** (it is currently `private` and swallows all errors into cursor-delete + ±1-month fallback, CalendarStore.swift:464-495 — the caller cannot tell an applied delta from the blunt fallback):

```swift
enum RefreshOutcome {
    case deltaApplied(invalidatedMonths: Set<Date>)  // delta fetched + applied (possibly empty)
    case seeded                                      // first-run cursor seeding (no delta ran)
    case fellBack                                    // error path: cursor cleared, ±1mo resync ran
}
private func refresh(context: ModelContext) async -> RefreshOutcome
```

**The heartbeat cycle** — one entry point, single-flight for the WHOLE cycle (refreshTask is set before the first await, so a scenePhase `refreshIfStale` firing mid-cycle is rejected by its own `guard refreshTask == nil`, CalendarStore.swift:441-447, and vice versa — rev 1's guard-then-call-private-refresh left refreshTask nil across the cycle, allowing concurrent deltas with the same cursor and last-writer cursor regression):

```swift
// CalendarStore.swift — constants next to windowTTL (:44) / staleThreshold (:35)
private let heartbeatInterval: TimeInterval = 25
private let heartbeatFailureBackoff: [TimeInterval] = [25, 60, 120, 300]
private let unconditionalDeltaEvery = 12   // ~5 min floor, see below

/// One heartbeat cycle. SILENT on all failures (no banners; breadcrumb/log only).
func heartbeatTick(context: ModelContext) async {
    guard refreshTask == nil else { return }
    let cycle = Task { [weak self] in await self?.runHeartbeatCycle(context: context) }
    refreshTask = cycle                      // claimed BEFORE any await
    defer { refreshTask = nil }
    await cycle.value
}

private func runHeartbeatCycle(context: ModelContext) async {
    // 1) Cheap check
    guard let state = try? await api.syncState() else { /* backoff */ return }
    let meta = syncMeta(context)             // SyncMeta row, NOT SyncCursorState
    let revisionMoved = state.revision != meta.lastSeenRevision
    let floorDue = tickCount % unconditionalDeltaEvery == 0
    guard revisionMoved || floorDue else { return }   // idle skip

    // 2) Delta (revision read BEFORE the delta: writes landing mid-delta produce
    //    a higher revision → caught next tick)
    let outcome = await refresh(context: context)
    guard case .deltaApplied(let invalidated) = outcome else { return }
    //    ^ .seeded / .fellBack: lastSeenRevision NOT advanced → next tick retries.
    //      The fallback's ±1mo resync already ran; the durable memo state is intact.

    // 3) Re-pull invalidated windows that are ON SCREEN (closes the two-step gap)
    await resyncVisibleWindows(intersecting: invalidated, context: context)

    // 4) Group freshness: renames/reorders bump the revision but have no delta
    //    payload (§2.5); one tiny list GET per revision-moved cycle.
    guard await refreshGroups(context: context) else { return }  // fail → retry next tick

    // 5) Only now vouch for the revision
    meta.lastSeenRevision = state.revision
    try? context.save()
}
```

**Step 3 — `resyncVisibleWindows` (the fix for the parked-user hole):** compute the on-screen anchor set — `month(selectedDate)`, `month(today)` (Today tab is always "on screen" in spirit: it renders via a day-bounded `@Query`), and if the visible week straddles a month boundary, the neighbor month — intersect with `invalidatedMonths`, and for each hit `await ensureMonthSynced(anchor, context:, quiet: true)`; if today's month was hit (or any deleted series had rows today) also `await ensureDaySynced(today, context:, quiet: true)`. The re-pull prune-then-upserts real `TaskItem` rows → TodayView's `@Query` and the Day scope's revision-driven `reload()` now have actual new data to render. `quiet: true` is a new parameter on `ensureMonthSynced`/`ensureDaySynced` that suppresses the error banner (heartbeat work must never surface user-facing errors; the existing banner at CalendarStore.swift:175 stays for user-initiated paths). If a re-pull fails, the memo stays deleted (durably stale) → any later trigger retries; persisting `lastSeenRevision` afterwards is still sound because the watermark vouches for delta application only, and the missing memo is the durable retry marker.

Off-screen invalidated months deliberately do NOT re-pull in the cycle — they are not visible, and their deleted memos make the next interaction trigger (willDisplay/settle/selection/prefetch) or L5/L6 fetch them fresh. This bounds heartbeat network cost to what the user can actually see.

**Counts badges:** add `private(set) var countsEpoch: Int` to CalendarStore, incremented inside `invalidateDayCounts` (CalendarStore.swift:283-287, called from every `commit`). `DayScopeViewController.loadVisibleCounts` changes its guard from `weekRange != lastLoadedCountsWeek` to `(weekRange, epoch) != (lastLoadedCountsWeek, lastLoadedCountsEpoch)` (DayScopeViewController.swift:251-252). Rev 1 claimed the revision-driven reload path bypassed this guard — verified false (the in-code comment at :244-250 says the exact opposite: a bare revision bump "must do ZERO count work"); the epoch makes the intended behavior real while preserving the guard's original purpose (no count work when nothing count-relevant changed — the epoch only moves when `dayCountsCache` was actually invalidated).

**Unconditional-delta floor:** every `unconditionalDeltaEvery`-th tick (~5 min) the cycle runs the delta even when the revision looks unmoved. This is the self-healing floor for any lost bump (§2.4 makes those structurally rare; this makes them bounded at ~5 min instead of open-ended) and for any future counter bug. Cost: one near-always-empty delta per 5 idle minutes.

`SyncHeartbeat` (NEW file, `@MainActor final class`): owns a `Task` loop — `try await Task.sleep(for:)` with ±20% jitter, calls `store.heartbeatTick`, applies failure backoff (reset on success), `start()`/`stop()` idempotent. Kept out of `CalendarStore` so the ticker is unit-testable with an injected clock. 401 from `/sync/state` stops the ticker and defers to the auth flow.

### 3.2b Delta invalidation — occurrence footprint, not audit span

Rev 1 kept the existing span `[task.createdAt, task.updatedAt+1s]` (CalendarStore.swift:556-575, `seriesSpanEnd` :590-592). Verified hole: `updatedAt` is always ~now, so **months strictly in the future are never invalidated** — yet future items are the dominant edit target in a planner (task created now for next month: `createdAt == updatedAt == now` → only the current month invalidated; `endSeriesAt`/`splitSeries` leave truncated-future ghost occurrences in cached future months; a per-occurrence override never invalidates the month it moved the occurrence INTO — exceptions invalidate only `originalStartAt`'s month, :566-569). Replace `applyDelta` steps (b) and (c):

**(b) changed series** — for each `task` in `response.tasks`:
1. **Ghost sweep:** fetch local `TaskItem` rows with `seriesId == task.id`; invalidate the month memo of each row's `occurrenceStart` (that is where stale occurrences physically live — covers moves-away, truncations, past-dated edits).
2. Invalidate `month(task.startAt)` and `month(task.endAt)` when present (where occurrences now live / will live).
3. Keep the audit-span walk `[createdAt, updatedAt+1s]` (cheap, subsumes the old behavior).
4. **If the task is recurring** (`task.recurrence != nil`): delete ALL `month`-scope `WindowSyncMeta` rows for the calendar (`invalidateAllSyncedMonths` exists, CalendarStore.swift:687-699) — a rule change can place occurrences in any month; memos are cheap and the re-pull is lazy per window, bounded by eviction.

**(c) changed exceptions** — invalidate the month containing `originalStartAt` **and**, when the DTO carries `overrideStartAt`, the month containing it (destination month of a moved occurrence). Requires the one-field DTO addition in §3.1.

`invalidatedMonths` (the union of all anchors whose memo was deleted, plus a marker when tombstones deleted rows) is what `applyDelta` reports up through `RefreshOutcome.deltaApplied` for step 3 of the cycle. Collection is trivial — the invalidation helpers already compute each anchor.

Tombstone handling (a), in-flight reconcile (d), and the single-commit cursor advance (e) are unchanged (CalendarStore.swift:536-586), except tombstone months also join `invalidatedMonths` so a visible window showing a deleted series gets its counts/pages refreshed through the same path.

### 3.2c `includeCompleted=true` on window fetches

`GET /tasks` defaults `includeCompleted` to false (list-tasks.query.ts:36-47; filter at task.service.ts:488) and iOS never sends the param — so every window re-pull's prune-then-upsert **removes completed occurrences** (prune deletes all in-window rows sparing in-flight keys, CalendarStore.swift:225-248; the upsert never gets the completed row back). Today that is a slow leak (5-min TTL + trigger); the heartbeat would make it deterministic: check a task, and ≤30s later the completion bump → delta → visible-window re-pull erases the row you just checked. Fix: append `URLQueryItem(name: "includeCompleted", value: "true")` to the window fetch in `ensureMonthSynced`/`ensureDaySynced` (CalendarStore.swift:145-152) and render completed rows (the UI already renders `completedAt` — checked/struck styling exists; completed rows are what the user sees immediately after toggling). The daily-counts endpoint keeps its default (badges = remaining items) — deliberate; flag to product if badges should change (open question).

### 3.3 Layer L2 — scenePhase + cold launch (hoist, fixing the tab-gated handler)

Move the handler from `CalendarHostView` (tab-lazy — dead until the Calendar tab is first opened) to **`MainTabs`** (cue/App/RootView.swift:58-175), which owns the shared `CalendarStore` (:65-70) and is mounted for the whole authenticated session:

- `.task`: after `bind`, cold-launch kick — `store.refreshIfStale(context:wasBackgrounded: true)` (today the delta never runs at launch on the default Today tab) — then `heartbeat.start()`.
- `.onChange(of: scenePhase)`: `.active` → `refreshIfStale(wasBackgrounded:)` (existing 30s `staleThreshold` gate, :450-453) + `heartbeat.start()`; `.inactive`/`.background` → `heartbeat.stop()`.
- Delete `CalendarHostView.handleScenePhaseChange` + its `.onChange` (:70-72, :135-141).
- **`refreshIfStale` is deliberately revision-UNgated** (it runs the delta whenever stale/backgrounded, without consulting `lastSeenRevision`) — this is a designed redundancy: it is the backstop for any watermark pathology (lost bump, wrongly-adopted revision). Its internal `refresh()` call now also feeds `resyncVisibleWindows` on `.deltaApplied`, same as the heartbeat (both share the cycle body; only the gate differs).

### 3.4 Layer L1 — after own mutations (exists; rev-1 addition DELETED)

`invalidateAndResync` (CalendarStore.swift:659-678) already gives immediate convergence after create/edit/delete/skip. Rev 1 added "fetch `/sync/state` once and adopt `lastSeenRevision`" to skip one redundant delta — **removed**: the adopted revision is not necessarily the client's own bump. If the assistant writes between the user's mutation and the state fetch, the client adopts a revision whose data it never pulled (the ±1-month resync covers the wrong months and no delta ran) and the heartbeat then skips that change for the rest of the session. The cost of doing nothing is one near-empty gated delta on the next tick (~2 requests) — accepted. Optional future (backlog, out of scope): mutation endpoints return the post-bump revision so the client can adopt exactly its own bump; requires a response-DTO change on every mutation route.

### 3.5 Layer L4 — pull-to-refresh + deep links (force path)

Add a `force: Bool = false` parameter to `refreshIfStale` that bypasses the 30s gate and the revision equality check (still funnels through the single-flight guard):
- TodayView `.refreshable` (TodayView.swift:126-129) → `refreshIfStale(force: true)` in addition to the existing `invalidateAndResync(around: today)`.
- **Telegram deep-link opens** (`cue://` scheme exists in Info.plist): `.onOpenURL` in RootView → `refreshIfStale(force: true)` — an open from the bot chat strongly implies a just-made server-side change. If the URL arrives pre-auth (cold start), stash a pending-refresh flag consumed by the MainTabs `.task` kick.
- Calendar scopes still have no `UIRefreshControl` — acceptable now that L2+L3 cover them.

### 3.6 Layer L6 — daily full reconciliation (NEW safety net)

`CalendarStore.fullReconcileIfDue(context:)`, checked from the MainTabs `.task` kick and from the first heartbeat tick after `SyncMeta.lastFullReconcileAt + 24h` (on the `SyncMeta` row — NOT `SyncCursorState`, whose row every delta failure deletes; rev 1's placement meant each network blip either forced a spurious reconcile or indefinitely postponed it):

1. Delete all `WindowSyncMeta` rows (month + countsWeek) and clear `dayCountsCache`.
2. **Immediately re-pull the visible windows** — `ensureMonthSynced(month(selectedDate), quiet: true)`, straddle neighbor if applicable, `ensureDaySynced(today, quiet: true)` — the memo wipe alone triggers no network for a parked user (revision-driven `reload()` re-buckets local rows only, DayScopeViewController.swift:222-236), so without this step the safety net "runs" while every on-screen ghost stays. The ≤24h budget in §5 is honest only with this step; off-screen windows still heal per-window on next interaction.
3. Prune `TaskItem` rows with `occurrenceStart` outside `[today − 90d, today + 366d]`, sparing `inFlightCompletions` keys (COALESCE-predicate pattern; index caveat per TaskItem.swift:43-51 accepted for a daily batch).
4. Re-fetch `GET /calendars` → upsert and prune `EventCalendar`, **with guards — the prune is a loaded gun**: `EventCalendar` cascade-deletes ALL its `TaskItem` rows (`@Relationship(deleteRule: .cascade, inverse: \TaskItem.calendar)`, EventCalendar.swift:23) — a relationship-level cascade none of the in-flight shields cover (they only guard the store's own delete loops at CalendarStore.swift:245, :549, :732). Guards: (a) never prune when the response is empty or the request failed; (b) never prune the memoized default calendar on first disappearance — require it missing on two consecutive reconciles (a transient/mangled response — e.g. the Debug ngrok tunnel — must not wipe the cache); (c) defer the prune to the next reconcile if `inFlightCompletions` is non-empty; (d) when pruning a calendar, also delete its `SyncCursorState` row (cursor rows are per-calendarId, SyncCursorState.swift:28-45) and reset the memoized `calendarId`. The legitimate case is real and this is its ONLY correction path: backend calendar delete hard-deletes tasks via FK CASCADE with no tombstone, so the delta can never report them. Late completion-PATCH writes against cascade-deleted rows are made safe by §4's resolve-by-key redesign (a missing row → skip write), not by sparing rows from the cascade (impossible — see Appendix A.3).
5. Re-fetch `GET /task-groups` → upsert and prune `EventTaskGroup`. Independently, make `GroupsScreen.loadGroups` (GroupsScreen.swift:123-131) prune-after-upsert so the Groups screen self-heals on every visit.
6. `commit(context)` + stamp `SyncMeta.lastFullReconcileAt`.

### 3.7 Layer L7 (optional) — BGAppRefresh

- `Config/Info.plist`: `UIBackgroundModes: [fetch]` + `BGTaskSchedulerPermittedIdentifiers: [app.cue.refresh]`.
- `cueApp.swift`: `.backgroundTask(.appRefresh("app.cue.refresh"))` scene modifier; handler builds a `ModelContext(sharedModelContainer)`, calls `syncState` → gated cycle if changed, reschedules. Requires the auth token loadable headlessly via `AuthTokenBridge` (APIClient.swift:353) — verify before enabling. Strictly best-effort cache-warming; ship last.

### 3.8 Layer L8 (future) — silent push: what Phase-4 slots into

- **Client:** `aps-environment` entitlement + minimal `@UIApplicationDelegateAdaptor` AppDelegate: `didRegisterForRemoteNotificationsWithDeviceToken` → `PushTokenInbox` (already built: OnboardingNotificationPermission.swift:79, APIClient+Resources.swift:88-96 → `POST /users/me/devices`, device.controller.ts:33-80) and `didReceiveRemoteNotification(content-available:1)` → `store.refreshIfStale(force: true)`.
- **Server:** hook `SyncStateService.bump` — debounce per user (~5s, collapse assistant multi-tool turns) → silent APNs to registered devices. Independent of the reminder/`ScheduledNotification` outbox (backlog D1).
- Staleness drops to push latency even while backgrounded; heartbeat + scenePhase remain as redundancy.

### 3.9 Midnight rollover fix

`TodayView.today` is captured at init and the tab persists all session. Fix: `@State private var dayAnchor = CalendarMath.startOfDay(.now)`; subscribe to `.NSCalendarDayChanged` (+ `UIApplication.significantTimeChangeNotification` for tz changes); on fire, update `dayAnchor` and call `ensureDaySynced(dayAnchor)`. Because the `@Query` bounds are init-captured, split the body into an inner `TodayContentView(day:)` with `.id(dayAnchor)` so a day change re-inits the query window. `MorningBriefStore`'s per-local-day session cache (MorningBriefStore.swift:63-81) then keys to the new day naturally.

---

## 4. Conflict policy — local optimistic writes vs incoming pulls

The app has exactly two optimistic writes (completion toggle, group reorder); everything else is server-first, so pulls can never clobber those.

**Completion toggle — mechanism rebuilt (rev 1's bare 60s TTL was unsafe):** `toggleCompletion` currently holds the `TaskItem` object reference across the network await and writes to it on resolution — success `task.completedAt = result.completedAt`, failure rolls back to the captured `previous` (CalendarStore.swift:793-833). The shield's job today is precisely to keep that row alive; dropping the shield on a timer without touching the continuation creates writes-to-deleted-`@Model` (prune-then-upsert deletes and recreates rows, :154-165) and stale rollbacks that clobber newer server truth. New mechanism:

1. **Generation-tokened in-flight map:** `inFlightCompletions: [String: InFlight]` where `struct InFlight { let expectedCompletedAt: Date?; let startedAt: Date; let generation: Int }`, plus a monotonically increasing `completionGeneration`. All existing guards keep using key membership (prune :245, tombstones :549, eviction :732, reconcile :253-263 — reconcile applies `expectedCompletedAt`).
2. **Resolve by key, never by reference:** on PATCH resolution, re-fetch the row via a fresh `FetchDescriptor` on `occurrenceKey` and apply the write **only if** `inFlightCompletions[key]?.generation` still equals this call's generation. Row missing (pruned, cascade-deleted, tombstoned) → skip the write entirely. This also makes the L6 calendar-cascade path (§3.6.4) safe.
3. **Shield TTL = 120s** (must exceed the URLSession per-request timeout — APIClient sets none, so the default 60s applies; a 60s TTL would expire exactly when slow-but-successful requests resolve): `reconcileInFlightCompletions` drops entries with `startedAt` older than 120s. A dropped entry means later pulls restore server truth for that row.
4. **Late resolutions after TTL expiry (generation mismatch):** late **success** → the server committed the completion but the local row may have been pruned/reverted; do NOT write the row — instead fire a targeted `ensureDaySynced(day(occurrenceStart), quiet: true)` so server truth (which now includes the completion, and window fetches include completed rows per §3.2c) re-lands. Late **failure** → skip the rollback (the shield is gone; whatever is local is newer truth or will be corrected by the next pull); no banner (the user has moved on; the row already reverted at TTL expiry, which is the honest signal for a write that never landed).
5. **Server wins after an in-generation ack; local wins while shielded** — unchanged semantics.
6. **Ordering/single-flight:** all sync entry points are `@MainActor` and route through `refreshTask`, which the heartbeat now holds for its whole cycle (§3.2).

**Phantom-completion race (explicitly accepted loss):** `setOccurrenceCompleted` is deliberately lenient on `originalStart` membership (task.service.ts docblock ~:575-580 — "a completion on a phantom coordinate is harmless and never surfaces in a read"). If the assistant rekeys a series (all-scope time move / `splitSeries` — recurrence-rule.service.ts:564, :671-681 exact epoch-ms matching; splitSeries changes the series id, task.service.ts:847-933) in the same instant the user toggles an occurrence, the user's PATCH can land on a now-phantom coordinate, be ACKed with a real `completedAt`, and then be silently reverted when the heartbeat re-pulls the re-expanded occurrences. **This design accepts that loss** for a single-user personal planner: the collision window is sub-second, requires the user and the assistant to mutate the same series simultaneously, and the heartbeat at least makes the revert visible within ≤30s instead of leaving silent local/server divergence. Backlog item (not in scope): have the completion response carry a membership signal (the service already computes `isOccurrenceScoped`; extending it to "matched a live generated occurrence" costs one rule expansion per recurring toggle) so the client can warn/retry.

**Field-level policy for series edits:** last-writer-wins at the series level, server-authoritative (existing `PATCH /tasks/:id` tri-state replace). If the assistant edits a task while the user has `TaskEditScreen` open, the user's later save overwrites — accepted. The heartbeat shrinks the stale-edit-screen window; `TaskDetailScreen`'s once-per-mount `seriesDTO` fetch can additionally re-fetch on `store.revision` change as a small follow-up.

---

## 5. Staleness budget per layer

| # | Layer | Trigger | Worst-case staleness | Status |
|---|---|---|---|---|
| L1 | Own-mutation resync | after mutation ack | ~0 (immediate ±1mo invalidate + repull) | exists |
| L2 | scenePhase + cold launch | every `.active` transition, any tab; app launch | 1 delta RTT (~1–2s) after return/open; revision-UNgated (backstop) | exists but tab-gated → **hoist** |
| L3 | Heartbeat | every 25s (±20% jitter) while `.active` | interval + RTT + visible re-pull ≈ **≤30s active-foreground for on-screen content** (hard requirement); off-screen invalidated windows: on next interaction (memo already deleted) | NEW |
| L4 | Pull-to-refresh / deep link | manual / `onOpenURL` | 0 (force) | exists / extend |
| L5 | SWR window TTL | any scroll/nav/willDisplay trigger | ≤5 min per touched window | exists |
| L6 | Full reconciliation | first kick/tick after 24h | ≤24h for tombstone-blind cases, **including an immediate visible-window re-pull** (off-screen: 24h + next interaction per window) | NEW |
| L7 | BGAppRefresh | iOS-discretionary | best-effort (hours); cache-warming only | optional |
| L8 | Silent push | server bump (debounced ~5s) | seconds, even backgrounded | future Phase-4 |

Idle network cost: 1 tiny GET / 25s while foregrounded (~2.4 req/min) + one near-empty delta per ~5 min (the floor tick). Delta + visible-window pulls + one `GET /task-groups` run only when the revision actually moved.

---

## 6. Edge cases

1. **Revision race during delta:** `lastSeenRevision` is the value read *before* the delta; mid-delta writes yield a higher revision → next tick pulls again. The delta's own cursor is protected by the 5s overlap lag (§2.5.4) — changes committing around a read are at worst re-reported once (idempotent apply). Residual loss beyond the 5s lag: acknowledged, bounded by the floor tick, L2 (ungated), L5, L6 — **no longer claimed impossible** (rev 1's "never loss" was wrong for in-flight transactions).
2. **Bump from an untracked calendar:** per-user signal, per-calendar delta → empty delta, cursor + `lastSeenRevision` advance (an empty applied delta is a *successful* round-trip), no UI churn (empty-delta path does not bump `revision`, CalendarStore.swift:536-540).
3. **Heartbeat failures:** silent (breadcrumb only), backoff 25→60→120→300s, reset on success; 401 stops the ticker.
4. **Delta failure / fallback:** `refresh()` returns `.fellBack` (cursor cleared, ±1mo resync ran) — the heartbeat does NOT advance `lastSeenRevision`, so the next tick retries; when the retry's first-run branch seeds a fresh cursor (`.seeded` — also non-advancing), the tick after that runs a real delta on the seeded cursor. Changes predating the seed are covered by the fallback's resync (visible months) and L5/L6 (others). Tombstones predating the seed are the known worst case (a since==null delta returns empty sets by contract, task.service.ts:404-406) — healed by window prune-then-upsert on re-fetch and by L6; the heartbeat is never self-disabled for them because the revision was not marked seen.
5. **Offline:** heartbeat backs off quietly; scenePhase/pull triggers fail into existing banner paths; mutations remain non-queued (explicit non-goal — reads-fresh, not writes-durable).
6. **Clock skew:** irrelevant — the revision is a server-side counter compared for equality; the delta cursor is the server's own `serverTime` echoed verbatim.
7. **Split series / endSeriesAt:** `@Transactional` (§2.4) makes the multi-row mutation + bump atomic; the delta reports both rows; the **footprint invalidation** (§3.2b — ghost sweep of local rows by seriesId + recurring ⇒ all cached memos) covers the truncated-future occurrences that the old audit-span walk missed. (Rev 1's claim that `[createdAt, updatedAt+1s]` "covers both series' windows" was wrong for any future-anchored split.)
8. **Exception rekeying landmine** (all-scope edit orphans exception rows, recurrence-rule.service.ts:564): delta reports the updated series → footprint invalidation + visible re-pull replaces occurrences with server truth. Server-side orphaning itself is out of scope. The *write-side* variant (completion racing a rekey) is the accepted loss in §4.
9. **SwiftData schema wipe** (cueApp destroy-and-recreate, cueApp.swift:26-60): loses cursor + `SyncMeta` → first tick sees nil ≠ revision, runs the first-run seed (`.seeded`, non-advancing), next tick runs a real delta; SWR re-pulls visible windows. Self-healing.
10. **Double-fire on foreground** (scenePhase + first heartbeat tick): the heartbeat holds `refreshTask` for its whole cycle and `refreshIfStale` checks the same token — exactly one runs (§3.2). No concurrent deltas, no cursor last-writer races.
11. **Battery/App-Review posture:** timer runs only while `.active`; `Task.sleep` respects suspension; jitter avoids synchronized fleets; optional ETag/304 if the 25s GET ever matters.
12. **MainTabs `.task` lifetime:** MainTabs persists for the whole authenticated session; tie `heartbeat.stop()` to task cancellation (sign-out/teardown).
13. **Counts-badge staleness:** fixed via `countsEpoch` (§3.2) — the same-week guard stays (its purpose per the in-code comment at DayScopeViewController.swift:244-255 is zero count work for irrelevant revision bumps) but a delta that invalidated `dayCountsCache` moves the epoch and re-fetches the visible week.
14. **`GET /sync/state` before first mutation:** revision "0", `changedAt` null — client treats `nil → "0"` as changed once, runs one delta, settles.
15. **Group rename/reorder via assistant:** bump → heartbeat cycle → task delta is empty, but step 4's `GET /task-groups` upsert+prune refreshes `EventTaskGroup` — names/order converge ≤30s (rev 1 left these stale up to 24h without saying so).
16. **Completed rows:** window fetches include them (§3.2c) — a completion (own or assistant's) renders as a checked row after any re-pull instead of vanishing.

---

## 7. Phased implementation checklist (BE first, FE second)

### Phase 1 — Backend: change signal + delta hardening (cue-api)
- [ ] 1.1 Migration `add-user-sync-state` (table, PK `userId`, FK CASCADE, defaults).
- [ ] 1.2 `UserSyncState` entity + repository + `UserSyncStateDatabaseService.bump/get` (atomic upsert; 3-layer pattern).
- [ ] 1.3 `SyncModule`: `SyncStateService` (`bump`, `getState`), `SyncController` `GET /sync/state` (AccessTokenGuard, Swagger DTO per §2.3).
- [ ] 1.4 `@Transactional` on every bump-carrying method that lacks it: TaskService `remove`/`setCompleted`/`setOccurrenceCompleted`/`applyOccurrenceOverride`/`splitSeries`/`endSeriesAt`; TaskGroupService `create`/`update`/`rename`/`remove`; CalendarService `create`.
- [ ] 1.5 Bump wiring inside those boundaries: TaskService ×8 (incl. `setCompleted(userId, …)` signature change + both call sites), TaskGroupService ×5, CalendarService.create — per §2.4.
- [ ] 1.6 Delta hardening: reminder-only `touchUpdatedAt` (task.service.ts:784-798); `touchAllInGroup` in group update/rename (same tx); `findIdsByGroup` + delete-then-`touchByIds` in group remove (same tx, §2.5.3); **5s overlap lag in `findChangedSince`** (§2.5.4).
- [ ] 1.7 Tests per §2.6 (at-least-once revision assertions; overlap-lag e2e).
- [ ] 1.8 Deploy note: run migration; SSM env untouched (no new config).

### Phase 2 — iOS: core loop
- [ ] 2.1 `SyncStateDTO` + `syncState()`; decode `overrideStartAt` on `TaskOccurrenceExceptionDTO`.
- [ ] 2.2 NEW `SyncMeta` @Model (`lastSeenRevision`, `lastFullReconcileAt`); verify lightweight migration or accept cache wipe.
- [ ] 2.3 `CalendarStore`: `RefreshOutcome` on `refresh()`; footprint invalidation in `applyDelta` (§3.2b) returning `invalidatedMonths`; `includeCompleted=true` + `quiet:` on `ensure*Synced`; `countsEpoch`.
- [ ] 2.4 Heartbeat cycle (`heartbeatTick` holding `refreshTask` for the whole cycle; `resyncVisibleWindows`; `refreshGroups`; outcome-gated `lastSeenRevision` persist; unconditional-delta floor).
- [ ] 2.5 NEW `SyncHeartbeat.swift` (jitter, backoff, start/stop, injected clock).
- [ ] 2.6 `MainTabs`: cold-launch kick + heartbeat lifecycle + hoisted scenePhase; delete `CalendarHostView` handler (:70-72, :135-141). `DayScopeViewController`: epoch-aware counts guard.
- [ ] 2.7 **Acceptance test A (parked Today):** launch on Today tab, do not touch the device; assistant creates a task *for today* via the real Telegram bot → row appears ≤30s with zero interaction. **Acceptance test B (parked future Day scope):** Day scope parked on a date next month; assistant renames/moves a task that day → converges ≤30s. **Acceptance test C (completion):** check a task off, wait 60s foregrounded → row stays visible as completed (no vanish).

### Phase 3 — iOS: hardening layers
- [ ] 3.1 In-flight completion redesign: generation map, resolve-by-key, 120s TTL, late-resolution rules (§4).
- [ ] 3.2 TodayView midnight rollover (`dayAnchor` + `.NSCalendarDayChanged` + `.id`).
- [ ] 3.3 `GroupsScreen.loadGroups` prune-after-upsert.
- [ ] 3.4 `fullReconcileIfDue` (§3.6 steps 1–6, incl. calendar-prune guards + visible re-pull) wired to launch kick + 24h tick.
- [ ] 3.5 Deep-link `onOpenURL` → `refreshIfStale(force: true)` (+ pre-auth pending flag).
- [ ] 3.6 Silence heartbeat errors (no banners); breadcrumb/log only.

### Phase 4 — optional: BGAppRefresh
- [ ] 4.1 Info.plist background mode + task identifier; `.backgroundTask(.appRefresh)` handler; verify headless token via `AuthTokenBridge`; reschedule-on-run.

### Phase 5 — future: silent push (separate effort)
- [ ] 5.1 `aps-environment` entitlement + minimal AppDelegate adaptor → `PushTokenInbox` → existing `POST /users/me/devices`.
- [ ] 5.2 Server: debounced silent-push sender hooked on `SyncStateService.bump` (APNs provider lib — new dependency, flag before adding).
- [ ] 5.3 Client `didReceiveRemoteNotification` → `refreshIfStale(force: true)`.

---

## Appendix A — Rejected / amended review points

All 28 review findings were verified against the working trees. The duplicate clusters (1≈20, 2≈21, 3≈12≈24, 4≈15≈23, 5≈16, 6≈18, 7≈14, 8≈19≈28, 9≈27, 10, 11, 13, 17, 22, 25, 26) are each addressed once above. The following specific reviewer *suggestions or framings* are rejected or amended:

**A.1 — Finding 26, "exactly-once is unimplementable → bump at the controller/dispatcher boundary instead": suggestion rejected, test amended.** The delegation double-bumps are real (verified: task.service.ts:588-593, :1519-1546), but moving bumps to the entry points is the wrong fix: it doubles the wiring surface (every controller route AND every dispatcher tool arm — the dispatcher calls service methods directly, so controller-only bumping silently drops the entire assistant path, the design's raison d'être) and reintroduces the "new entry point forgets the bump" failure mode the service-level placement structurally prevents. Multi-bumps are harmless for an equality-compared monotonic token. Resolution: keep service-level bumps, relax the e2e to at-least-once (§2.6b).

**A.2 — Finding 13, alternative "exempt completed-today rows from prune": rejected in favor of `includeCompleted=true`.** A prune exemption makes the prune's contract incoherent (a row completed locally but *moved/deleted* server-side would survive the exact sweep that exists to remove it) and still renders assistant-made completions as row-disappearance. Sending the flag aligns the refetch with what the UI already renders post-toggle. The finding's substance (vanish-on-complete) is confirmed and fixed (§3.2c).

**A.3 — Finding 11, suggestion "make the reconcile prune spare rows whose occurrenceKey is in inFlightCompletions": not implementable as stated.** The deletion is a SwiftData relationship cascade (`deleteRule: .cascade`, EventCalendar.swift:23), not a store-owned loop — there is no per-row hook to consult the in-flight map. The hazard is real and is fixed differently: the prune itself is gated (empty-response refusal, two-strike rule for the default calendar, defer-while-in-flight — §3.6.4), and late PATCH writes become harmless via resolve-by-key + generation (§4.2), which protects against *every* row-disappearance path, not just this one. The same finding's `.nullify` alternative is rejected: for a genuinely deleted calendar the tasks are hard-deleted server-side, so cascade is the correct semantic; nullify would leave permanent orphans.

**A.4 — Finding 19, suggestion "unconditional delta every Nth tick as a substitute for transactions": accepted only as a complement.** The floor tick (§3.2) is in, but `@Transactional` everywhere a bump lives (§2.4) is the primary fix — a 5-minute floor alone would leave the assistant-queue replay (attempts:5) partial-write risk on `splitSeries` unaddressed, which the tx fixes for free.

**A.5 — Finding 17 (phantom completion): accepted as an explicit loss, not fixed.** Both suggested fixes require server work whose cost is out of proportion for a single-user planner (membership signal = one rule expansion per recurring completion toggle; the docblock at task.service.ts:~575-580 chose leniency deliberately). The design now documents the loss, bounds its visibility (revert within ≤30s instead of silent divergence), and records the membership-signal option as backlog (§4).

**A.6 — Findings 5/16, framing "the 25s poll makes the miss a certainty over time": amended, fix adopted anyway.** The per-event window is the tail of a tx (tens of ms), and "certainty" overstates a probabilistic accumulation — but the reviewers are right that rev 1's "never loss" claim was false and that heartbeat-scale sampling makes the anomaly matter. The 5s overlap lag (§2.5.4) is cheap and closes it to a documented residual.

**A.7 — Finding 27, sub-claim "two commit() calls double-bump revision … the earlier response can overwrite the later cursor": correct as mechanics, moot as designed.** With the heartbeat holding `refreshTask` for its entire cycle (§3.2), no second delta can start mid-cycle, so the cursor-regression interleaving cannot occur; no separate cursor-merge logic is added.

## Open questions

(see structured field)


## Open questions
- Product call on includeCompleted=true rendering: Day/Month windows will now retain completed occurrences after re-pulls (checked/struck rows). Should the Month-scope chips and the day-count badges also count completed items, or keep badges = remaining-only (current recommendation: badges keep excluding completed via the counts endpoint default)?
- Should mutation endpoints return the post-bump revision in their response DTOs (backlog option in §3.4) so the client can safely skip the one redundant post-own-mutation delta? Touches every mutation route's response contract — deferred unless the redundant delta proves noisy.
- L6 calendar-prune two-strike rule: is a 24h-apart double confirmation acceptable before dropping a disappeared default calendar (worst case 48h of ghost rows for a genuinely deleted calendar), or should a user-visible resolution flow exist for the multi-calendar future?
- Phantom-completion membership signal (§4 accepted loss / Appendix A.5): confirm the accepted-loss stance, or green-light the server-side isOccurrenceScoped extension (one rule expansion per recurring completion toggle) now rather than as backlog.
- Heartbeat unconditional-delta floor cadence: every 12th tick (~5 min) chosen as belt-and-suspenders for lost bumps; drop entirely if the @Transactional coverage in §2.4 is considered sufficient, or keep — cost is one near-empty delta per 5 idle minutes.
- SyncMeta placement: designed as a new single-row SwiftData model; confirm no objection to one more @Model in the schema (lightweight migration expected; destroy-and-recreate fallback acceptable since the store is a cache).