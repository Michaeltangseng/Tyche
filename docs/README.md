# Tyche room architecture

These notes describe the current room model: principles, sessions, tasks, decisions, and UI direction. The core loop is already running in `desktop/src/room/` and `RoomWorkspace`. The short code map is [architecture.md](../architecture.md) at the repository root.

The notes describe how Tyche collaborates now. Earlier option comparisons and migration phases remain in the individual documents as design history. They are not an open implementation plan.

## Index

- [01 Principles, scope, and constraints](01-principles-and-scope.md)
- [02 Target architecture](02-target-architecture.md)
- [03 Sessions, briefing, and wake-up](03-conversation-session-and-briefing.md)
- [04 Tasks, Captain, and Report](04-task-captain-and-report.md)
- [05 eta reuse map](05-eta-reuse-map.md)
- [06 Rewrite and migration record](06-rewrite-and-migration.md)
- [07 Architecture decisions](07-decisions.md)
- [08 Open questions](08-open-questions.md)
- [09 UI direction and information architecture](09-ui-direction.md)
- [10 Skill management design (proposed)](10-skill-management.md)
- [11 Skill implementation handoff](11-skill-implementation-handoff.md)
- [12 Skill review response: information model and native isolation](12-skill-review-response.md)
- [13 Skill catalog: current implementation](13-skill-catalog.md)
- [14 Usage and cost](14-usage-and-cost.md)

## While reading

- The product name is Tyche. `TYCHE_TOOL`, `TYCHE_REPORT`, and `tyche-private` are protocol names and directory names that still exist in code.
- The room runtime launches any provider in OAR's default runtime registry. Providers without a launcher cannot speak in a chat.
- The user-facing model is Room, Chat, role, Captain, task, report, Attention, and artifact. Checkpoint, gate, seat, and round are not part of that model.
