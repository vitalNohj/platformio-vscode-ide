/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import {
  INTELLISENSE_BACKENDS,
  IS_WINDOWS,
  getConflictedExtensionIds,
} from './constants';
import { extension } from './main';
import vscode from 'vscode';
import { promises as fs } from 'fs';
import path from 'path';

function getPlatformIOCoreDir() {
  return (
    process.env.PLATFORMIO_CORE_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || '~', '.platformio')
  );
}

export function getActiveBackendId() {
  return extension.getConfiguration('intelliSenseEngine') || 'cpptools';
}

export function getActiveBackend() {
  const id = getActiveBackendId();
  return INTELLISENSE_BACKENDS[id] || INTELLISENSE_BACKENDS.cpptools;
}

export function getActiveConflictedExtensionIds() {
  return getConflictedExtensionIds(getActiveBackendId());
}

export function isBackendExtensionInstalled() {
  const backend = getActiveBackend();
  return !!vscode.extensions.getExtension(backend.extensionId);
}

export async function applyBackendConfigDefaults() {
  const backend = getActiveBackend();
  const otherBackendValues = collectOtherBackendValues(backend.id);
  const config = vscode.workspace.getConfiguration();

  for (const [key, value] of Object.entries(backend.configDefaults)) {
    const inspected = config.inspect(key);
    const currentGlobal = inspected ? inspected.globalValue : undefined;
    const currentWorkspace = inspected ? inspected.workspaceValue : undefined;

    const isUnset = currentGlobal === undefined && currentWorkspace === undefined;
    const wasSetByOtherBackend =
      key in otherBackendValues && currentGlobal === otherBackendValues[key];

    if (isUnset || wasSetByOtherBackend) {
      await config.update(key, value, vscode.ConfigurationTarget.Global);
    }
  }
}

function collectOtherBackendValues(activeId) {
  const values = {};
  for (const [id, backend] of Object.entries(INTELLISENSE_BACKENDS)) {
    if (id === activeId) {
      continue;
    }
    Object.assign(values, backend.configDefaults);
  }
  return values;
}

/**
 * Post-process compile_commands.json so clangd works correctly:
 *  1. Resolve bare compiler names to absolute paths so --query-driver matches.
 *  2. Convert relative -I include paths to absolute so clangd finds headers.
 *  3. Convert relative "file" entries to absolute.
 *  4. Add synthetic entries for header files included from other directories
 *     so clangd can match them (it uses directory proximity heuristics).
 */
export async function fixupCompileCommands(projectDir) {
  if (getActiveBackendId() !== 'clangd' || !projectDir) {
    return;
  }
  const ccPath = path.join(projectDir, 'compile_commands.json');
  let raw;
  try {
    raw = await fs.readFile(ccPath, 'utf-8');
  } catch {
    return;
  }

  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    return;
  }

  const resolveCache = new Map();
  const packagesDir = path.join(getPlatformIOCoreDir(), 'packages');

  async function resolveCompiler(bare) {
    if (resolveCache.has(bare)) {
      return resolveCache.get(bare);
    }
    try {
      const dirs = await fs.readdir(packagesDir);
      for (const d of dirs) {
        if (!d.startsWith('toolchain-') && !d.startsWith('tool-')) {
          continue;
        }
        const candidate = path.join(packagesDir, d, 'bin', bare);
        try {
          await fs.access(candidate);
          resolveCache.set(bare, candidate);
          return candidate;
        } catch {
          // not here
        }
      }
    } catch {
      // packagesDir unreadable
    }
    resolveCache.set(bare, null);
    return null;
  }

  const existingFiles = new Set();
  for (const entry of entries) {
    const dir = entry.directory || projectDir;

    if (entry.file && !path.isAbsolute(entry.file)) {
      entry.file = path.join(dir, entry.file);
    }
    existingFiles.add(entry.file);

    if (!entry.command) {
      continue;
    }

    const parts = entry.command.split(' ');

    // 1. Resolve bare compiler name
    const compiler = parts[0];
    if (compiler && !compiler.includes('/') && !compiler.includes('\\')) {
      const resolved = await resolveCompiler(compiler);
      if (resolved) {
        parts[0] = resolved;
      }
    }

    // 2. Convert relative -I paths to absolute
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].startsWith('-I') && !path.isAbsolute(parts[i].slice(2))) {
        parts[i] = `-I${path.join(dir, parts[i].slice(2))}`;
      }
    }

    entry.command = parts.join(' ');
  }

  // 3. Add synthetic entries for project header/source files that aren't in
  //    the compilation database. clangd uses directory proximity to match
  //    headers to compile commands; files in directories like usermods/ that
  //    have no .cpp entry nearby get no flags and lose all IntelliSense.
  //    We find a representative project entry and clone its flags for every
  //    missing file.
  const pioBuildDir = `${path.sep}.pio${path.sep}`;
  const pioCoreDir = `${path.sep}.platformio${path.sep}`;
  const projectSrcEntries = entries.filter(
    (e) =>
      e.file &&
      e.command &&
      e.file.startsWith(projectDir) &&
      !e.file.includes(pioBuildDir) &&
      !e.file.includes(pioCoreDir),
  );

  // Pick the entry with the richest include set (most -I flags) as template
  let templateEntry = projectSrcEntries[0];
  let maxIncludes = 0;
  for (const e of projectSrcEntries) {
    const count = (e.command.match(/-I/g) || []).length;
    if (count > maxIncludes) {
      maxIncludes = count;
      templateEntry = e;
    }
  }

  if (templateEntry) {
    const templateCmd = templateEntry.command.replace(/\s-o\s+\S+/, ' -o /dev/null');
    const templateDir = templateEntry.directory;

    const SKIP_DIRS = new Set([
      'node_modules',
      '.pio',
      '.git',
      'build',
      '__pycache__',
    ]);

    async function walkDir(dir) {
      const result = [];
      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return result;
      }
      for (const d of dirents) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (d.name.startsWith('.') || SKIP_DIRS.has(d.name)) {
            continue;
          }
          result.push(...(await walkDir(full)));
        } else if (/\.(h|hpp|c|cpp|cc|cxx|ino)$/i.test(d.name)) {
          result.push(full);
        }
      }
      return result;
    }

    const allProjectFiles = await walkDir(projectDir);
    const syntheticEntries = [];

    for (const file of allProjectFiles) {
      if (existingFiles.has(file)) {
        continue;
      }
      syntheticEntries.push({
        directory: templateDir,
        command: templateCmd.replace(templateEntry.file, file),
        file,
      });
    }

    if (syntheticEntries.length > 0) {
      entries.push(...syntheticEntries);
    }
  }

  await fs.writeFile(ccPath, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
}

export async function ensureClangdArgs(projectDir) {
  if (getActiveBackendId() !== 'clangd' || !projectDir) {
    return;
  }
  const config = vscode.workspace.getConfiguration('clangd');
  const currentArgs = config.get('arguments') || [];
  let newArgs = [...currentArgs];
  let changed = false;

  // --compile-commands-dir: tell clangd where compile_commands.json lives
  const compileCommandsFlag = `--compile-commands-dir=${projectDir}`;
  changed = upsertArg(newArgs, '--compile-commands-dir=', compileCommandsFlag) || changed;

  // --query-driver: let clangd query PlatformIO cross-compilers for built-in
  // include paths (C++ stdlib, GCC internals, sysroot). Without this, clangd
  // can't resolve system headers for embedded targets like xtensa, arm, riscv.
  const pioDir = getPlatformIOCoreDir();
  const sep = IS_WINDOWS ? '\\' : '/';
  const glob = IS_WINDOWS ? '*\\*' : '*/bin/*';
  const queryDriverGlob = [
    `${pioDir}${sep}packages${sep}toolchain-${glob}`,
    `${pioDir}${sep}packages${sep}tool-${glob}`,
  ].join(',');
  const queryDriverFlag = `--query-driver=${queryDriverGlob}`;
  changed = upsertArg(newArgs, '--query-driver=', queryDriverFlag) || changed;

  if (changed) {
    await config.update('arguments', newArgs, vscode.ConfigurationTarget.Workspace);
  }
}

function upsertArg(args, prefix, value) {
  const idx = args.findIndex((a) => a.startsWith(prefix));
  if (idx !== -1) {
    if (args[idx] === value) {
      return false;
    }
    args[idx] = value;
    return true;
  }
  args.push(value);
  return true;
}

export async function notifyRescanBackend() {
  const backend = getActiveBackend();
  if (!backend.rescanCommand) {
    return;
  }
  try {
    await vscode.commands.executeCommand(backend.rescanCommand);
  } catch (err) {
    console.warn(
      `Failed to execute rescan command "${backend.rescanCommand}": ${err.message}`,
    );
  }
}

export function warnIfBackendMissing() {
  if (isBackendExtensionInstalled()) {
    return;
  }
  const backend = getActiveBackend();
  vscode.window
    .showWarningMessage(
      `PlatformIO: The selected IntelliSense engine "${backend.label}" ` +
        `requires the "${backend.extensionId}" extension, but it is not installed.`,
      { title: 'Install Extension', isCloseAffordance: false },
      { title: 'Dismiss', isCloseAffordance: true },
    )
    .then((selected) => {
      if (selected && selected.title === 'Install Extension') {
        vscode.commands.executeCommand(
          'workbench.extensions.search',
          backend.extensionId,
        );
      }
    });
}
