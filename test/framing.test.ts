import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DapMessageReader,
  DapProtocolError,
  encodeDapMessage,
} from '../server/dap/framing.ts';

const decode = (frames: Buffer[]) => {
  const reader = new DapMessageReader();
  return frames.flatMap((frame) => reader.feed(frame));
};

test('round-trips a single message', () => {
  const message = { seq: 1, type: 'request', command: 'initialize', arguments: { a: 1 } };
  const messages = decode([encodeDapMessage(message)]);
  assert.deepEqual(messages, [message]);
});

test('multi-byte characters are measured in bytes, not code points', () => {
  const message = { seq: 7, type: 'event', event: 'output', body: { output: '变量 = 5\n' } };
  const encoded = encodeDapMessage(message);
  const declared = Number(/Content-Length: (\d+)/.exec(encoded.toString('ascii'))?.[1]);
  const body = JSON.stringify(message);
  assert.equal(declared, Buffer.byteLength(body, 'utf8'));
  assert.notEqual(declared, body.length);
  assert.deepEqual(decode([encoded]), [message]);
});

test('handles two messages arriving in one chunk', () => {
  const first = { seq: 1, type: 'request', command: 'threads' };
  const second = { seq: 2, type: 'event', event: 'stopped', body: { threadId: 1 } };
  assert.deepEqual(decode([Buffer.concat([encodeDapMessage(first), encodeDapMessage(second)])]), [
    first,
    second,
  ]);
});

test('handles a message split across arbitrary byte boundaries', () => {
  const message = { seq: 3, type: 'response', request_seq: 1, success: true, body: { x: 'y' } };
  const frame = encodeDapMessage(message);
  for (let split = 1; split < frame.length; split++) {
    assert.deepEqual(
      decode([frame.subarray(0, split), frame.subarray(split)]),
      [message],
      `split at ${split}`,
    );
  }
  const reader = new DapMessageReader();
  const oneByteAtATime = [...frame].flatMap((byte) => reader.feed(Buffer.from([byte])));
  assert.deepEqual(oneByteAtATime, [message]);
});

test('rejects a header without Content-Length', () => {
  const reader = new DapMessageReader();
  assert.throws(
    () => reader.feed(Buffer.from('X-Nope: 1\r\n\r\n', 'ascii')),
    (error: unknown) => error instanceof DapProtocolError && /Content-Length/.test(error.message),
  );
});

test('rejects invalid JSON bodies', () => {
  const reader = new DapMessageReader();
  const bad = Buffer.concat([Buffer.from('Content-Length: 5\r\n\r\n'), Buffer.from('{oops')]);
  assert.throws(
    () => reader.feed(bad),
    (error: unknown) => error instanceof DapProtocolError && /valid JSON/.test(error.message),
  );
});

test('keeps partial state between feeds', () => {
  const reader = new DapMessageReader();
  const partial = encodeDapMessage({ seq: 1, type: 'request', command: 'continue' });
  assert.deepEqual(reader.feed(partial.subarray(0, 10)), []);
  assert.equal(reader.hasPartialMessage, true);
  assert.deepEqual(reader.feed(partial.subarray(10)), [
    { seq: 1, type: 'request', command: 'continue' },
  ]);
  assert.equal(reader.hasPartialMessage, false);
});
