/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import { INTELLISENSE_BACKENDS, getConflictedExtensionIds } from './constants';
import { extension } from './main';
import vscode from 'vscode';
import { promises as fs } from 'fs';
import path from 'path';

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

const COMPILEDB_TOOLCHAIN_SCRIPT = 'platformio_compiledb_include_toolchain.py';
const COMPILEDB_TOOLCHAIN_SCRIPT_CONTENT = [
  '# Injected by PlatformIO IDE so compile_commands.json includes toolchain paths for clangd',
  'Import("env")',
  'env.Replace(COMPILATIONDB_INCLUDE_TOOLCHAIN=True)',
].join('\n');

export async function ensureCompiledbIncludeToolchain(projectDir) {
  if (getActiveBackendId() !== 'clangd' || !projectDir) {
    return;
  }
  const scriptDir = path.join(projectDir, '.vscode');
  const scriptPath = path.join(scriptDir, COMPILEDB_TOOLCHAIN_SCRIPT);
  const iniPath = path.join(projectDir, 'platformio.ini');

  try {
    await fs.mkdir(scriptDir, { recursive: true });
    const existing = await fs.readFile(scriptPath, 'utf-8').catch(() => '');
    if (existing.trim() !== COMPILEDB_TOOLCHAIN_SCRIPT_CONTENT.trim()) {
      await fs.writeFile(scriptPath, COMPILEDB_TOOLCHAIN_SCRIPT_CONTENT + '\n', 'utf-8');
    }

    let iniContent = await fs.readFile(iniPath, 'utf-8').catch(() => '');
    if (iniContent.includes(COMPILEDB_TOOLCHAIN_SCRIPT)) {
      return;
    }

    const scriptRef = `pre:.vscode/${COMPILEDB_TOOLCHAIN_SCRIPT}`;
    const lines = iniContent.split(/\r?\n/);
    const eol = iniContent.includes('\r\n') ? '\r\n' : '\n';

    // Find the [env] base section (not [env:xxx]) -- all envs inherit from it
    let envBaseIndex = -1;
    let envBaseExtraScriptsIndex = -1;
    let nextSectionAfterEnvBase = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\[env\]\s*$/.test(line)) {
        envBaseIndex = i;
        continue;
      }
      if (envBaseIndex >= 0 && nextSectionAfterEnvBase === -1) {
        if (/^\[/.test(line)) {
          nextSectionAfterEnvBase = i;
          continue;
        }
        if (/^\s*extra_scripts\s*=/.test(line)) {
          envBaseExtraScriptsIndex = i;
        }
      }
    }

    if (envBaseIndex >= 0) {
      if (envBaseExtraScriptsIndex >= 0) {
        // Append to existing extra_scripts line in [env]
        lines[envBaseExtraScriptsIndex] += `, ${scriptRef}`;
      } else {
        // Add extra_scripts right after [env] header
        const insertAt = envBaseIndex + 1;
        lines.splice(insertAt, 0, `extra_scripts = ${scriptRef}`);
      }
    } else {
      // No [env] section exists -- add one before the first [env:xxx]
      let firstEnvNamedIndex = lines.findIndex((l) => /^\[env:/.test(l));
      if (firstEnvNamedIndex >= 0) {
        lines.splice(firstEnvNamedIndex, 0, '[env]', `extra_scripts = ${scriptRef}`, '');
      } else {
        // No env sections at all -- append
        lines.push('', '[env]', `extra_scripts = ${scriptRef}`);
      }
    }

    await fs.writeFile(iniPath, lines.join(eol), 'utf-8');
  } catch (err) {
    console.warn('PlatformIO IDE: could not ensure compiledb toolchain script:', err.message);
  }
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
  const homedir = process.env.HOME || process.env.USERPROFILE || '~';
  const queryDriverGlob = `${homedir}/.platformio/packages/toolchain-*/bin/*,${homedir}/.platformio/packages/tool-*/bin/*`;
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
