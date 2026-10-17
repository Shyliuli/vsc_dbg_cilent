import { readdir, readFile, realpath, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { FileContent, FileEntry } from '../shared/types.ts';

const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024;
const HIDDEN_DIRECTORIES = new Set(['.git', 'node_modules', '.npm-cache', 'dist', '.scratch']);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.c': 'c',
  '.h': 'c',
  '.i': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.ipp': 'cpp',
  '.json': 'json',
  '.jsonc': 'json',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.md': 'markdown',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.css': 'css',
  '.html': 'html',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.S': 'asm',
  '.s': 'asm',
  '.asm': 'asm',
};

export function languageForPath(filePath: string): string {
  const ext = path.extname(filePath);
  if (ext === '.S' || ext === '.s') {
    return 'asm';
  }
  return LANGUAGE_BY_EXTENSION[ext] ?? 'plaintext';
}

/**
 * Filesystem access for the debugger front end.
 *
 * Read access is unrestricted (stack frames routinely point into system
 * headers outside the workspace). Write access is restricted to the workspace,
 * because the only writable surfaces are source files and launch.json.
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Resolve a workspace-relative path, rejecting escapes. */
  resolveInside(relativePath: string): string {
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      throw new Error('path is required');
    }
    if (path.isAbsolute(relativePath)) {
      throw new Error(`expected a workspace-relative path, got: ${relativePath}`);
    }
    const resolved = path.resolve(this.root, relativePath);
    if (!this.contains(resolved)) {
      throw new Error(`path escapes the workspace: ${relativePath}`);
    }
    return resolved;
  }

  contains(absolutePath: string): boolean {
    const resolved = path.resolve(absolutePath);
    return resolved === this.root || resolved.startsWith(this.root + path.sep);
  }

  toRelative(absolutePath: string): string {
    return path.relative(this.root, absolutePath);
  }

  async list(relativeDirectory = ''): Promise<FileEntry[]> {
    const directory = relativeDirectory ? this.resolveInside(relativeDirectory) : this.root;
    const info = await stat(directory).catch(() => null);
    if (!info?.isDirectory()) {
      throw new Error(`not a directory: ${relativeDirectory || '.'}`);
    }
    const entries = await readdir(directory, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && HIDDEN_DIRECTORIES.has(entry.name)) {
        continue;
      }
      if (entry.name === '.DS_Store') {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      const entryInfo = await stat(absolute).catch(() => null);
      if (!entryInfo) {
        continue;
      }
      result.push({
        name: entry.name,
        path: this.toRelative(absolute),
        type: entryInfo.isDirectory() ? 'directory' : 'file',
        size: entryInfo.size,
      });
    }
    result.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return result;
  }

  /** All files in the workspace, for the "Go to File" picker. */
  async listFiles(limit = 5000): Promise<string[]> {
    const files: string[] = [];
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (files.length >= limit || depth > 12) {
        return;
      }
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= limit) {
          return;
        }
        if (entry.name === '.DS_Store') {
          continue;
        }
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!HIDDEN_DIRECTORIES.has(entry.name)) {
            await walk(absolute, depth + 1);
          }
        } else if (entry.isFile()) {
          files.push(this.toRelative(absolute));
        }
      }
    };
    await walk(this.root, 0);
    files.sort();
    return files;
  }

  /** Read a text file. Relative paths resolve against the workspace root. */
  async readText(requestedPath: string): Promise<FileContent> {
    const absolute = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(this.root, requestedPath);
    const info = await stat(absolute).catch(() => null);
    if (!info) {
      throw new Error(`file not found: ${requestedPath}`);
    }
    if (!info.isFile()) {
      throw new Error(`not a regular file: ${requestedPath}`);
    }
    if (info.size > MAX_TEXT_FILE_BYTES) {
      throw new Error(
        `file is too large to open in the editor (${info.size} bytes, limit ${MAX_TEXT_FILE_BYTES})`,
      );
    }
    const buffer = await readFile(absolute);
    const binary = buffer.subarray(0, 8192).includes(0);
    return {
      path: absolute,
      content: binary ? '' : buffer.toString('utf8'),
      language: languageForPath(absolute),
      size: info.size,
      mtimeMs: info.mtimeMs,
      binary,
    };
  }

  /** Write a text file. Only paths inside the workspace are writable. */
  async writeText(requestedPath: string, content: string): Promise<FileContent> {
    if (typeof content !== 'string') {
      throw new Error('content must be a string');
    }
    const absolute = path.resolve(this.root, requestedPath);
    if (!this.contains(absolute)) {
      throw new Error(`refusing to write outside the workspace: ${requestedPath}`);
    }
    const parent = path.dirname(absolute);
    await mkdir(parent, { recursive: true });
    const parentReal = await realpath(parent).catch(() => parent);
    if (!this.contains(parentReal)) {
      throw new Error(`refusing to write through a symlink outside the workspace: ${requestedPath}`);
    }
    await writeFile(absolute, content, 'utf8');
    return this.readText(absolute);
  }
}
