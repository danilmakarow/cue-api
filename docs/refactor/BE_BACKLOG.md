# CUE Refactor — Backend Backlog (cue-api)

Derived from per-page apiNeeds + verified against the REAL route table
(~33 routes / 11 controllers / 21 entities). The empty-catalog caveats the page
researchers raised ("only /health was provided") are FALSE ALARMS — the
tasks/calendars/groups/recurrence/daily-counts/changes endpoints all exist.

Existing surface (confirmed present): auth (apple, me, dev), calendars (GET/POST),
tasks (list, :id, daily-counts, changes, create, patch, delete, completion, skip),
task-groups (CRUD), users/me/settings, report-settings, persona-settings,
assistant/link (GET/POST/DELETE), assistant/telegram/webhook.

Legend: **MUST** = blocks a redesigned screen's core function · **SHOULD** = new
design feature, tractable · **DEFER** = large/cost-bearing/product-gated.

---

## MUST (ship with the screen)

| # | Item | Endpoint / change | Module | Screen |
|---|---|---|---|---|
| M1 | **Task text search** | `GET /tasks/search?q=&groupId=&limit=` (ILIKE title+notes across user's tasks, not window-bound) — OR client-only over local store for v1 (windowed → incomplete). Recommend server. | task | Search; Calendar nav search |
| M2 | **Group color on occurrence** | Ensure `OccurrenceDTO` carries owning group id + colorHex so day rails / month dots / chips use real group colors (design hardcodes 6 earth tones). Add if absent. | task/calendar | Calendar Day/Month |
| M3 | **Typed Telegram link error** | `POST /assistant/link` returns a stable error code for invalid/expired/burned nonce so FE branches bad_code vs transient. | assistant | Telegram Connect |
| M4 | **displayName edit** | Extend `PATCH /users/me/settings` (UpdateUserSettingsDto) to accept `displayName` (trimmed, bounded). Today write-once at POST /auth/apple. Return displayName in UserSettingsDTO. | user | Account |
| M5 | **iOS DTO: requiresCompletion** *(FE-side)* | BE supports it; iOS `TaskGroupDTO`/Create/Update + `EventTaskGroup` model drop it. Wire through. (No BE change.) | (FE) | Groups/Group Edit |

## SHOULD (build this round if scope allows)

| # | Item | Endpoint / change | Module | Screen |
|---|---|---|---|---|
| S1 | **Per-task reminders REST** | NotificationRule/Strategy have entities+services but NO controller. Accept `reminders[]` ({offsetMinutes, channel: PUSH\|TELEGRAM}) on POST/PATCH /tasks, OR add `/tasks/:id/notifications` CRUD. | notification-rule | Create/Edit Event |
| S2 | **Push device registration** | `POST /users/me/devices` ({token, platform}) + DELETE; device service/entity exist, no controller. (Delivery pipeline separate — see D1.) | device | Onboarding, Notifications |
| S3 | **Advanced monthly recurrence** | Add `bySetPos` (nth-weekday, "first Monday") + workday-anchor to RecurrenceConfig DTO + entity + **expansion engine**. | recurrence-rule | Create/Edit Event, Group Edit |
| S4 | **Per-task icon** | Add `icon` column + migration to Task entity (Calendar/TaskGroup already have it) + DTO field. | task | Create/Edit Event |
| S5 | **Account deletion** | `DELETE /users/me` — cascade-purge user aggregate + **Apple refresh-token revocation** (App Store policy for Sign in with Apple). | user/auth | Account |
| S6 | **Avatar update** | `PATCH /users/me/settings` accepts `avatarBase64` (size/format validated), or `PUT /users/me/avatar`. | user | Account |
| S7 | **Report channel field** | Add `channel` enum to UserReportSettings + DTOs + migration. NOTE push delivery doesn't exist (Telegram-only) → either cut the Push control v1 or accept it won't deliver until D1. | report | Notifications & Report |

## DEFER (large / cost-bearing / product-gated — flag + stub behind feature flag)

| # | Item | Why deferred |
|---|---|---|
| D1 | **Full push DELIVERY pipeline** (ScheduledNotification worker + APNs client) | Schema-only today; substantial async infra build. S2 registration + S7 channel are the visible asks; actual push delivery is a separate project. |
| D2 | **Morning-brief endpoint** (`GET /users/me/daily-brief`) | ReportGeneratorService exists (scheduler-only); per-open MAIN-model call is a cost concern — needs per-day caching. Today brief card is a NEW design element. |
| D3 | **"Plan my day" / in-app assistant REST turn** | Assistant is Telegram-webhook driven; no REST conversation entry. New surface. |
| D4 | **Natural-language quick-create parse** (`POST /tasks/parse`) | New NLP endpoint over assistant pipeline; the quick-create well is a new element. |
| D5 | **AI context tile content + dismiss** (Event Detail/Today "Cue" tile) | Needs a content source + per-entry suppression; new. |
| D6 | **Per-occurrence field override** (edit one instance's title/notes) | TaskOccurrenceException models skip+time-override only; "this occurrence" currently = skip. New override semantics. |
| D7 | **Group bulk reorder** (`PATCH /task-groups/reorder`) | Drag-reorder not in as-built screen; N sequential PATCHes are racy. Only if reorder ships. |
| D8 | **Onboarding-completed server persistence + notif prefs** | Recommend iOS-local @AppStorage for completion; server fields (morningBriefEnabled/eveningRecapEnabled) only if cross-device needed. |
| D9 | **Multi-preset persona + revert-to-preset** | Only one Jarvis preset seeded; no list-presets / no DELETE to clear custom. v1 = single editable field. |

---

## Notes
- Default-calendar guarantee on signup (`POST /auth/apple` auto-create) is a
  documented cue-api TODO — confirm; the FE's `CalendarStore` already selects a
  calendar. Affects Today/Calendar/Onboarding empty states.
- Every BE change follows cue-api convention: update `docs/api/openapi.yaml` +
  a `docs/specs/` entry in the same change; add migration under `src/migrations`.
- No auth-guard gap: the Calendar Zoom researcher's "no auth guard exists" claim
  is a FALSE ALARM from the empty catalog — `/auth/apple` + JWT + guards exist.
