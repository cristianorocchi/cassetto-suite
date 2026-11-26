# Cassetto

A desktop suite for designing the structure of narrative and point-and-click games. One project holds
a game's **world** and its **puzzles**. Each is a module of the suite:

- **Plastico** (`plastico/`): the world as a 3D model. Scenes are blocks, ways between them are paths,
  and the floors stack. It reads a Godot game and can build the plan into it.
- **Puzzle Charts** (`puzzle-charts/`): puzzle dependency charts. Steps need other steps, through
  sub goals, down to the end goal.

The two share one project and work on each other's data. Cassetto works without Godot. A Godot game
can be linked when you want one.

## Start it

**Packaged app (Linux x86_64).** Unpack `cassetto-<version>-linux-x86_64.tar.gz`, then run
`./cassetto/install.sh`. Cassetto then shows up in the applications menu, and `cassetto` works as a
command. `./install.sh --remove` takes it away again. Your projects are never touched.

**From the source** (needs [uv](https://docs.astral.sh/uv/)):

```sh
uv run cassetto                     # the suite, reopening the last project
uv run cassetto ~/Cassetto/MyGame   # a given project
uv run --extra desktop cassetto     # with the native window (Qt WebEngine) instead of Chrome
```

**Which window opens.** Cassetto picks a window by itself (`--window auto`) and tries these in
order:

1. Its own native window (pywebview on Qt WebEngine, always present in the packaged app).
2. Chrome or Chromium as an app window with its own profile.
3. The default browser.

Use `--window chrome|browser|native` to choose one, or set `CASSETTO_WINDOW=chrome` to make that
choice stick. In every case the app ends when its window closes. In the browser, it ends a little
after the tab stops checking in. Nobody has to start a server by hand.

Other commands:

```sh
cassetto new ~/Cassetto/Town --name Town [--godot ~/Projects/town] [--from-world plastico/worlds/town.json]
cassetto info ~/Cassetto/Town                        # manifest, modules, interfaces, broken links
cassetto import-charts ~/Cassetto/Town charts.json   # the JSON the Puzzle Charts page copies
```

## Build the desktop app

```sh
packaging/build.sh          # → dist/cassetto/ and dist/cassetto-<version>-linux-x86_64.tar.gz
```

The script uses PyInstaller in a build environment of its own (`.build-env/`). It leaves out the parts
of Qt the window never loads (`packaging/trim_qt.py`). The result is about 450 MB unpacked and
190 MB packed, and most of that is Qt WebEngine.

## A project on disk

```
My game/
  cassetto.json        manifest: {"format": "cassetto.project", "version": 1, name, id, modules: {plastico: {version}, puzzles: {version}}}
  plastico/world.json  the world plan (Plastico's own format, "v": 1), world.files/ sketches, .history/ the last 60 saves
  puzzles/charts/      one <id>.json per chart (the Puzzle Charts page's own document, "v": 1); .trash/ deleted charts
  backups/             what each Godot build replaced
```

- **Versions.** Each format carries a version: the manifest, each module's data, and each world and
  chart.
  - A project, module or file from a newer Cassetto is refused with a message, never misread.
  - An older one is brought up to date by the migrations in `core/project.py`.
- **Damaged files.** A damaged chart is reported and left on disk. A damaged world stops the project
  from opening and points at its history.
- **One window per project.** A project is open in one Cassetto at a time (`.cassetto.lock`). A lock
  left behind by a crash doesn't count.

## How it is built

```
src/cassetto/
  core/project.py    the project folder and its manifest, versions, migrations, recent projects
  core/modules.py    Module (one tool) and Core: lifecycle, interfaces between modules, change watching
  core/events.py     what happened in the project, for the pages (long polling)
  core/server.py     local HTTP server: the shell, the module pages, /api/core/*, each module's API
  modules/plastico.py, modules/puzzles.py   the two modules: their data, their interfaces, their API
  integrations/godot.py                     the single place the suite asks about Godot
  app.py, cli.py     the window and the command
web/shell/           the suite's page: project menu, module tabs, save status, dialogs
web/shared/          the bridge every module page gets (cassetto-bridge.js), fonts
plastico/            Plastico, still runnable on its own (`uv run plastico app` in plastico/)
puzzle-charts/       Puzzle Charts: index.html is still the claude.ai artifact page; in Cassetto,
                     cassetto-db.js stands in for the artifact's database and saves into the project
```

- **Modules.** A module owns one folder of the project. It answers its own API, serves its own page,
  and offers named **interfaces** to the others. It never imports another module: it calls the
  others through `ctx.require(name)` / `ctx.optional(name)`.
- **Adding a module.** A new module is a `Module` subclass, a page, and one line in
  `modules/__init__.py`.
- **The shell.** It shows each page in its own frame, kept alive between switches. It hands each page
  a link (`window.cassetto`) that carries:
  - the project;
  - the events;
  - `navigate(module, target)` and `call(interface, ...)`;
  - the save status and errors.

## What the modules share

| Data | Owner | Offered as | Used by | Up to date |
| --- | --- | --- | --- | --- |
| Scenes, people, times of day, acts of the world | Plastico | `world.catalog` | Puzzle Charts: the Where/Who pickers and the "not in the world" checks | read on every request, no cache; Puzzle Charts reloads on each `world.changed` |
| Puzzle charts (steps, scenes, game ids, links) | Puzzle Charts | `puzzles.charts` | Plastico: each scene's steps, where a lock's key is found, the "chart place missing" check | live from the chart files; Plastico refreshes on each `puzzles.changed` |
| A scene's id changing | Plastico (asks) | `puzzles.rename_scene` | Puzzle Charts moves the steps placed there | when the scene's name sets its new id |
| Steps pointing at scenes or people the world lacks | Puzzle Charts | `puzzles.references` | the shell's "broken links" counter and list | on every change of either side |

The two modules link both ways. From a scene in Plastico, you can open any of its steps in Puzzle
Charts, or add a new step already placed in that scene. From a step in Puzzle Charts, you can show its
scene in Plastico.

- **Changes from outside.** The core notices edits made outside the app, by an editor, git or Claude,
  within two seconds, and both pages follow.
- **A missing reference** is a warning, never an error. It shows in three places: the step's panel,
  the chart's checks, Plastico's checks and the shell's counter. Nothing is deleted or rewritten to
  hide it.
- **A missing module or interface.** If one is missing (`MissingInterface`), the page that needed it
  carries on without it.

## Godot

Godot is optional. `integrations/godot.py` reports on the linked game and lists what the link does.

**Works today.** These were already in Plastico and are unchanged:

- reading the game every time Plastico opens or regains focus;
- each scene's art per time of day;
- Build, with a backup first and Undo;
- the headless smoke test (needs the `godot` command).

**Only prepared.** Each has a place in `CAPABILITIES`, but nothing runs yet:

- checking puzzle steps' game ids against the game's items and flags;
- building puzzle steps into the game;
- opening a scene in the Godot editor.

## Tests

```sh
uv run --group dev pytest tests plastico/tests            # the suite, the end-to-end browser test, Plastico
cd plastico && node --test tests/model.test.mjs           # Plastico's analysis
uvx playwright install chromium                           # once, if there is no Chrome for the browser test
```

`tests/test_suite_e2e.py` drives the whole suite in a browser:

- make a project;
- add scenes in Plastico;
- add a step from a scene, which opens Puzzle Charts;
- rename the scene and see the step move;
- see a broken link counted and fix it;
- close and reopen;
- restart the app and reopen.
