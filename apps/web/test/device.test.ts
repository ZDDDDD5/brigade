import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectDevice } from '../lib/device'

test('Windows is told apart from the other devices', () => {
  const chrome = (platform: string) =>
    `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`
  assert.equal(detectDevice(chrome('Windows NT 10.0; Win64; x64')), 'windows')
  assert.equal(detectDevice(chrome('Macintosh; Intel Mac OS X 10_15_7')), 'mac')
  assert.equal(detectDevice(chrome('X11; Linux x86_64')), 'linux')
  // A Chromebook says X11 too: its terminal runs no command until Linux is turned on.
  assert.equal(detectDevice(chrome('X11; CrOS x86_64 14541.0.0')), 'chromeos')
  assert.equal(detectDevice(chrome('Linux; Android 14; Pixel 8')), 'other')
  assert.equal(detectDevice(chrome('iPhone; CPU iPhone OS 18_0 like Mac OS X')), 'other')
})
