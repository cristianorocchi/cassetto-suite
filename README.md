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

`--window none` starts only the server, with no window (for development and tests). `--port` sets
the port (8767 by default), and `--fresh` starts without reopening the last project.

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
  plastico/world.json  the world plan (Plastico's own format, "v": 2: block sizes in grid cells, parent scene, charts per scene),
                       world.files/ sketches, .history/ the last 60 saves
  puzzles/charts/      one <id>.json per chart (the Puzzle Charts page's own document, "v": 1); .trash/ deleted charts
  backups/             what each Godot build replaced
```

- **Versions.** Each format carries a version: the manifest, each module's data, and each world and
  chart.
  - A project, module or file from a newer Cassetto is refused with a message, never misread.
  - An older one is brought up to date when it opens: the manifest by the migrations in
    `core/project.py`, the world by Plastico's own (`plastico/src/plastico/store.py`, version 1 → 2).
- **Damaged files.** A damaged chart is reported and left on disk. A damaged world stops the project
  from opening and points at its history.
- **One window per project.** A project is open in one Cassetto at a time (`.cassetto.lock`). A lock
  left behind by a crash doesn't count.
- **A project as one file.** The project menu's *Export the project…* writes the whole project
  (world, charts, sketches, history) into one `.cassetto` file, a zip without the lock. *Import a
  project…* (in the menu, or on the welcome screen) unpacks one into a new folder named after the
  project, adding " 2", " 3"… when that name is taken, and opens it. A file from a newer Cassetto is
  refused.

## How it is built

```
src/cassetto/
  core/project.py    the project folder and its manifest, versions, migrations, recent projects
  core/modules.py    Module (one tool) and Core: lifecycle, interfaces between modules, change watching
  core/events.py     what happened in the project, for the pages (long polling)
  core/settings.py   the user's own settings kept in the config folder (the keyboard shortcuts)
  core/server.py     local HTTP server: the shell, the module pages, /api/core/*, each module's API
  modules/plastico.py, modules/puzzles.py   the two modules: their data, their interfaces, their API
  integrations/godot.py                     the single place the suite asks about Godot
  app.py, cli.py     the window and the command
web/shell/           the suite's page: project menu, module tabs, save status, dialogs
web/shared/          what every page gets: the bridge (cassetto-bridge.js), the theme, the keyboard shortcuts (keys.js), fonts
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
- **The theme.** The shell's theme menu switches the whole suite between System, Light, Dark and
  Black (OLED, dark on true black). The choice is kept per browser profile (`web/shared/theme.js`)
  and reaches every module page at once.
- **Settings** (the gear at the top right, Ctrl+,) holds the theme and the **keyboard shortcuts**.
  - Every shortcut is an action in `web/shared/keys.js`. Each action has an id (`plastico.fit`), the
    place it works (*Everywhere*, or one module) and its default keys. The pages ask
    `CassettoKeys.find(event, scope)` which action a key press means, instead of checking keys
    themselves.
  - Click a shortcut, then press the new keys. An action can have up to four shortcuts, or none.
    Changes work at once in every module, and buttons whose `title` names a key
    (`data-keys="<id>"`) follow them.
  - A key another action already uses in the same place is not taken silently. The row asks first:
    *Use it here* moves the key, *Keep it there* leaves it.
  - Keys that work everywhere need Ctrl or Alt (or an F key), so typing in a field never sets them
    off. Esc, Tab, Enter and Space on their own stay free for moving around.
  - You can search the list by name, or press keys to see what uses them. One action can be reset,
    or all of them.
  - Only the changes are kept, in `~/.config/cassetto/keybindings.json`, so they follow you from
    project to project and between window types. Plastico or Puzzle Charts opened on their own keep
    their usual keys.

## What the modules share

| Data | Owner | Offered as | Used by | Up to date |
| --- | --- | --- | --- | --- |
| Scenes, people, times of day, acts of the world (with each scene's act, parent and whether it is in the game) | Plastico | `world.catalog` | Puzzle Charts: Where (the chart's act's scenes first) and Who, the act of a chart, the "not in the world" and "In another act" checks | read on every request; Puzzle Charts reloads on each `world.changed` |
| Who is in each scene at each time of day (the game's people, less the ones the plan takes away, plus the plan's) | Plastico | `world.catalog` → `people_at` (the Godot scan is read again only when a scene or character file changes) | Puzzle Charts: Who lists the people in the step's scene then first, and the "Not there then" check: it says where the world has them then, and offers to move the step there or put them in its scene | as above |
| Puzzle charts (steps, scenes, game ids, links) | Puzzle Charts | `puzzles.charts` | Plastico: each scene's steps, where a lock's key is found, the "chart place missing" check | live from the chart files; Plastico refreshes on each `puzzles.changed` |
| A scene's id changing | Plastico (asks) | `puzzles.rename_scene` | Puzzle Charts moves the steps placed there | when the scene's name sets its new id |
| Which charts go with which scene (one chart can go with many) | worked out from the steps: a chart goes with every scene one of its steps is placed in. A chart can also be pinned to a scene by hand before it has steps there (`charts: [chart ids]` in world.json) | `world.catalog` → `hierarchy` (`charts`, `charts_from_steps`, `charts_pinned`, `steps`) | the project tree, Plastico's "Puzzle charts here", Puzzle Charts ("Scenes" of a chart), `puzzles.references` | on every change of either side |
| The locked ways (what each lock needs) | Plastico | `world.catalog` → `locks` | Puzzle Charts: a step that gives the item or sets the flag says which lock it opens | on every save of the world |
| Adding a person or scene a step names | Plastico (`world.add_person`, `world.add_scene`, `world.place_person`) | `puzzles.add_to_world` | the broken links list and a step's panel: one click adds it, points the steps at it, and puts a person in the scenes those steps have them in (at the step's time of day, or every time) | at once; an open Plastico page reloads |
| Scenes inside scenes (`parent`), acts | Plastico | `world.catalog` → `hierarchy` | the project tree | on every save of the world |
| The act on screen | the shell (one for the whole suite, remembered per project) | `cassetto.act()`, `cassetto.setAct()` and the `act` event in the page bridge | Plastico shows that act; Puzzle Charts opens that act's chart (the one last opened in it, or a fresh one, saved with its first change, when the act has none) and makes new charts in it; opening a chart moves Plastico to the chart's act unless Plastico shows every act; the tree marks the act | at once |
| Steps pointing at scenes or people the world lacks | Puzzle Charts | `puzzles.references` | the shell's "broken links" counter and list | on every change of either side |
| A step's person not in its scene at its time of day | worked out by Plastico (the people plan and the game) | Plastico's checks ("Not there then": where the world has them then, a button that puts them there and one that opens the step) | Plastico | on every change of either side |

The two modules link both ways. From a scene in Plastico, you can open any of its steps in Puzzle
Charts, or open a chart with that scene's steps highlighted. From a step in Puzzle Charts, you can show
its scene in Plastico. A chart's panel lists its scenes and people with their step counts (one click
highlights those steps) and the scenes of its act it doesn't use yet. With an act on screen, Plastico
lists the act's charts and its scenes with no puzzle step.

- **The project tree** (left, Ctrl+B) shows acts › the act's charts, then its scenes › scenes inside them ›
  the charts with steps in each scene (with how many) or pinned to it. A chart for an act the world doesn't
  have goes in a group of its own. The act on screen has a mark. Steps are counted the
  same everywhere: every node but the end goals and the scene setups. A scene opens in Plastico, a chart in Puzzle
  Charts, an act filters Plastico to it. It reloads on every `world.changed` / `puzzles.changed`, and
  follows what the modules select.
- **Changes from outside.** The core notices edits made outside the app, by an editor, git or Claude,
  within two seconds, and both pages follow.
- **A missing reference** is a warning, never an error. It shows in four places: the step's panel,
  the chart's checks, Plastico's checks and the shell's counter. Nothing is deleted or rewritten to
  hide it.
- **A missing module or interface.** If one is missing (`MissingInterface`), the page that needed it
  carries on without it.

## Godot

Godot is optional. `integrations/godot.py` reports on the linked game and lists what the link does.
A game is linked when a project is made (**New project › A Godot game** lists the games found in
`~/Desktop/Projects` and one folder down, or takes any folder) or later in Plastico's World settings.

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
