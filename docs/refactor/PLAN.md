# CUE iOS Refactor — Master Plan

## Goal
A refactored, nicely-working Cue iOS app rebuilt against the new **"CUE — Clean"**
design (FE `cue-ios` SwiftUI + BE `cue-api` NestJS), all on `master`. Every line of
code reviewed multiple times from different perspectives before "done".

## Scope reality (post-research)
The app is **~85% already built** and well-architected. The refactor is:
1. **Theme migration** Kraft & Ink → Clean (token-file revaluation; cascades app-wide).
2. **New shared components** (CueField, CueBadge, CueToggle, RootsCommitView, …).
3. **A few net-new screens** (Assistant Persona editor, Search, standalone Account, Dashboard/Report).
4. **A BE backlog** (see BE_BACKLOG.md) — mostly tied to new design features.
Most existing screens (15/18) are `complete` and reskin via tokens, not rebuild.

## Sequencing (the anti-conflict spine)
```
Phase 0  Git setup: master ← integration (FF), become working line. Worktrees off master.
Phase 3  FOUNDATION (single line, merged FIRST): tokens + reskin existing DS comps
         + build all §2 NEW shared comps + UIKit CalendarTheme/cells. NO parallel
         worktrees here (everything touches Theme/Depth/Radius/Typography).
            └─ reviewed (3 rounds) → merge to master. NOW master is fully reskinned.
Phase 4  FEATURE WORKSTREAMS (parallel worktrees off reskinned master, disjoint files):
            each = team {FE dev, BE dev, reviewer, manager}; build/verify; 3 rounds
            review+fix; merge to master.
Phase 5  WHOLE-APP REVIEW: 7 lenses (bugs, inconsistencies, architecture, performance,
            security, UI/UX smoothness, design-fidelity) → issue list → dev agents fix.
```
**Why foundation-first:** every page reskins off the token files. If page teams ran in
parallel while tokens change, they'd all conflict on `Theme.swift` — the exact
"same component defined twice / merge hell" the brief warns against.

## Phase 4 workstreams (disjoint file sets → safe parallel worktrees)
| WS | Screens | Primary files | BE backlog |
|---|---|---|---|
| **A · Calendar** | Today(day-list), Calendar Day/Month/Year/Zoom, MiniMonth | Features/Calendar/** (UIKit) | M2 |
| **B · Events** | Create / Detail / Edit Event, Recurrence | Features/Calendar/{NewEvent,TaskDetail,Recurrence} | S1,S3,S4,D4,D5,D6 |
| **C · Groups** | Groups, Group Edit | Features/Groups/** | M5,D7 |
| **D · Settings+Account** | Settings, Account | Features/Settings/SettingsView + new Account | M4,S5,S6 |
| **E · Assistant Persona** | Assistant Persona editor | new Features/Assistant/** | D9 |
| **F · Notifications+Report** | Notifications & Report, Dashboard | new Features/Reports/** | S2,S7,D1,D2 |
| **G · Search** | Search | new Features/Search/** | M1 |
| **H · Onboarding** | Onboarding, Auth/splash | Features/Auth/** | S2,D8 |
| **I · Telegram** | Telegram Connect | Features/Settings/Telegram/** | M3 |
*(A,B share nothing; D/E/F/H/I all live under Settings/Auth but in disjoint subfolders.
Sequence D before E/F/I if they touch SettingsView's row stack; else parallel.)*

## Per-workstream team protocol (Phase 4)
1. **Manager** seeds the worktree, hands the FE dev + BE dev their slice (from the
   page spec + registry + BE_BACKLOG), enforces "consume registry, never redefine".
2. **BE dev** ships needed endpoints first (so FE has a contract) + OpenAPI + migration + tests.
3. **FE dev** builds/reskins screens consuming §1/§2 components; `xcodebuild` green.
4. **Reviewer** audits (correctness, design-fidelity, reuse, conventions) → findings to manager.
5. Manager routes findings back to dev → fix. **Repeat 3 rounds** (or until reviewer clean).
6. Manager merges worktree → master (rebuild green post-merge).

## Review rounds (each workstream): ≥3
R1 correctness+build · R2 design-fidelity+reuse(no dup components)+conventions · R3 integration (merged with siblings, regressions).

## Acceptance criteria
- Kraft→Clean migration complete; `xcodebuild` green; no Kraft hex/Fraunces/letterpress left.
- All in-scope screens implemented/reskinned + their BE backlog items shipped (with OpenAPI/migration/tests).
- Component registry honored: no component defined twice.
- Phase 5 multi-lens review run; all P0/P1 findings fixed; code reviewed ≥3×.

## Git strategy
- cue-ios: FF `master`←`integration`; work on `master`; per-WS worktrees under
  `cue-worktrees/refactor-<ws>` branched off master; merge back to master.
- cue-api: already on `master`; BE work per-WS on branches off master (lighter; can
  share the cue-api master or per-WS branches). **No auto-commit** — leave merged
  work staged for the user per their standing rule. (Confirm commit policy.)
- Xcode synchronized groups → new Swift files auto-register; no project.pbxproj
  conflicts on merge (clean worktree merges).

## Risks / landmines
- 18 parallel xcodebuilds = resource storm → cap Phase-4 concurrency (~3-4 builds).
- UIKit CalendarTheme cells = the only real per-cell visual work (hand-built shadows).
- WaxSeal identity change (→ RootsCommit + OliveCheck) touches every completion site.
- BE recurrence-engine change (S3 bySetPos) is the riskiest BE item — needs tests.
- "No self-commit" user rule → I build + leave unstaged; user commits.
