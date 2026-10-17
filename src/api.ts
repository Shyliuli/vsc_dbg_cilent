import type {
  EnvironmentInfo,
  FileContent,
  FileEntry,
  LaunchFileResult,
  ProcessInfo,
  WorkspaceInfo,
} from '../shared/types.ts';

class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload: any = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, `${method} ${url} returned non-JSON content`);
    }
  }
  if (!response.ok) {
    throw new ApiError(response.status, payload?.error ?? `${method} ${url} failed`);
  }
  return payload as T;
}

export const api = {
  workspace: () => request<WorkspaceInfo>('GET', '/api/workspace'),
  environment: () => request<EnvironmentInfo>('GET', '/api/environment'),
  tree: (path: string) =>
    request<{ entries: FileEntry[] }>('GET', `/api/tree?path=${encodeURIComponent(path)}`),
  files: () => request<{ files: string[] }>('GET', '/api/files'),
  file: (path: string) =>
    request<FileContent>('GET', `/api/file?path=${encodeURIComponent(path)}`),
  saveFile: (path: string, content: string) =>
    request<FileContent>('PUT', '/api/file', { path, content }),
  launch: (focusedFile?: string | null) =>
    request<LaunchFileResult>(
      'GET',
      `/api/launch${focusedFile ? `?file=${encodeURIComponent(focusedFile)}` : ''}`,
    ),
  saveLaunch: (content: string, focusedFile?: string | null) =>
    request<LaunchFileResult & { saved: true }>('PUT', '/api/launch', {
      content,
      file: focusedFile ?? undefined,
    }),
  processes: () => request<{ processes: ProcessInfo[] }>('GET', '/api/processes'),
};

export function dapSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/dap`;
}

export { ApiError };
