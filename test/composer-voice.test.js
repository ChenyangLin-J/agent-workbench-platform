import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const componentUrl = new URL('../src/ui/composer-utilities.jsx', import.meta.url);
const stylesUrl = new URL('../src/ui/styles.css', import.meta.url);

test('voice input streams live partial transcripts next to the recording button', async () => {
  const source = await readFile(componentUrl, 'utf8');
  const styles = await readFile(stylesUrl, 'utf8');
  // The Host capture contract gains an optional onPartial hook.
  assert.match(source, /voice\.start\(\{ onPartial: \(text\) =>/);
  // Partials only apply to the current generation (no cross-session bleed).
  assert.match(source, /onPartial[\s\S]*?generation\.current === expected/);
  // While recording, the latest partial (or a waiting hint) is visible.
  assert.match(source, /className="cwu-voice-live" role="status"/);
  assert.match(source, /\{liveTranscript \|\| '正在录音…'\}/);
  // Stopping, failing, or switching sessions clears the live line.
  assert.match(source, /setRecording\(false\); setLiveTranscript\(''\)/);
  assert.match(source, /setError\(error\.message\); setRecording\(false\); setLiveTranscript\(''\)/);
  assert.match(styles, /\.cwu-voice-live/);
});
