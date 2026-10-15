import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const componentUrl = new URL('../src/ui/composer-utilities.jsx', import.meta.url);
const stylesUrl = new URL('../src/ui/styles.css', import.meta.url);
const composerUrl = new URL('../src/ui/index.jsx', import.meta.url);

test('voice input previews partial transcripts while recording and keeps the draft locked', async () => {
  const source = await readFile(componentUrl, 'utf8');
  const styles = await readFile(stylesUrl, 'utf8');
  const composer = await readFile(composerUrl, 'utf8');
  // The Host capture contract keeps the optional onPartial hook.
  assert.match(source, /voice\.start\(\{ onPartial: \(text\) =>/);
  // Partials only apply to the current generation (no cross-session bleed).
  assert.match(source, /onPartial[\s\S]*?generation\.current === expected/);
  // Partials are only a recording preview: the original draft stays untouched.
  assert.match(source, /function joinVoiceDraft\(base, text\)/);
  assert.match(source, /voiceBase\.current = String\(draft \|\| ''\)/);
  assert.match(source, /setPartial\(String\(text \|\| ''\)\)/);
  assert.match(source, /cwu-voice-preview/);
  // Recording locks the textarea through the Host-provided onRecordingChange callback.
  assert.match(source, /onRecordingChange\?\.\(true\)/);
  assert.match(composer, /onRecordingChange: setComposerReadOnly/);
  assert.match(composer, /readOnly=\{composerReadOnly\}/);
  assert.match(composer, /!composerReadOnly/);
  // Legacy stops restore the base draft plus the final transcript; errors restore the base.
  assert.match(source, /setDraft\(\(\) => joinVoiceDraft\(voiceBase\.current, result\)\)/);
  assert.match(source, /setError\(error\.message\); setRecording\(false\); setPartial\(''\); onRecordingChange\?\.\(false\); setDraft\(\(\) => voiceBase\.current\)/);
  // Recording state is a filled red pulsing button; no separate live-transcript element remains.
  assert.match(styles, /\.cwu-voice-input\.is-recording \{[^}]*background: var\(--cwu-error\)/);
  assert.match(styles, /\.cwu-voice-input\.is-recording:hover:not\(:disabled\) \{[^}]*background: var\(--cwu-error\)/);
  assert.match(styles, /@keyframes cwu-voice-pulse/);
  assert.doesNotMatch(source, /cwu-voice-live/);
  assert.doesNotMatch(styles, /\.cwu-voice-live/);
  // Utility errors are dismissable.
  assert.match(source, /aria-label="关闭提示" onClick=\{\(\) => setError\(''\)\}/);
});

test('voice recovery remains optional, is scoped to the active composer generation, and appends complete text', async () => {
  const source = await readFile(componentUrl, 'utf8');
  assert.match(source, /voice\?\.listRecoveries/);
  assert.match(source, /voice\.recover\(recovery\.id\)/);
  assert.match(source, /generation\.current !== expected\) return/);
  assert.match(source, /setDraft\(\(current\) => joinVoiceDraft\(current, text\)\)/);
  assert.match(source, /await voice\.acknowledgeRecovery\?\.\(recovery\.id\)/);
  assert.match(source, /await active\.acknowledge\?\.\(\)/);
  assert.match(source, /'重试转写'/);
  assert.match(source, /void refreshRecoveries\(expected\)/);
});

test('persistent voice tasks refresh through invalidation and only auto-insert an untouched stopped draft', async () => {
  const source = await readFile(componentUrl, 'utf8');
  const composer = await readFile(composerUrl, 'utf8');
  assert.match(source, /voice\.tasks\.subscribe\(\(\) => \{ void refreshTasks\(expected\); \}\)/);
  assert.match(source, /await voice\.tasks\.list\(\)/);
  assert.match(source, /const request = \+\+taskListRequest\.current/);
  assert.match(source, /taskListRequest\.current === request/);
  assert.match(source, /await voice\.tasks\.retry\(task\.id\)/);
  assert.match(source, /await voice\?\.tasks\?\.acknowledge\?\.\(task\.id\)/);
  assert.match(source, /result\.taskId/);
  assert.match(source, /pendingAutoInsert\.current = \{ id: result\.taskId, generation: expected, sessionId, revision: latestDraftRevision\.current \}/);
  assert.match(source, /automatic\.revision !== draftRevision/);
  assert.match(source, /insertedTaskIds\.current\.add\(task\.id\)/);
  assert.match(source, /task\.status === 'failed'/);
  assert.match(source, /'插入文字'/);
  assert.match(composer, /const \[draftRevision, setDraftRevision\] = useState\(0\)/);
  assert.match(composer, /draftRevision, setDraft/);
  assert.match(composer, /setDraftRevision\(\(current\) => current \+ 1\)/);
});
