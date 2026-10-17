import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  WATCHPOINT_ACCESS,
  parseWatchpointList,
  parseWatchpointNumber,
  watchpointAccessLabel,
  watchpointCommand,
} from '../shared/watchpoints.ts';

test('maps data breakpoint access types to gdb watchpoint commands', () => {
  assert.equal(watchpointCommand('write', 'counter'), 'watch counter');
  assert.equal(watchpointCommand('read', ' counter '), 'rwatch counter');
  assert.equal(watchpointCommand('readWrite', 'values[2]'), 'awatch values[2]');
  assert.equal(watchpointAccessLabel('write'), 'Write');
  assert.equal(watchpointAccessLabel('read'), 'Read');
  assert.equal(watchpointAccessLabel('readWrite'), 'Read/Write');
  assert.equal(WATCHPOINT_ACCESS.readWrite.command, 'awatch');
});

test('parses watchpoint numbers from creation output', () => {
  assert.equal(parseWatchpointNumber('Hardware watchpoint 2: counter\n'), 2);
  assert.equal(parseWatchpointNumber('Software watchpoint 11: values[0]'), 11);
  assert.equal(parseWatchpointNumber('Watchpoint 3: point.x'), 3);
  assert.equal(parseWatchpointNumber('No symbol "missing" in current context.'), null);
  assert.equal(parseWatchpointNumber(''), null);
});

test('falls back to info watchpoints when the creation output is unavailable', () => {
  const output = [
    'Num     Type           Disp Enb Address            What',
    '1       breakpoint     keep y   0x0000000000001234 in main at src/main.cpp:58',
    '2       hw watchpoint  keep y                      counter',
    '3       hw watchpoint  keep y                      point.x',
  ].join('\n');
  assert.equal(parseWatchpointList(output, 'counter'), 2);
  assert.equal(parseWatchpointList(output, 'point.x'), 3);
  assert.equal(parseWatchpointList(output, 'missing'), null);
});
