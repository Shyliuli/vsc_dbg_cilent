/**
 * Debug Adapter Protocol wire format: `Content-Length: N\r\n\r\n<json>`.
 *
 * gdb's DAP interpreter reads and writes exactly this framing on its stdin and
 * stdout, so the transport has to be byte exact: the length counts UTF-8 bytes,
 * not characters.
 */

export interface DapMessage {
  seq?: number;
  type?: string;
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: unknown;
  arguments?: unknown;
  [key: string]: unknown;
}

const HEADER_SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export class DapProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DapProtocolError';
  }
}

export function encodeDapMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

/** Incremental reader that accepts arbitrarily split stdout chunks. */
export class DapMessageReader {
  private buffer: Buffer = Buffer.alloc(0);
  private expectedBodyLength: number | null = null;

  feed(chunk: Buffer): DapMessage[] {
    if (chunk.length > 0) {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    }
    const messages: DapMessage[] = [];

    for (;;) {
      if (this.expectedBodyLength === null) {
        const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
        if (headerEnd === -1) {
          if (this.buffer.length > MAX_HEADER_BYTES) {
            throw new DapProtocolError(
              `DAP header exceeded ${MAX_HEADER_BYTES} bytes without a separator`,
            );
          }
          return messages;
        }
        const header = this.buffer.subarray(0, headerEnd).toString('ascii');
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header);
        if (!match) {
          throw new DapProtocolError(`DAP header is missing Content-Length: ${header}`);
        }
        const length = Number.parseInt(match[1], 10);
        if (!Number.isFinite(length) || length < 0 || length > MAX_BODY_BYTES) {
          throw new DapProtocolError(`DAP Content-Length out of range: ${match[1]}`);
        }
        this.expectedBodyLength = length;
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
      }

      if (this.buffer.length < this.expectedBodyLength) {
        return messages;
      }
      const body = this.buffer.subarray(0, this.expectedBodyLength).toString('utf8');
      this.buffer = this.buffer.subarray(this.expectedBodyLength);
      this.expectedBodyLength = null;
      try {
        messages.push(JSON.parse(body) as DapMessage);
      } catch (error) {
        throw new DapProtocolError(
          `DAP body is not valid JSON: ${(error as Error).message}; body=${body.slice(0, 200)}`,
        );
      }
    }
  }

  /** True when the reader holds a partial message. */
  get hasPartialMessage(): boolean {
    return this.expectedBodyLength !== null || this.buffer.length > 0;
  }
}
