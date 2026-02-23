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

export async function ensureClangdCompileCommandsDir(projectDir) {
  if (getActiveBackendId() !== 'clangd' || !projectDir) {
    return;
  }
  const config = vscode.workspace.getConfiguration('clangd');
  const currentArgs = config.get('arguments') || [];
  const compileCommandsFlag = `--compile-commands-dir=${projectDir}`;

  const existingIndex = currentArgs.findIndex((arg) =>
    arg.startsWith('--compile-commands-dir='),
  );
  const newArgs = [...currentArgs];
  if (existingIndex !== -1) {
    if (newArgs[existingIndex] === compileCommandsFlag) {
      return;
    }
    newArgs[existingIndex] = compileCommandsFlag;
  } else {
    newArgs.push(compileCommandsFlag);
  }

  await config.update(
    'arguments',
    newArgs,
    vscode.ConfigurationTarget.Workspace,
  );
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
