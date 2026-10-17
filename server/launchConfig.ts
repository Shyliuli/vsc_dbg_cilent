import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  parse,
  printParseErrorCode,
  type ParseError,
} from 'jsonc-parser';

import type {
  LaunchFileResult,
  NormalizedLaunchConfig,
  SetupCommand,
  StartupConsole,
} from '../shared/types.ts';

export const LAUNCH_RELATIVE_PATH = path.join('.vscode', 'launch.json');

interface SubstitutionContext {
  workspaceFolder: string;
  focusedFile?: string;
}

/**
 * Expand the VS Code variables that are meaningful to a debug configuration.
 * Unknown variables are left in place and reported, rather than silently
 * producing a wrong path.
 */
export function substituteVariables(
  value: string,
  context: SubstitutionContext,
  warnings: string[],
): string {
  const focusedFile = context.focusedFile;
  const workspaceFolder = context.workspaceFolder;
  return value.replace(/\$\{([^}]*)\}/g, (match, expression: string) => {
    switch (expression) {
      case 'workspaceFolder':
      case 'workspaceRoot':
        return workspaceFolder;
      case 'workspaceFolderBasename':
        return path.basename(workspaceFolder);
      case 'file':
        return focusedFile ?? '';
      case 'relativeFile':
        return focusedFile ? path.relative(workspaceFolder, focusedFile) : '';
      case 'fileBasename':
        return focusedFile ? path.basename(focusedFile) : '';
      case 'fileBasenameNoExtension':
        return focusedFile ? path.basename(focusedFile, path.extname(focusedFile)) : '';
      case 'fileDirname':
        return focusedFile ? path.dirname(focusedFile) : '';
      case 'fileExtname':
        return focusedFile ? path.extname(focusedFile) : '';
      case 'fileWorkspaceFolder':
        return workspaceFolder;
      default: {
        if (expression.startsWith('env:')) {
          const name = expression.slice('env:'.length);
          const environmentValue = process.env[name];
          if (environmentValue === undefined) {
            warnings.push(`environment variable is not set: ${name}`);
            return match;
          }
          return environmentValue;
        }
        warnings.push(`unsupported variable: \${${expression}}`);
        return match;
      }
    }
  });
}

/** Split a command-line string honoring single/double quotes and backslashes. */
export function splitCommandLine(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasContent = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === '\\' && (input[i + 1] === '"' || input[i + 1] === '\\')) {
        current += input[++i];
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (char === '\\' && i + 1 < input.length) {
      current += input[++i];
      hasContent = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (hasContent) {
        result.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }
  if (quote !== null) {
    throw new Error(`unterminated quote in command line: ${input}`);
  }
  if (hasContent) {
    result.push(current);
  }
  return result;
}

export function parseJsonc(text: string): { value: unknown; errors: string[] } {
  const parseErrors: ParseError[] = [];
  const value = parse(text, parseErrors, { allowTrailingComma: true, disallowComments: false });
  const errors = parseErrors.map((error) => {
    const location = offsetToLineColumn(text, error.offset);
    return `${printParseErrorCode(error.error)} at ${location.line}:${location.column}`;
  });
  return { value, errors };
}

function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

const PLATFORM_KEY =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';

/** VS Code merges the platform-specific property block into the configuration. */
function applyPlatformOverrides(raw: Record<string, unknown>): Record<string, unknown> {
  const platformBlock = raw[PLATFORM_KEY];
  if (!platformBlock || typeof platformBlock !== 'object') {
    return raw;
  }
  return { ...raw, ...(platformBlock as Record<string, unknown>) };
}

function asStringArray(value: unknown, field: string, warnings: string[]): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item !== 'string') {
        throw new Error(`${field} must be an array of strings`);
      }
      return item;
    });
  }
  if (typeof value === 'string') {
    warnings.push(`${field} should be an array of strings; the string was split on whitespace`);
    return splitCommandLine(value);
  }
  throw new Error(`${field} must be an array of strings`);
}

function asSetupCommands(value: unknown, field: string): SetupCommand[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof (entry as SetupCommand).text !== 'string') {
      throw new Error(`${field} entries must be objects with a "text" string`);
    }
    const command = entry as SetupCommand;
    return {
      text: command.text,
      description: command.description,
      ignoreFailures: command.ignoreFailures === true,
    };
  });
}

function asEnvironment(raw: Record<string, unknown>, warnings: string[]): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  let hasAny = false;

  const environment = raw.environment;
  if (environment !== undefined) {
    if (!Array.isArray(environment)) {
      throw new Error('environment must be an array of {name, value} objects');
    }
    for (const entry of environment) {
      const item = entry as { name?: unknown; value?: unknown };
      if (typeof item?.name !== 'string') {
        throw new Error('environment entries require a string "name"');
      }
      if (typeof item.value !== 'string') {
        throw new Error(`environment entry "${item.name}" requires a string "value"`);
      }
      merged[item.name] = item.value;
      hasAny = true;
    }
  }

  const env = raw.env;
  if (env !== undefined) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
      throw new Error('env must be an object mapping names to values');
    }
    for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
      if (value === null) {
        warnings.push(`gdb DAP cannot unset environment variable ${name}; it was ignored`);
        continue;
      }
      if (typeof value !== 'string') {
        throw new Error(`env value for ${name} must be a string`);
      }
      merged[name] = value;
      hasAny = true;
    }
  }

  return hasAny ? merged : undefined;
}

function normalizeConfig(
  rawConfig: unknown,
  index: number,
  context: SubstitutionContext,
  root: string,
): NormalizedLaunchConfig {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new Error('configuration must be an object');
  }
  const raw = applyPlatformOverrides(rawConfig as Record<string, unknown>);
  const warnings: string[] = [];
  const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : `Configuration ${index}`;
  const request = raw.request;
  if (request !== 'launch' && request !== 'attach') {
    throw new Error(`"${name}": request must be "launch" or "attach"`);
  }
  const type = typeof raw.type === 'string' ? raw.type : 'cppdbg';

  if (raw.MIMode !== undefined && String(raw.MIMode).toLowerCase() !== 'gdb') {
    throw new Error(`"${name}": only MIMode "gdb" is supported (got ${String(raw.MIMode)})`);
  }
  if (raw.externalConsole === true) {
    warnings.push('externalConsole is not supported; use "console": "integratedTerminal" instead');
  }
  let consoleMode: StartupConsole = 'internalConsole';
  if (raw.console === 'integratedTerminal') {
    consoleMode = 'integratedTerminal';
  } else if (raw.console !== undefined && raw.console !== 'internalConsole') {
    warnings.push(
      `console "${String(raw.console)}" is not supported; use internalConsole or integratedTerminal`,
    );
  }
  if (raw.preLaunchTask !== undefined) {
    warnings.push('preLaunchTask is not executed by this debugger; build the program beforehand');
  }
  if (raw.postDebugTask !== undefined) {
    warnings.push('postDebugTask is not executed by this debugger');
  }
  if (raw.pipeTransport !== undefined) {
    warnings.push('pipeTransport is not supported');
  }
  if (raw.symbolSearchPath !== undefined) {
    warnings.push('symbolSearchPath is not supported; use setupCommands instead');
  }

  const cwdValue =
    typeof raw.cwd === 'string' && raw.cwd.length > 0
      ? substituteVariables(raw.cwd, context, warnings)
      : context.workspaceFolder;
  const cwd = path.resolve(root, cwdValue);

  let program: string | undefined;
  if (typeof raw.program === 'string' && raw.program.length > 0) {
    program = path.resolve(cwd, substituteVariables(raw.program, context, warnings));
  } else if (request === 'launch') {
    throw new Error(`"${name}": "program" is required for a launch configuration`);
  }

  const args = asStringArray(raw.args, 'args', warnings).map((arg) =>
    substituteVariables(arg, context, warnings),
  );

  let miDebuggerPath = 'gdb';
  if (typeof raw.miDebuggerPath === 'string' && raw.miDebuggerPath.length > 0) {
    const expanded = substituteVariables(raw.miDebuggerPath, context, warnings);
    miDebuggerPath = expanded.includes('/') ? path.resolve(root, expanded) : expanded;
  }
  const miDebuggerArgs =
    typeof raw.miDebuggerArgs === 'string'
      ? splitCommandLine(raw.miDebuggerArgs)
      : asStringArray(raw.miDebuggerArgs, 'miDebuggerArgs', warnings);

  const setupCommands = asSetupCommands(raw.setupCommands, 'setupCommands');
  const legacySetupCommands = asSetupCommands(
    raw.customLaunchSetupCommands,
    'customLaunchSetupCommands',
  );
  setupCommands.push(...legacySetupCommands);

  const additionalSolibPath = raw.additionalSOLibSearchPath;
  if (additionalSolibPath !== undefined) {
    const parts = asStringArray(additionalSolibPath, 'additionalSOLibSearchPath', warnings).map(
      (part) => substituteVariables(part, context, warnings),
    );
    if (parts.length > 0) {
      setupCommands.unshift({ text: `set solib-search-path ${parts.join(path.delimiter)}` });
    }
  }

  const sourceFileMap: Record<string, string> = {};
  if (raw.sourceFileMap !== undefined) {
    if (!raw.sourceFileMap || typeof raw.sourceFileMap !== 'object' || Array.isArray(raw.sourceFileMap)) {
      throw new Error(`"${name}": sourceFileMap must be an object`);
    }
    for (const [from, to] of Object.entries(raw.sourceFileMap as Record<string, unknown>)) {
      if (typeof to !== 'string') {
        throw new Error(`"${name}": sourceFileMap values must be strings`);
      }
      sourceFileMap[from] = substituteVariables(to, context, warnings);
    }
  }

  let pid: number | undefined;
  let pickProcess = false;
  const rawPid = raw.processId ?? raw.pid;
  if (rawPid !== undefined) {
    const pidText = String(rawPid);
    if (pidText === '${command:pickProcess}') {
      pickProcess = true;
    } else if (/\$\{[^}]*\}/.test(pidText)) {
      throw new Error(`"${name}": unresolved variable in processId: ${pidText}`);
    } else {
      const parsed = Number.parseInt(pidText, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`"${name}": processId must be a positive integer`);
      }
      pid = parsed;
    }
  }

  let target: string | undefined;
  if (typeof raw.target === 'string' && raw.target.length > 0) {
    target = substituteVariables(raw.target, context, warnings);
  }

  if (request === 'attach' && pid === undefined && target === undefined && !pickProcess) {
    throw new Error(`"${name}": attach requires "processId" or "target"`);
  }

  const stopAtBeginningOfMainSubprogram =
    raw.stopAtBeginningOfMainSubprogram === true || raw.stopAtEntry === true;
  const stopOnEntry = raw.stopOnEntry === true;
  if (consoleMode === 'integratedTerminal' && request === 'attach') {
    warnings.push(
      'integratedTerminal is only available for launch configurations; falling back to internalConsole',
    );
    consoleMode = 'internalConsole';
  }

  return {
    index,
    name,
    type,
    request,
    program,
    args,
    cwd,
    env: asEnvironment(raw, warnings),
    stopAtBeginningOfMainSubprogram,
    stopOnEntry,
    console: consoleMode,
    miDebuggerPath,
    miDebuggerArgs,
    setupCommands,
    sourceFileMap,
    target,
    pid,
    pickProcess,
    warnings,
  };
}

export async function readLaunchFile(
  root: string,
  focusedFile?: string,
): Promise<LaunchFileResult> {
  const launchPath = path.join(root, LAUNCH_RELATIVE_PATH);
  const relativePath = LAUNCH_RELATIVE_PATH;
  const exists = Boolean(await stat(launchPath).catch(() => null));
  if (!exists) {
    return { exists: false, path: launchPath, relativePath, configs: [], errors: [] };
  }
  const text = await readFile(launchPath, 'utf8');
  const parsed = parseJsonc(text);
  if (parsed.errors.length > 0) {
    return { exists, path: launchPath, relativePath, configs: [], errors: parsed.errors };
  }
  const { configs, errors } = normalizeLaunchConfigurations(parsed.value, root, focusedFile);
  return {
    exists,
    path: launchPath,
    relativePath,
    configs,
    errors,
  };
}

export function normalizeLaunchConfigurations(
  value: unknown,
  root: string,
  focusedFile?: string,
): { configs: NormalizedLaunchConfig[]; errors: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('launch.json must contain a JSON object');
  }
  const configurations = (value as { configurations?: unknown }).configurations;
  if (configurations === undefined) {
    return { configs: [], errors: [] };
  }
  if (!Array.isArray(configurations)) {
    throw new Error('launch.json "configurations" must be an array');
  }
  const context: SubstitutionContext = { workspaceFolder: root, focusedFile };
  const configs: NormalizedLaunchConfig[] = [];
  const errors: string[] = [];
  configurations.forEach((config, index) => {
    try {
      configs.push(normalizeConfig(config, index, context, root));
    } catch (error) {
      const label =
        config && typeof config === 'object' && typeof (config as { name?: unknown }).name === 'string'
          ? `"${String((config as { name: string }).name)}" (configuration #${index + 1})`
          : `configuration #${index + 1}`;
      errors.push(`${label}: ${(error as Error).message}`);
    }
  });
  return { configs, errors };
}

export async function writeLaunchFile(
  root: string,
  content: string,
  focusedFile?: string,
): Promise<LaunchFileResult> {
  const launchPath = path.join(root, LAUNCH_RELATIVE_PATH);
  await mkdir(path.dirname(launchPath), { recursive: true });
  await writeFile(launchPath, content, 'utf8');
  return readLaunchFile(root, focusedFile);
}
