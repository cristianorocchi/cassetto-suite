# Plastico

A 3D model of a game's world, for planning and studying its structure: every scene is a block on
its floor, every way between two scenes a path. It reads a Godot project directly and can build
the changes you plan back into it.

In Cassetto it is one of the modules. On its own, start it with `./open-app.sh` or `uv run plastico app`.
It opens in its own window at http://127.0.0.1:8766/. Closing the terminal window stops it.

## What you see

- **Skeleton / Pictures.** Skeleton shows the structure only. Pictures lays each outdoor scene's
  picture on its plate and stands each indoor scene's picture on the back edge of its room, using the
  game's own art for the state on screen (a phase of the game). A scene with scenes inside it, and a scene inside another,
  lays its picture flat on its own block, so the pictures of a group never cover each other. Seen from
  above (Map view, or the camera turned to look nearly straight down), every picture lies flat on its
  block, the indoor rooms' too; tilted again, those stand back up. Pictures
  keep their proportions (cropped to fit, never stretched). Scenes not in the game yet can get a
  sketch: drop it on the scene's panel.
- **Names.** Each scene's name sits under its picture. Where names would cover a picture, a badge or
  each other, the less important one shrinks to its name only, then to a dot that opens on hover.
  The **Names** button turns them off (a dot per scene; the selected scene keeps its name).
- **Blocks.** Flat plates are outside scenes (third person), boxes are inside scenes (first person),
  small boxes are close-ups. A solid outline means the scene is in the game. Dashed means planned
  (an idea, or ready to build). Red means it is marked to delete. Floors stack: a scene on floor 1
  floats above street level, one on −1 sits below it, with a post down to its footprint.
- **Ways.** A solid line is in the game and a dashed one is planned. An arrow marks a one-way path.
  A badge shows a lock (the item or flag it needs) or a way that is only open in some states.
  A grey "?" stub is an exit in the game that leads nowhere yet.
- **States.** Groups of states say what changes over time: Weather (sun, rain), Story (before and after
  the fallout), Time of day... One state of each group is on at a time, and a group can hold for several
  acts (it rains on both). The view bar shows the groups of the act on screen (keys 1–9); picking a state
  switches who is where, which scenes and ways are open, and which puzzle charts are active. A Godot
  game's phases are a group of every act, and switch the pictures too.
- **Acts and areas** (left panel). An act can be shown on its own. Areas colour the blocks.
- **Labels** shrink to the name only, or to a dot, when they would cover a more important one.
  Hover a dot to read it.

## Editing

- **Add a scene:** press **Add scene** (N) or double-click the ground. The dialog asks where it goes,
  in an act or **inside another scene**, and shows the full place ("Act 1 › Lighthouse › Lamp room")
  before you confirm. A scene inside another sits just below it on the map, moves with it, follows
  its act, and is listed under it. **Inside** in the scene's panel changes it later.
- **Size and grid:** every block is a whole number of grid cells (Width × Depth in the panel; Kind
  sets the starting size). Its edges, not its centre, snap to the grid lines, so blocks sit side by
  side without gaps. A drop that would land on another block slides to the nearest free place.
  Shift places freely.
- **Puzzle charts of a scene:** the scene's panel lists the charts put with it. Open one, add any
  chart of the project, make a new one for the scene, or take one off (the chart itself stays).
  *Active in* says in which states a chart is active, group by group (the same in every scene it is in);
  one not active in the state on screen is struck through.
- **Move a scene:** drag it. Hold Shift for free placement instead of the half-unit grid. While you
  hold it, the wheel takes it up a floor (wheel away from you) or down one; with nothing held, the
  wheel zooms.
- **Join two scenes:** drag the dot on a scene's label onto another scene. Drop it on empty ground
  to make a new scene that is already joined.
- **Select** a scene or a way to edit it on the right: name, kind, act, area, floor, status, the
  states it is open in, people per state, locks, notes.
- **People:** under People here, + person adds someone in a state and × takes them out. Grey
  names come from the game: × on one only marks them as leaving in the plan (struck through, ↺ to
  keep them), and the checks list it as a change to make in Godot.
- **Delete:** Delete key, or the button on the panel. A scene that is in the game is only *marked*
  for deletion until you build.
- **Undo / redo:** Ctrl+Z, Ctrl+Shift+Z. Everything saves by itself.
- **Tidy up the layout** (⋯ menu) spreads overlapping scenes out and keeps floors.

## Studying

- **Checks** (right panel, nothing selected) list problems, worst first:
  - a scene that can't be reached from the start, or that has no way back;
  - dead ends;
  - a key that can only be found behind its own lock;
  - a lock nobody says where to open;
  - a scene that is never open while a way into it is;
  - a person in two places at once;
  - exits that lead nowhere;
  - hubs.
  Click a check to see the scenes it means.
- **Route** (R): click two scenes to see the shortest way between them. You can ask for the route
  with every lock closed, or with only what is open in the states on screen.
- **Play test** (P): walk the world as the player would. Lit scenes are the ones you can reach now.
  Toggle the keys you have (items and flags), and limit it to what is already in the game.

## The game and the plan

The model is a **plan**, saved in `worlds/<id>.json`. Linked to a Godot project, Plastico reads the
game every time it opens or regains focus (it never caches it). It reads the scenes in
`SceneRouter.SCENES`, their exit hotspots and spawn points, the passages made in code, and the
people in them. Scenes and ways in the game always appear in the plan by themselves.

The game changes only when you press **Godot → Build**. The dialog lists every difference, and
you tick what to build:

- **New scene:** a grey stand-in made from `core/interior_location.tscn` or
  `core/exterior_location.tscn`, with its own script, listed in the SceneRouter.
- **New way:** a stand-in exit hotspot (in the middle of an outdoor picture, at the bottom of an
  indoor one) and, outdoors, the spawn point it arrives at. Move it to its place in Godot.
- **Leading an open end** sets the target of the existing hotspot instead.
- **Removing a way:** remove its hotspot, or keep it leading nowhere.
- **Deleting a scene:** moves its folder to Plastico's backups, takes it out of the SceneRouter,
  removes the exits into it, and lists any lines of code that still name it.
- Passages made in code are listed but never edited: change those by hand, or with Claude.

Before writing, a build backs up every file it touches (`backups/<world>/<time>/`). **Undo the last
build** puts them back, and refuses if a file has changed since. Godot must be closed while you
build: it would write its own copy of the scenes over the changes. **Test the game** runs the
project's own `tests/smoke_test.tscn` headless and keeps the player's save slot. Expect it to fail
on new stand-in scenes, which have no art for each time of day yet, and on checks written for ways
you changed.

## Inside Cassetto

Plastico is also a module of [Cassetto](../README.md), the suite: there a project holds one world, the
puzzle charts are read live from the Puzzle Charts module (no sync needed), each scene's panel opens its
steps in Puzzle Charts or adds a new one there, and renaming a scene moves the steps placed in it. On
its own, as described here, Plastico works as before.

## Puzzle charts

Each scene's panel lists the puzzle steps that happen there, from the Puzzle Charts page. A lock
finds where its key comes from in a step with the same id. The charts live in claude.ai, so syncing
them goes through Claude: ask *"sync Plastico with my puzzle charts"*. That copies the charts here
(`worlds/<id>.charts.json`) and sends this world's scene and people lists back to the charts page,
so its scene pickers match the world. The steps are in `CLAUDE.md`.

## Other worlds

**New world** starts empty (a plan only: sketch a new game, or an act kept apart from the rest) or
reads another Godot project in `~/Desktop/Projects`. A world without Godot can still have acts,
groups of states, areas and people (World settings).

## Files

| Where | What |
| --- | --- |
| `src/plastico/` | the server (`server.py`), and the logic for reading Godot (`godot.py`, `tscn.py`), pictures (`pictures.py`), building (`apply.py`), the smoke test (`smoke.py`) and worlds (`store.py`) |
| `web/` | the page: `js/model.js` (checks, routes), `js/view3d.js` (the 3D view, three.js r187 in `vendor/`), `js/main.js` |
| `worlds/` | the worlds, their charts, uploaded sketches (`<id>.files/`), the last 60 saves of each (`.history/`), deleted worlds (`.trash/`) |
| `backups/` | what each build replaced |

Checks: `uv run --with pytest pytest` (Python) and `node --test tests/model.test.mjs` (the page's
analysis).
