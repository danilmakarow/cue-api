# Contract: REST exposure for recurring tasks, groups & task editing (iOS app)

- **Status**: Draft (implementation in progress)
- **Last updated**: 2026-06-03
- **Audience**: the BE dev agent (cue-api) and the FE dev agent (cue-ios). This is the **single source of truth** both implement against, in parallel. Implement to THIS contract exactly so the two halves meet.

## Why this exists

The service layer for recurrence + groups already exists in `cue-api` (the `TaskService` / `TaskGroupService` / `RecurrenceRuleService` methods, the occurrence expansion engine, the `Occurrence` type, and the recurrence/group DTOs — all built for the Telegram assistant, see [recurrence-expansion.md](recurrence-expansion.md)). What does NOT exist:

1. **REST endpoints** exposing those capabilities to the iOS app (the `TaskController` has only POST/GET/PATCH-complete; there is no `TaskGroupController`).
2. **Group-level recurrence inheritance** — a group cannot yet carry a default recurrence that its tasks inherit.
3. **Any iOS UI** for recurrence, groups, or task detail/edit/delete.

This contract closes exactly those three gaps. **Do not rewrite the existing engine or service methods** — call them.

## The three user-facing capabilities

1. **Recurring tasks** — create/manage a recurrence rule on a task in the iOS app; recurring tasks render on every occurrence date in the calendar (BE already expands).
2. **Task groups** — create a group, add tasks to it (via `task.groupId`), and set a recurrence on the group that **applies to every task in it by inheritance**: a task's effective rule = `task.recurrenceRule ?? task.group.defaultRecurrenceRule`.
3. **Update / delete tasks** — tap a task → full detail → edit any field or delete.

---

## Part A — BE work (cue-api)

### A0. Guardrails (read first)
- **Additive only.** The working tree has a large uncommitted assistant feature. Do NOT change the public signatures of existing `TaskService` / `TaskGroupService` / `RecurrenceRuleService` methods — the assistant's `tool-dispatcher`, `schedule-reader`, and `command-handler` depend on them. ADD controllers, DTOs, one entity column, one migration, and the inheritance resolution.
- **Do NOT** touch `src/modules/assistant/**`, `src/modules/ai/**`, `src/modules/stt/**`, `src/modules/external-vendor/**`. Do not run any `git` mutation (no commit/stash/checkout/reset). Do not edit existing migrations.
- Follow `cue-api/CLAUDE.md`: 3-layer data access (`Entity → Repository → DatabaseService → FeatureService → Controller`), `.save()`/`createInstance` only, kebab-case files, arrow functions + JSDoc, no `any`, class member ordering, `class-validator` DTOs, `ValidationPipe whitelist`. Match `calendar.controller.ts` for controller/DTO style.
- After each milestone run `pnpm run type && pnpm run lint && pnpm run test`. A baseline tsc result is in `/tmp/cue-api-baseline-type.txt` — only NEW errors are yours.

### A1. Group-recurrence inheritance (the one schema change)
1. **Entity**: add to `TaskGroup` (`src/modules/database/entities/task-group.entity.ts`), mirroring the existing `defaultNotificationStrategy` pattern exactly:
   ```ts
   @Column({ type: 'uuid', nullable: true })
   defaultRecurrenceRuleId: string | null;

   @ManyToOne(() => RecurrenceRule, { onDelete: 'SET NULL' })
   @JoinColumn({ name: 'defaultRecurrenceRuleId' })
   defaultRecurrenceRule: RecurrenceRule | null;
   ```
2. **Migration**: new hand-written raw-SQL file `src/migrations/<unixMs>-add-group-default-recurrence.ts` (use a timestamp greater than `1780700000000`). `ALTER TABLE "task_group" ADD COLUMN "defaultRecurrenceRuleId" uuid NULL` + FK to `recurrence_rule(id)` `ON DELETE SET NULL`; `down()` drops them. Do NOT edit existing migrations.
3. **Expansion resolution (the core of inheritance)** — in `TaskService`'s recurring-occurrence read path (`readRecurringOccurrences` + `findClashingRecurringAnchors`):
   - The candidate set must now include tasks that are recurring **either** via their own `recurrenceRuleId` **or** via a group default (`group.defaultRecurrenceRuleId IS NOT NULL` while the task's own `recurrenceRuleId IS NULL`).
   - For each candidate, resolve the **effective rule** = `task.recurrenceRule ?? task.group.defaultRecurrenceRule`, load it, and pass it to `RecurrenceRuleService.expandOccurrences(anchor, effectiveRule, from, to)`. Load the `group.defaultRecurrenceRule` relation as needed.
   - `Occurrence.isRecurring` stays true for inherited recurrence. Per-occurrence exceptions still key on `(task.id, originalStart)`.
   - Keep it efficient (one candidate query scoped by calendar; reuse the existing partial-index migration `1780700000000-add-recurring-task-index.ts` and add an analogous consideration for the group path — a second scoped query is fine).
   - **Unit-test** the inheritance path: a task with no own rule but a group default expands on the group's schedule; a task's own rule overrides the group default; changing the group default changes expansion.
4. **Group service**: add an `update(userId, groupId, changes)` method (color/icon/name/sortOrder/`recurrence`) and accept `recurrence` on `create`. When `recurrence` (a `CreateRecurrenceRuleDto`) is provided, create a `RecurrenceRule` via `RecurrenceRuleService.create(...)` and set `defaultRecurrenceRuleId`; when `recurrence: null` on update, clear it. Keep the existing `rename`/`remove`/`findAll*` intact.

### A2. Task REST endpoints (`TaskController`, `src/modules/task/task.controller.ts`)
Keep `@UseGuards(AccessTokenGuard)` + `@CurrentUser()`. Add DTOs under `src/modules/task/dtos/`.

| Method & path | Body / query | Service call | Returns |
|---|---|---|---|
| `GET /tasks` | query `calendarId`(uuid), `from`(ISO), `to`(ISO), `includeCompleted?`(bool), `includeTodos?`(bool) | `findOccurrencesInRange(user.id, from, to, { calendarId, includeCompleted, includeTodos })` | `OccurrenceDTO[]` (map from `Occurrence` — see schema). **This replaces the current raw-row GET.** |
| `GET /tasks/:id` | — | `findByIdWithRule(user.id, id)` | `TaskDTO` (series, with embedded `recurrence`) |
| `POST /tasks` | `CreateTaskDto` (already supports `recurrence` + `groupId`) | `create(user.id, dto)` | `TaskDTO` |
| `PATCH /tasks/:id` | `UpdateTaskDto` (new — all fields optional: `title`, `notes`, `startAt`, `endAt`, `isAllDay`, `requiresCompletion`, `groupId`, `recurrence`) | `update(user.id, id, input)` | `TaskDTO` |
| `DELETE /tasks/:id` | — | `remove(user.id, id)` then reload | `{ "id": string }` (200; do NOT 204 — the iOS client decodes a JSON body) |
| `PATCH /tasks/:id/completion` | `SetCompletionDto { isCompleted: bool, occurrenceStart?: ISO }` | if `occurrenceStart` → `setOccurrenceCompleted(user.id, id, new Date(occurrenceStart), isCompleted)`; else `setCompleted(id, isCompleted)` (guard ownership via `findById` first) | `CompletionResultDTO { taskId, occurrenceStart: string\|null, completedAt: string\|null }` |
| `POST /tasks/:id/skip` | `{ occurrenceStart: ISO }` | `applyOccurrenceOverride(user.id, id, new Date(occurrenceStart), { isSkipped: true })` | `{ "ok": true }` |

> Note the completion endpoint **moves** from `PATCH /tasks/:id` to `PATCH /tasks/:id/completion`, because `PATCH /tasks/:id` is now the details-update route. Update `set-task-completed.dto.ts` → `SetCompletionDto` with the optional `occurrenceStart`.

Map `Occurrence` → `OccurrenceDTO` with a small pure mapper (don't serialize the whole `task` entity; pick fields). `originalStart`/`occurrenceStart`/`occurrenceEnd`/`completedAt` are ISO strings or null.

### A3. Task-group REST endpoints (new `TaskGroupController`)
Create `src/modules/task-group/task-group.controller.ts`, add to `task-group.module.ts` (`controllers: [TaskGroupController]`), guard with `AccessTokenGuard`.

| Method & path | Body / query | Service call | Returns |
|---|---|---|---|
| `POST /task-groups` | `CreateTaskGroupDto` (+ optional `recurrence: CreateRecurrenceRuleDto`) | `create(user.id, dto)` | `TaskGroupDTO` |
| `GET /task-groups` | query `calendarId?`(uuid) | `findAllByCalendar` when `calendarId` given, else `findAllForUser` | `TaskGroupDTO[]` |
| `PATCH /task-groups/:id` | `UpdateTaskGroupDto { name?, color?, icon?, sortOrder?, recurrence?: CreateRecurrenceRuleDto\|null }` | `update(user.id, id, changes)` | `TaskGroupDTO` |
| `DELETE /task-groups/:id` | — | `remove(user.id, id)` | `{ "id": string }` |

Adding tasks to a group is done by setting `groupId` via `POST /tasks` or `PATCH /tasks/:id` — no separate endpoint needed.

### A4. OpenAPI
Update `docs/api/openapi.yaml`: add a `tasks` and `task-groups` tag, all paths above, and component schemas (`Occurrence`/`OccurrenceDTO`, `Task`, `RecurrenceRule`, `RecurrenceRuleInput`, `TaskGroup`, and the request bodies). This is the FE's reference; keep field names identical to Part C.

---

## Part C — Shared wire DTOs (BE returns these; FE decodes these — names are normative)

```jsonc
// RecurrenceRule (response) — embedded in TaskDTO.recurrence and TaskGroupDTO.recurrence
RecurrenceRuleDTO {
  id: string,
  frequency: "DAILY"|"WEEKLY"|"MONTHLY"|"YEARLY",
  interval: number,                 // >= 1
  byWeekday: number[] | null,       // 0=Mon .. 6=Sun
  byMonthDay: number[] | null,      // 1..31
  byMonth: number[] | null,         // 1..12
  endType: "NEVER"|"UNTIL_DATE"|"COUNT",
  endDate: string | null,           // "YYYY-MM-DD"
  count: number | null
}

// RecurrenceRuleInput (request) — sent inside create/update task & group bodies.
// Same as above minus `id`. Cross-field: COUNT⇒count set, UNTIL_DATE⇒endDate set.
// (BE: this is the existing CreateRecurrenceRuleDto.)

// TaskDTO (series row) — POST /tasks, PATCH /tasks/:id, GET /tasks/:id
TaskDTO {
  id: string, calendarId: string, groupId: string | null,
  title: string, notes: string | null,
  startAt: string | null, endAt: string | null,   // ISO
  isAllDay: boolean, timezone: string,
  requiresCompletion: boolean, completedAt: string | null,  // ISO
  recurrenceRuleId: string | null,
  recurrence: RecurrenceRuleDTO | null,            // embedded full rule for editing
  notificationStrategyId: string | null,
  createdAt: string, updatedAt: string             // ISO
}

// OccurrenceDTO — GET /tasks (the expanded calendar read). One per visible instance.
OccurrenceDTO {
  taskId: string,                  // series/anchor id (== TaskDTO.id)
  calendarId: string,
  groupId: string | null,
  originalStart: string | null,    // ISO; stable instance key WITH taskId
  occurrenceStart: string | null,  // ISO; effective start (override applied)
  occurrenceEnd: string | null,    // ISO; effective end
  title: string, notes: string | null,
  isAllDay: boolean, timezone: string,
  requiresCompletion: boolean,
  completedAt: string | null,      // per-instance
  isRecurring: boolean, isException: boolean
}

// TaskGroupDTO — task-group endpoints
TaskGroupDTO {
  id: string, calendarId: string, name: string,
  color: string | null, icon: string | null, sortOrder: number,
  defaultRecurrenceRuleId: string | null,
  recurrence: RecurrenceRuleDTO | null,            // embedded group default rule
  defaultNotificationStrategyId: string | null,
  createdAt: string, updatedAt: string
}

// CompletionResultDTO — PATCH /tasks/:id/completion
CompletionResultDTO { taskId: string, occurrenceStart: string | null, completedAt: string | null }
```

**Occurrence identity (critical for FE):** a single calendar cell is identified by `(taskId, occurrenceStart)`. Per-instance complete/skip sends `taskId` + `occurrenceStart`. Editing/deleting the series uses `taskId` and acts on the whole series (v1 does not expose this-occurrence detail edits beyond skip).

---

## Part B — FE work (cue-ios)

### B0. Guardrails
- Follow `cue-ios/CLAUDE.md`: SwiftUI only, iOS 26, `@Observable` (never `ObservableObject`), SwiftData `@Model` + `@Query`, `async/await`, no force-unwrap in prod paths, no UIKit/Combine, no manual blur on system chrome. Reuse `APIClient` (`get/post/patch/delete` already exist). Files auto-register (synchronized groups) — just create them under `cue/`.
- Additive; don't disturb the existing Telegram/DeepLink WIP in the working tree. No `git` mutations.
- After each milestone build: `xcodebuild -project cue.xcodeproj -scheme cue -destination 'generic/platform=iOS Simulator' -configuration Debug -derivedDataPath /tmp/cue-dd-feat build 2>&1 | grep -iE '(error|warning):'` — clean = no `error:`.

### B1. Wire DTOs (`cue/Networking/APIModels.swift`)
Add `RecurrenceFrequency`/`RecurrenceEndType` (`String, Codable`) enums; `RecurrenceRuleDTO`; `RecurrenceRuleInput`; `OccurrenceDTO`; `TaskGroupDTO`; request bodies: extend `CreateTaskRequest` with `groupId: String?` + `recurrence: RecurrenceRuleInput?`; new `UpdateTaskRequest` (all optional), `CreateTaskGroupRequest`, `UpdateTaskGroupRequest`; change the completion request to `SetCompletionRequest { isCompleted: Bool, occurrenceStart: Date? }`. Extend `TaskDTO` with `groupId` + `recurrence`. Match Part C names exactly. `originalStart`/`occurrenceStart` are `Date?` (the shared decoder is `.iso8601`).

### B2. SwiftData models (`cue/Models/`)
- **Occurrence identity**: today `TaskItem` is keyed unique by `id`. A recurring task expands to many cells sharing one `taskId`, which collides. Rework so the persisted unit is the **occurrence**: add `seriesId: String` (the task id) + `occurrenceStart: Date?`, and make the unique key a composite `occurrenceKey = "\(seriesId)#\(occurrenceStart ISO)"`. Add `groupId: String?`, `isRecurring: Bool`. Keep `isCompleted`/display fields. Update `TaskItem+Mapping` to `upsert(from: OccurrenceDTO)` keyed on `occurrenceKey`, and add a separate path/model for the editable **series** (from `TaskDTO`/`GET /tasks/:id`) used by the detail/edit screen.
- Add `EventTaskGroup` `@Model` mirroring `TaskGroupDTO` (+ `upsert(from:)`), following `EventCalendar`.
- Thread `seriesId` + `occurrenceStart` into `ScheduleEvent` so day views can open the right series and toggle the right instance.

### B3. UI
- **RecurrenceEditor** (`cue/Features/Calendar/Recurrence/RecurrenceEditor.swift`) — a reusable SwiftUI editor binding to a `RecurrenceRuleInput?`: Repeat off/Daily/Weekly/Monthly/Yearly, interval stepper ("every N"), weekday multi-select (when Weekly), End = Never / On date / After N. Produce a human summary ("Every 2 weeks on Mon, Wed"). Reused by NewEvent, TaskDetail edit, and Group editor.
- **NewEventScreen** — add a "Repeat" row (→ RecurrenceEditor) and a "Group" picker (loads `GET /task-groups`); include `recurrence` + `groupId` in `CreateTaskRequest`.
- **TaskDetailScreen** (`cue/Features/Calendar/TaskDetail/`) — tapping a day card pushes this: shows full info (title, notes, time, all-day, requires-completion, recurrence summary, group). **Edit** (reuse the same form as NewEvent, or a shared `TaskEditor`) → `PATCH /tasks/:id` (`UpdateTaskRequest`). **Delete** → confirm → `DELETE /tasks/:id`. For a recurring instance, also offer **Skip this occurrence** → `POST /tasks/:id/skip`.
- **Tap-to-open**: `DayScheduleView` / `ListDayPage` event cards get an `onSelect(ScheduleEvent)` callback; `CalendarRootView` pushes `TaskDetailScreen` via its `NavigationStack` (value-based route). The completion checkbox stays separate (doesn't trigger open).
- **Groups management** (`cue/Features/Groups/`) — a screen reachable from `SettingsView` (add a row): list groups, create/edit (name, color, icon, **recurrence** via RecurrenceEditor) → `POST`/`PATCH /task-groups`, delete. Surface that a group recurrence applies to its tasks.

### B4. Store / sync (`cue/Features/Calendar/CalendarStore.swift`)
- `ensureMonthSynced` now decodes `OccurrenceDTO[]` and upserts occurrence rows (composite key). On a month resync, occurrences for that window should be reconciled (stale occurrences pruned) so edits/deletes/skips reflect.
- `toggleCompletion` sends `SetCompletionRequest` to `PATCH /tasks/:id/completion` with `occurrenceStart` from the tapped occurrence; optimistic + revert on failure (keep current pattern).
- After edit/delete/skip, invalidate the affected month(s) cache and re-sync so the calendar reflects the change.

### B5. Localization
Add new user-facing strings to `cue/Resources/Localizable.xcstrings` (en + uk) — repeat labels, end-type labels, weekday names, detail/edit/delete/skip actions, group screen. Match the existing key style (`newEvent.*`, `calendar.*`). Don't sweep unrelated catalog churn into the change.

---

## Acceptance (what "done" means)
- iOS: create a task with a weekly recurrence → it appears on every matching day. Tap it → see full detail → edit title/time/notes/recurrence → persists. Delete → gone. Check off one occurrence → only that day completes.
- iOS: create a group, give it a recurrence, add a task (no own rule) to it → the task recurs on the group's schedule. Give the task its own rule → it overrides.
- BE: `pnpm run type && pnpm run lint && pnpm run test` green (incl. existing assistant specs — nothing broken); new endpoints covered by controller/e2e or service tests; OpenAPI updated.
- FE: `xcodebuild ... build` clean (no `error:`).
</content>
