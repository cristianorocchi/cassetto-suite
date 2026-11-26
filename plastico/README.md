# Plastico

A 3D model of a game's world, for planning and studying its structure: every scene is a block on
its floor, every way between two scenes a path. It reads a Godot project directly and can build
the changes you plan back into it.

Start it from the **Plastico** icon on the desktop (or `./open-app.sh`, or `uv run plastico app`).
It opens in its own window at http://127.0.0.1:8766/. Closing the terminal window stops it.

## What you see

- **Skeleton / Pictures.** Skeleton shows the structure only. Pictures lays each outdoor scene's
  picture on its plate and stands each indoor scene's picture on its room, using the game's own art
  for the chosen time of day. Scenes not in the game yet can get a sketch: drop it on the scene's
  panel.
- **Blocks.** Flat plates are outside scenes (third person), boxes are inside scenes (first person),
  small boxes are close-ups. A solid outline means the scene is in the game. Dashed means planned
  (an idea, or ready to build). Red means it is marked to delete. Floors stack: a scene on floor 1
  floats above street level, one on −1 sits below it, with a post down to its footprint.
- **Ways.** A solid line is in the game and a dashed one is planned. An arrow marks a one-way path.
  A badge shows a lock (the item or flag it needs) or a way that is only open at some times of day.
  A grey "?" stub is an exit in the game that leads nowhere yet.
- **Time of day** (morning, day, sunset, midnight) switches the pictures, who is where, and which
  scenes and ways are open.
- **Acts and areas** (left panel). An act can be shown on its own. Areas colour the blocks.
- **Labels** shrink to the name only, or to a dot, when they would cover a more important one.
  Hover a dot to read it.

## Editing

- **Add a scene:** double-click the ground, or press **Add scene** (N).
- **Move a scene:** drag it. Hold Shift for free placement instead of the half-unit grid. While you
  hold it, the wheel takes it up a floor (wheel away from you) or down one; with nothing held, the
  wheel zooms.
- **Join two scenes:** drag the dot on a scene's label onto another scene. Drop it on empty ground
  to make a new scene that is already joined.
- **Select** a scene or a way to edit it on the right: name, kind, act, area, floor, status, opening
  times, people per time of day, locks, notes.
- **People:** under People here, + person adds someone at a time of day and × takes them out. Grey
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
  with every lock closed, or with only what is open at this time of day.
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

## Puzzle charts

Each scene's panel lists the puzzle steps that happen there, from the Puzzle Charts page. A lock
finds where its key comes from in a step with the same id. The charts live in claude.ai, so syncing
them goes through Claude: ask *"sync Plastico with my puzzle charts"*. That copies the charts here
(`worlds/<id>.charts.json`) and sends this world's scene and people lists back to the charts page,
so its scene pickers match the world. The steps are in `CLAUDE.md`.

## Other worlds

**New world** starts empty (a plan only: sketch a new game, or an act kept apart from the rest) or
reads another Godot project in `~/Desktop/Projects`. A world without Godot can still have acts,
areas, people and times of day (World settings).

## Files

| Where | What |
| --- | --- |
| `src/plastico/` | the server (`server.py`), and the logic for reading Godot (`godot.py`, `tscn.py`), pictures (`pictures.py`), building (`apply.py`), the smoke test (`smoke.py`) and worlds (`store.py`) |
| `web/` | the page: `js/model.js` (checks, routes), `js/view3d.js` (the 3D view, three.js r187 in `vendor/`), `js/main.js` |
| `worlds/` | the worlds, their charts, uploaded sketches (`<id>.files/`), the last 60 saves of each (`.history/`), deleted worlds (`.trash/`) |
| `backups/` | what each build replaced |

Checks: `uv run --with pytest pytest` (Python) and `node --test tests/model.test.mjs` (the page's
analysis).
