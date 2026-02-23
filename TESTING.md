# Building and Testing the PlatformIO IDE Extension

## Prerequisites

- Node.js 14+
- npm

## 1. Apply the platformio-node-helpers edits (required for clangd/IntelliSense)

This repo includes local changes to `platformio-node-helpers` (in `platformio-node-helpers/platformio-node-helpers/src/project/`). The published npm package does not include them, so you must either apply the patch or build the helpers and copy them into `node_modules`.

### Option A: Use the patch (recommended after first setup)

If `patches/platformio-node-helpers+11.3.0.patch` exists in the repo:

```bash
npm install
```

The `postinstall` script runs `patch-package`, which applies the patch to `node_modules/platformio-node-helpers` automatically.

### Option B: Build and copy the local helpers (first time or when editing helpers)

```bash
npm run prepare-helpers
```

This will:

1. Install dependencies and build `platformio-node-helpers` from `platformio-node-helpers/platformio-node-helpers/` (with the clangd/indexer/tasks/observer edits).
2. Copy the built `dist/index.js` and `dist/index.js.map` into `node_modules/platformio-node-helpers/dist/`, so the extension uses your patched code.

To save this state as a patch for others (or for CI):

```bash
npm run create-helper-patch
```

That runs `prepare-helpers` then `npx patch-package platformio-node-helpers`, creating or updating `patches/platformio-node-helpers+11.3.0.patch`. Commit the `patches/` folder so that `npm install` + `postinstall` will apply it.

## 2. Build the extension (webpack)

```bash
npm run build
```

Output: `dist/extension.js` (used when running or packaging the extension).

## 3. Package as a VSIX (installable file)

```bash
npm run vscode:package
```

This runs `webpack --mode production` then `vsce package`, producing a `.vsix` file in the project root (e.g. `platformio-ide-3.x.x.vsix`).

**Important:** Run `npm run prepare-helpers` (or have the patch applied via `npm install`) *before* packaging, so the VSIX contains the patched `platformio-node-helpers`.

## 4. Test the extension

### Option A: Install the VSIX in VS Code / Cursor

1. Build the VSIX: `npm run vscode:package`
2. In VS Code: **Extensions** view → **...** (More Actions) → **Install from VSIX...**
3. Select the generated `.vsix` file
4. Reload the window if prompted
5. Open a PlatformIO project and verify IntelliSense (cpptools or clangd) and “Rebuild IntelliSense Index” work as expected.

### Option B: Run in Extension Development Host (no VSIX)

1. Open this repo folder in VS Code
2. Press **F5** (or **Run → Start Debugging**)
3. A new window opens with the extension loaded; use that window to open a PlatformIO project and test.

For this flow, `node_modules` must already contain the patched helpers (run `npm run prepare-helpers` or `npm install` with the patch in place).

## clangd and toolchain includes

When using the **clangd** IntelliSense engine, the extension automatically ensures `compile_commands.json` includes toolchain paths (so clangd can resolve system and framework headers). It does this by:

1. Creating `.vscode/platformio_compiledb_include_toolchain.py` in the project (if missing), which sets `COMPILATIONDB_INCLUDE_TOOLCHAIN=True` for PlatformIO.
2. Adding that script to `extra_scripts` in the first `[env]` section of `platformio.ini` (if not already present).

See [PlatformIO compile_commands.json docs](https://docs.platformio.org/en/latest/integration/compile_commands.html) for details.

## Summary

| Goal                         | Command                    |
|-----------------------------|----------------------------|
| Apply helpers patch         | `npm install` (if patch exists) or `npm run prepare-helpers` |
| Save helpers as patch       | `npm run create-helper-patch` |
| Build extension             | `npm run build`            |
| Create installable VSIX     | `npm run vscode:package`   |
| Test in dev host (F5)       | Use patched helpers, then F5 |
