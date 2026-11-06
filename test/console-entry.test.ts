import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consolePort } from '../src/console-entry.js';

test('console port rejects invalid configuration instead of silently selecting another listener', () => {
  const previous = process.env.STEWARD_CONSOLE_PORT;
  try {
    delete process.env.STEWARD_CONSOLE_PORT;
    assert.equal(consolePort(), 17831);
    process.env.STEWARD_CONSOLE_PORT = '17832';
    assert.equal(consolePort(), 17832);
    for (const value of ['', '0', '65536', '-1', '1.5', '1e4', '17832junk', ' 17832', 'Infinity', '127.0.0.1:17832']) {
      assert.throws(() => consolePort(value), /STEWARD_CONSOLE_PORT/);
    }
  } finally {
    if (previous === undefined) delete process.env.STEWARD_CONSOLE_PORT;
    else process.env.STEWARD_CONSOLE_PORT = previous;
  }
});
