# Versions

Which Cassetto is which, and where the safe copies are. The app shows its version in Settings
(the foot of the left column) and in Project › About. A test build also says **Test** next to the
name in the top bar and "(test)" in the window title.

| Version | State | What it is |
|---|---|---|
| **0.1** | committed (`d89c8de`, `main`, on GitHub) | The suite with Plastico and Puzzle Charts, themes, `.cassetto` export. |
| **0.1 + keyboard shortcuts** | not committed | Settings window (Ctrl+,) with changeable shortcuts and the appearance pane. Backed up, see below. |
| **0.2 test, first try** (`0.2.0.dev1`) | not committed, backed up | Add scene follows the act on screen; scene names can be hidden and sit under the pictures without overlapping; pictures of scenes inside scenes lie on their own blocks; module tabs centred; Plastico and Puzzle Charts share one view of which charts, steps, people and items belong to each scene; people added from a step are put where the step has them. |
| **0.2 test, second try** (`0.2.0.dev2`) | not committed, backed up | Puzzle Charts' Where and Who are pick lists drawn by the page (the app window didn't show the browser's own): the chart's act's scenes first, the people in the step's scene at its time first, new ones added to the world. A chart's act is one of Plastico's acts, named. Both modules check that a step's person is in its scene then, and offer to put them there. A chart shows its scenes and people and highlights their steps; Plastico's act lists its charts and its scenes with no puzzle step. |
| **0.2 test, third try** (`0.2.0.dev3`) | not committed, backed up | "Not there then" says where the world has the person at that time instead, and fixes it either way in one click: move the step there, or put the person in the step's scene. Plastico's check opens the step in Puzzle Charts. A step with no time whose person is in its scene only at some times says so. |
| **0.2 test, fourth try** (`0.2.0.dev4`) | not committed, backed up | One act on screen for the whole suite. An act picked in Plastico opens that act's chart in Puzzle Charts, or a fresh one (saved with its first change) when it has none; New chart makes it in that act; opening a chart moves Plastico to its act (unless it shows every act). Puzzle Charts lists every act of the world, each with its charts or a "New chart for act N"; the project tree puts every chart under its act. |
| **0.2 test, fifth try** (`0.2.0.dev5`) | not committed, backed up | Plastico's Pictures mode seen from above (Map view, or the camera turned to look down): the indoor rooms' pictures lie flat on their blocks like the outdoor ones; tilted again, they stand back up. |
| **0.2 test** (`0.2.0.dev6`) | not committed, being tried | New project › A Godot game lists the games found in `~/Desktop/Projects` (and one folder down) to pick from, and names the project after the game; "Another folder…" still takes any path. |

Nothing in 0.2 test changes the project files' format: a project used with it still opens in 0.1.

## Safe copies

In `~/Desktop/Projects/archive/cassetto-backups/` (listed in `../archive/README.md`):

- `2026-11-27_v0.1_before-0.2-test/`
  - `app/`: this folder as it was before 0.2 test (0.1 + keyboard shortcuts, uncommitted work included, with its `.git`).
  - `projects/the-going-boat/`: the project `~/Cassetto/the-going-boat` at that moment.
- `2026-11-27_v0.2-test-dev1_before-dev2/`
  - `app/`: 0.2 test as it was before dev2 (0.2.0.dev1, uncommitted).
  - `projects/the-going-boat/`: the project after you added the stationmaster and the stranger.
- `2026-11-27_v0.2-test-dev2_before-dev3/`
  - `app/`: 0.2 test as it was before dev3 (0.2.0.dev2, uncommitted).
  - `projects/the-going-boat/`: the project with "Ask Cucio about the man" moved to Condominiums' courtyard.
- `2026-11-27_v0.2-test-dev3_before-dev4/`
  - `app/`: 0.2 test as it was before dev4 (0.2.0.dev3, uncommitted).
  - `projects/the-going-boat/`: the project with the "Untitled chart" you made at 13:27 (in act 1).
- `2026-11-27_v0.2-test-dev4_before-dev5/`
  - `app/`: 0.2 test as it was before dev5 (0.2.0.dev4, uncommitted).
  - `projects/the-going-boat/`: the project as it was then (one chart left: Act 1 (reworked)).
- `2026-11-27_v0.2-test-dev5_before-dev6/`
  - `app/`: 0.2 test as it was before dev6 (0.2.0.dev5, uncommitted).
  - `projects/the-going-boat/`: the project as it was then.

**To go back:** quit Cassetto, then either run the old copy in place
(`cd …/app && uv run cassetto`) or copy `app/` over this folder (keep `.venv` out of it; `uv`
rebuilds it). To restore the project, copy `projects/the-going-boat/` back to `~/Cassetto/`.

## When a test version is good

It gets committed and pushed to GitHub only when the user says so; then its line above moves to
"committed" with the commit id.
