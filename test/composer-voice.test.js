import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const componentUrl = new URL('../src/ui/composer-utilities.jsx', import.meta.url);
const stylesUrl = new URL('../src/ui/styles.css', import.meta.url);
const composerUrl = new URL('../src/ui/index.jsx', import.meta.url);

test('voice input streams live partial transcripts into the draft and locks the composer', async () => {
  const source = await readFile(componentUrl, 'utf8');
  const styles = await readFile(stylesUrl, 'utf8');
  const composer = await readFile(composerUrl, 'utf8');
  // The Host capture contract keeps the optional onPartial hook.
  assert.match(source, /voice\.start\(\{ onPartial: \(text\) =>/);
  // Partials only apply to the current generation (no cross-session bleed).
  assert.match(source, /onPartial[\s\S]*?generation\.current === expected/);
  // Partials prefill the draft on top of the draft captured when recording started.
  assert.match(source, /function joinVoiceDraft\(base, text\)/);
  assert.match(source, /voiceBase\.current = String\(draft \|\| ''\)/);
  assert.match(source, /setDraft\(\(\) => joinVoiceDraft\(voiceBase\.current, text\)\)/);
  // Recording locks the textarea through the Host-provided onRecordingChange callback.
  assert.match(source, /onRecordingChange\?\.\(true\)/);
  assert.match(composer, /onRecordingChange: setComposerReadOnly/);
  assert.match(composer, /readOnly=\{composerReadOnly\}/);
  assert.match(composer, /!composerReadOnly/);
  // Stopping restores the base draft plus the final transcript; errors revert the prefill.
  assert.match(source, /setDraft\(\(\) => joinVoiceDraft\(voiceBase\.current, text\)\)/);
  assert.match(source, /setError\(error\.message\); setRecording\(false\); onRecordingChange\?\.\(false\); setDraft\(\(\) => voiceBase\.current\)/);
  // Recording state is a filled red pulsing button; no separate live-transcript element remains.
  assert.match(styles, /\.cwu-voice-input\.is-recording \{[^}]*background: var\(--cwu-error\)/);
  assert.match(styles, /@keyframes cwu-voice-pulse/);
  assert.doesNotMatch(source, /cwu-voice-live/);
  assert.doesNotMatch(styles, /\.cwu-voice-live/);
  // Utility errors are dismissable.
  assert.match(source, /aria-label="关闭提示" onClick=\{\(\) => setError\(''\)\}/);
});
