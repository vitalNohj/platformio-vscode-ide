# Clangd IntelliSense Backend for PlatformIO on Cursor

## Overview

This fork adds **clangd** as an alternative IntelliSense backend alongside the existing Microsoft C/C++ (`cpptools`) engine. Users can switch between backends via a single setting. When clangd is selected, the extension automatically generates `compile_commands.json`, post-processes it for clangd compatibility, and configures the clangd language server with the correct arguments for cross-compilation toolchains.

**Upstream:** [platformio/platformio-vscode-ide](https://github.com/platformio/platformio-vscode-ide) (tag `v3.3.4`)
**Fork:** [vitalNohj/platformio-vscode-ide](https://github.com/vitalNohj/platformio-vscode-ide)

---

## Why

The upstream extension is tightly coupled to Microsoft's C/C++ extension (`ms-vscode.cpptools`). It hard-requires it as an `extensionDependency` and generates `c_cpp_properties.json` exclusively. Clangd is a faster, more accurate language server for many embedded projects, but using it with PlatformIO required extensive manual setup:

- Generating `compile_commands.json` manually via `pio run -t compiledb`
- Fixing bare compiler names that clangd's `--query-driver` can't match
- Fixing relative include paths that clangd can't resolve
- Adding `--query-driver` globs so clangd queries cross-compilers for system headers
- Creating synthetic compilation database entries for header files in directories that clangd's proximity heuristic can't reach
- Disabling `cpptools` IntelliSense to avoid conflicts

This fork automates all of that.

---

## New Setting

```
platformio-ide.intelliSenseEngine: "cpptools" | "clangd"
```

- **`cpptools`** (default) — behaves identically to upstream. Runs `pio project init --ide vscode`, generates `c_cpp_properties.json`.
- **`clangd`** — runs `pio run --target compiledb`, generates `compile_commands.json`, post-processes it, and configures `clangd.arguments`.

Change this in **Settings > PlatformIO IDE > IntelliSense Engine**. Requires a window reload.

---

## Changed Files (vs upstream `v3.3.4`)

### `src/constants.js`

**What changed:** Replaced the hardcoded `CONFLICTED_EXTENSION_IDS` array with a structured `INTELLISENSE_BACKENDS` registry and a dynamic `getConflictedExtensionIds()` function.

**Why:** The upstream treated `vscode-clangd` as always-conflicted. We need it to be a first-class backend. The registry stores each backend's metadata (extension ID, rescan command, config defaults, PIO CLI args) in one place so the rest of the code is data-driven.

**Key details:**
- `cpptools` backend sets `C_Cpp.intelliSenseEngine: "default"` and `C_Cpp.debugShortcut: false`
- `clangd` backend sets `C_Cpp.intelliSenseEngine: "disabled"` and `clangd.detectExtensionConflicts: false`
- `getConflictedExtensionIds()` dynamically marks all non-active backend extensions as conflicted
- Each backend defines `rebuildArgs(env)` returning the PIO CLI arguments for index generation

### `src/main.js`

**What changed:** Added calls to `applyBackendConfigDefaults()` and `warnIfBackendMissing()` during extension activation.

**Why:** On startup, the extension needs to apply the active backend's config defaults (e.g., disable cpptools IntelliSense when clangd is active) and warn if the required backend extension isn't installed.

### `src/misc.js`

**What changed:** `warnAboutConflictedExtensions()` now calls `getActiveConflictedExtensionIds()` from `intellisense.js` instead of importing the removed `CONFLICTED_EXTENSION_IDS` constant.

**Why:** The conflicted extension list is now dynamic — it depends on which backend is active.

### `src/project/manager.js`

**What changed:**
- Passes `getActiveBackend()` as `intelliSenseBackend` to `ProjectPool`
- Adds `onDidRebuildIndex` callback that runs `fixupCompileCommands()`, `ensureClangdArgs()`, and `notifyRescanBackend()` after every index rebuild
- Calls `ensureClangdArgs()` on project switch

**Why:** The index rebuild pipeline needs to know which backend to use for CLI args, and clangd needs post-processing of `compile_commands.json` and workspace settings configuration after every rebuild.

### `package.json`

**What changed:**
- Added `platformio-ide.intelliSenseEngine` setting with `cpptools`/`clangd` enum
- Emptied `extensionDependencies` (was `["ms-vscode.cpptools"]`)
- Emptied `configurationDefaults` (was `{ "C_Cpp.debugShortcut": false }` — now managed dynamically)
- Added `patch-package` to `devDependencies`
- Added npm scripts: `prepare-helpers`, `create-helper-patch`, `postinstall`

**Why:**
- `extensionDependencies` forced cpptools installation — incompatible with clangd-only users
- Config defaults are now applied at runtime based on the active backend
- `patch-package` workflow applies `platformio-node-helpers` changes to `node_modules`

### `.vscodeignore`

**What changed:** Added `platformio-node-helpers/**`, `patches/**`, `.cursor/**`.

**Why:** Exclude development-only files from the VSIX package to keep it small.

### `.gitignore`

**What changed:** Added `.DS_Store`.

**Why:** macOS housekeeping.

---

## New Files

### `src/intellisense.js`

The core of the clangd integration. Contains all backend-aware logic:

| Function | Purpose |
|---|---|
| `getPlatformIOCoreDir()` | Resolves PlatformIO home dir via `PLATFORMIO_CORE_DIR` env var or `~/.platformio` |
| `getActiveBackendId()` | Reads the `intelliSenseEngine` setting, defaults to `cpptools` |
| `getActiveBackend()` | Returns the full backend descriptor from the registry |
| `getActiveConflictedExtensionIds()` | Returns extension IDs that conflict with the active backend |
| `isBackendExtensionInstalled()` | Checks if the active backend's VS Code extension is installed |
| `applyBackendConfigDefaults()` | Applies config defaults for the active backend; intelligently undoes settings set by the previously-active backend |
| `fixupCompileCommands(projectDir)` | **Post-processes `compile_commands.json`** — see below |
| `ensureClangdArgs(projectDir)` | Writes `--compile-commands-dir` and `--query-driver` to `clangd.arguments` workspace setting |
| `notifyRescanBackend()` | Executes the active backend's rescan command (e.g., `clangd.restart`) |
| `warnIfBackendMissing()` | Shows a warning if the backend extension isn't installed, with an install button |

#### `fixupCompileCommands` — the key function

PlatformIO's `pio run -t compiledb` produces a `compile_commands.json` that doesn't work with clangd out of the box. This function fixes three problems:

1. **Bare compiler names** — PIO writes `xtensa-esp32-elf-g++` instead of the full path. Clangd's `--query-driver` glob can't match bare names, so it never queries the cross-compiler for built-in system headers. The function searches `~/.platformio/packages/toolchain-*/bin/` and `tool-*/bin/` to resolve each bare name to its absolute path.

2. **Relative include paths** — PIO writes `-I.pio/libdeps/...` instead of absolute paths. While clangd should resolve these against the `"directory"` field, in practice this is unreliable. The function converts all relative `-I` paths to absolute.

3. **Missing header entries** — Clangd uses directory proximity to match header files to compilation database entries. If a header lives in a different directory tree than any `.cpp` file (e.g., `usermods/foo.h` included from `wled00/main.cpp`), clangd can't find matching flags and loses all IntelliSense for that header. The function walks the project directory, finds all `.h/.hpp/.c/.cpp/.cc/.cxx/.ino` files that aren't already in the database, and adds synthetic entries using the richest compile command as a template.

#### Platform-agnostic design

- Uses `PLATFORMIO_CORE_DIR` env var with `~/.platformio` fallback
- Uses `path.isAbsolute()` and `path.sep` instead of hardcoded `/`
- Builds `--query-driver` globs with correct OS path separators
- Skips `.pio`, `.git`, `node_modules`, `build`, `__pycache__` during directory walks
- No assumptions about toolchain names, board architectures, or project structure

### `patches/platformio-node-helpers+11.3.0.patch`

A `patch-package` patch applied to `node_modules/platformio-node-helpers` on `npm install`. Contains the changes to the `platformio-node-helpers` npm package described below.

### `platformio-node-helpers/platformio-node-helpers/` (git submodule)

A submodule pointing to a fork of [platformio-node-helpers](https://github.com/platformio/platformio-node-helpers). Contains modified source files that are built and patched into `node_modules`. Three files are changed:

#### `src/project/indexer.js`

- Uses `this.options.intelliSenseBackend.rebuildArgs()` to determine CLI arguments instead of always running `pio project init --ide vscode`. For clangd, this runs `pio run --target compiledb`.
- Awaits `this.options.api.onDidRebuildIndex(projectDir)` after successful index generation so the extension can post-process `compile_commands.json`.

#### `src/project/tasks.js`

- `ProjectTasks` constructor accepts `intelliSenseBackend` parameter.
- `fetchEnvTasks()` uses `backend.rebuildArgs(env)` to build the correct "Rebuild IntelliSense Index" task command.

#### `src/project/observer.js`

- Passes `this.options.intelliSenseBackend` through to `ProjectTasks`.

### `TESTING.md`

Instructions for building the extension, applying helper patches, packaging as VSIX, and testing locally.

---

## How the Clangd Pipeline Works

```
User selects "clangd" in settings → Window reload
                    ↓
Extension activates → applyBackendConfigDefaults()
  - Sets C_Cpp.intelliSenseEngine = "disabled"
  - Sets clangd.detectExtensionConflicts = false
                    ↓
"Rebuild IntelliSense Index" triggered
                    ↓
indexer.js runs: pio run --target compiledb --environment <env>
  → Produces compile_commands.json
                    ↓
onDidRebuildIndex callback fires:
  1. fixupCompileCommands(projectDir)
     - Resolves bare compiler names to absolute paths
     - Converts relative -I paths to absolute
     - Adds synthetic entries for uncovered headers
  2. ensureClangdArgs(projectDir)
     - Sets --compile-commands-dir in clangd.arguments
     - Sets --query-driver glob in clangd.arguments
  3. notifyRescanBackend()
     - Executes clangd.restart
                    ↓
Clangd reads compile_commands.json with:
  - Absolute compiler paths matching --query-driver
  - Absolute include paths for all libraries
  - Entries for every project header file
  → Full IntelliSense for all project files
```

---

## Development Workflow

```bash
# Install dependencies (patch-package runs automatically via postinstall)
npm install

# After modifying platformio-node-helpers source:
npm run prepare-helpers    # Build helpers and copy to node_modules
npm run create-helper-patch # Generate/update the .patch file

# Build extension
npm run build

# Package VSIX
npx vsce package --no-yarn
```
