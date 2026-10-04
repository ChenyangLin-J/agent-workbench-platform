import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

class Element extends EventTarget {
  dataset = {}; value = 'juniper'; open = false;
  classList = { toggle() {} };
  replaceChildren() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}

test('realtime opening reads voices without capture and disposal stops an active conversation once', async () => {
  const window = {};
  vm.runInNewContext(await readFile(new URL('../src/browser/realtime-controller.js', import.meta.url), 'utf8'), { window, document: { createElement: () => new Element() } });
  const sent = [];
  const controller = window.AgentRealtime.create({
    ...Object.fromEntries(['launchButton', 'dialog', 'dismissButton', 'startButton', 'stopButton', 'fallbackButton', 'voiceSelect', 'statusElement', 'transcriptElement', 'errorElement', 'outputAudio'].map(key => [key, new Element()])),
    send: message => { sent.push(message.type); return true; },
  });
  controller.install(); controller.setEnabled(true); controller.open();
  assert.deepEqual(sent, ['realtime-voices']);
  controller.handleMessage('realtime-state', { status: 'live', transcript: [] });
  assert.equal(controller.isBusy(), true);
  controller.dispose(); controller.dispose();
  assert.equal(controller.isBusy(), false);
  assert.deepEqual(sent, ['realtime-voices', 'realtime-stop']);
});
