import React, { useEffect, useRef, useState } from 'react';
import { composerContextPresentation } from './model.js';

function joinVoiceDraft(base, text) {
  const transcript = String(text || '');
  if (!base) return transcript;
  return transcript ? `${base}\n${transcript}` : base;
}

function isVoiceTask(value) { return value && typeof value === 'object' && typeof value.id === 'string'; }
function voiceTaskLabel(task) {
  if (task.stage === 'uploading' || task.status === 'queued') return '正在上传…';
  if (task.status === 'transcribing') return '正在转写…';
  return '';
}

/** Shared input utilities. A Host supplies capture and authorized Session operations. */
export function SessionComposerUtilities({ voice = null, context = null, sessionId, draft = '', draftRevision = 0, setDraft, onRecordingChange = null, disabled = false, variant = 'actions' }) {
  const capture = useRef(null);
  const generation = useRef(0);
  const contextRequest = useRef(0);
  const voiceBase = useRef('');
  const latestDraftRevision = useRef(draftRevision);
  const pendingAutoInsert = useRef(null);
  const insertedTaskIds = useRef(new Set());
  const taskListRequest = useRef(0);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [partial, setPartial] = useState('');
  const [recoveries, setRecoveries] = useState([]);
  const [recoveringId, setRecoveringId] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [retryingTaskIds, setRetryingTaskIds] = useState(() => new Set());
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const dialog = useRef(null);
  const hasVoiceTasks = typeof voice?.tasks?.list === 'function';

  useEffect(() => { latestDraftRevision.current = draftRevision; }, [draftRevision]);
  useEffect(() => {
    const expected = ++generation.current;
    capture.current?.dispose?.(); capture.current = null;
    pendingAutoInsert.current = null;
    insertedTaskIds.current = new Set();
    taskListRequest.current++;
    setRecording(false); setBusy(false); setError(''); setPartial(''); setRecoveries([]); setRecoveringId(null); setTasks([]); setRetryingTaskIds(new Set()); setOpen(false); setStatus(null);
    onRecordingChange?.(false);
    void refreshRecoveries(expected);
    void refreshTasks(expected);
    const unsubscribe = hasVoiceTasks && typeof voice.tasks.subscribe === 'function'
      ? voice.tasks.subscribe(() => { void refreshTasks(expected); })
      : null;
    return () => { generation.current++; capture.current?.dispose?.(); capture.current = null; unsubscribe?.(); onRecordingChange?.(false); };
  }, [sessionId]);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  useEffect(() => {
    const automatic = pendingAutoInsert.current;
    if (!automatic || automatic.generation !== generation.current || automatic.sessionId !== sessionId || automatic.revision !== draftRevision) return;
    const task = tasks.find((candidate) => candidate.id === automatic.id);
    if (task?.status === 'completed' && task.text) void insertTask(task, true, automatic.generation);
  }, [tasks, draftRevision, sessionId]);

  async function refreshRecoveries(expected = generation.current) {
    if (typeof voice?.listRecoveries !== 'function') return;
    try {
      const items = await voice.listRecoveries();
      if (generation.current === expected) setRecoveries(Array.isArray(items) ? items : []);
    } catch { /* A recovery read must not replace the capture error. */ }
  }
  async function refreshTasks(expected = generation.current) {
    if (typeof voice?.tasks?.list !== 'function') return;
    const request = ++taskListRequest.current;
    try {
      const items = await voice.tasks.list();
      if (generation.current === expected && taskListRequest.current === request) setTasks(Array.isArray(items) ? items.filter(isVoiceTask) : []);
    } catch { /* A task read must not replace the capture error. */ }
  }
  async function acknowledgeTask(task) {
    const expected = generation.current;
    try { await voice?.tasks?.acknowledge?.(task.id); } catch { /* Do not insert the same task again when acknowledgement fails. */ }
    if (generation.current === expected) void refreshTasks(expected);
  }
  async function insertTask(task, automatic = false, expected = generation.current) {
    if (!isVoiceTask(task) || !task.text || insertedTaskIds.current.has(task.id)) return;
    const pending = pendingAutoInsert.current;
    if (automatic && (!pending || pending.id !== task.id || pending.generation !== expected || pending.sessionId !== sessionId || pending.revision !== latestDraftRevision.current)) return;
    if (generation.current !== expected) return;
    insertedTaskIds.current.add(task.id);
    if (pending?.id === task.id) pendingAutoInsert.current = null;
    setDraft((current) => joinVoiceDraft(current, task.text));
    await acknowledgeTask(task);
  }
  async function toggleVoice() {
    const expected = generation.current;
    setError(''); setBusy(true);
    try {
      if (capture.current) {
        const active = capture.current; capture.current = null;
        const result = await active.stop();
        if (generation.current !== expected) return;
        setRecording(false); setPartial(''); onRecordingChange?.(false);
        if (result && typeof result === 'object' && typeof result.taskId === 'string') {
          // stop() resolves only after microphone ownership has ended. The task continues independently.
          pendingAutoInsert.current = { id: result.taskId, generation: expected, sessionId, revision: latestDraftRevision.current };
          void refreshTasks(expected);
        } else {
          setDraft(() => joinVoiceDraft(voiceBase.current, result));
          try { await active.acknowledge?.(); } catch { /* Keep the completed recording recoverable if cleanup fails. */ }
        }
      } else {
        pendingAutoInsert.current = null;
        voiceBase.current = String(draft || '');
        setPartial('');
        onRecordingChange?.(true);
        const active = await voice.start({ onPartial: (text) => { if (generation.current === expected) setPartial(String(text || '')); } });
        if (generation.current !== expected) { active?.dispose?.(); return; }
        if (!active || typeof active.stop !== 'function') throw new Error('语音输入未返回可停止的录音。');
        capture.current = active; setRecording(true);
      }
    } catch (error) { if (generation.current === expected) { setError(error.message); setRecording(false); setPartial(''); onRecordingChange?.(false); setDraft(() => voiceBase.current); void refreshRecoveries(expected); void refreshTasks(expected); } }
    finally { if (generation.current === expected) setBusy(false); }
  }
  async function retryTask(task) {
    if (!isVoiceTask(task) || typeof voice?.tasks?.retry !== 'function' || retryingTaskIds.has(task.id)) return;
    const expected = generation.current;
    setError(''); setRetryingTaskIds((current) => new Set(current).add(task.id));
    try { await voice.tasks.retry(task.id); if (generation.current === expected) await refreshTasks(expected); }
    catch (error) { if (generation.current === expected) setError(error.message); }
    finally { if (generation.current === expected) setRetryingTaskIds((current) => { const next = new Set(current); next.delete(task.id); return next; }); }
  }
  async function recoverVoice(recovery) {
    const expected = generation.current;
    if (recording || busy || recoveringId || !recovery?.id || typeof voice?.recover !== 'function') return;
    setBusy(true); setRecoveringId(recovery.id); setError('');
    try {
      const text = await voice.recover(recovery.id);
      if (generation.current !== expected) return;
      setDraft((current) => joinVoiceDraft(current, text));
      try { await voice.acknowledgeRecovery?.(recovery.id); } catch { /* Keep the recovery when cleanup fails. */ }
      await refreshRecoveries(expected);
    } catch (error) { if (generation.current === expected) setError(error.message); }
    finally { if (generation.current === expected) { setBusy(false); setRecoveringId(null); } }
  }
  async function readContext() {
    const expected = generation.current;
    const request = ++contextRequest.current;
    const usageAtRead = context?.usage;
    setOpen(true); setBusy(true); setError('');
    try { const snapshot = await context.onRead?.(); if (generation.current === expected && contextRequest.current === request) setStatus({ snapshot: snapshot ?? null, usageAtRead }); }
    catch (error) { if (generation.current === expected && contextRequest.current === request) setError(error.message); }
    finally { if (generation.current === expected && contextRequest.current === request) setBusy(false); }
  }
  async function compactContext() {
    const expected = generation.current;
    const request = ++contextRequest.current;
    const usageAtRead = context?.usage;
    setBusy(true); setError('');
    try {
      await context.onCompact();
      if (generation.current !== expected || contextRequest.current === request) return;
      const snapshot = await context.onRead?.();
      if (generation.current !== expected || contextRequest.current === request) setStatus({ snapshot: snapshot ?? null, usageAtRead });
    } catch (error) { if (generation.current === expected && contextRequest.current === request) setError(error.message); }
    finally { if (generation.current === expected && contextRequest.current === request) setBusy(false); }
  }
  const { percent, label, description } = composerContextPresentation(context, status);
  return <>
    {variant === 'actions' && voice?.start ? <button type="button" className={`cwu-voice-input${recording ? ' is-recording' : ''}`} aria-label={recording ? '结束录音并转写' : '语音输入'} title={recording ? '结束录音并转写' : '语音输入'} disabled={disabled || busy} onClick={toggleVoice}>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6"/></svg>
    </button> : null}
    {recording && partial ? <span className="cwu-voice-preview" role="status">{partial}</span> : null}
    {tasks.length ? <span className="cwu-voice-tasks" role="status">{tasks.map((task) => {
      const taskLabel = voiceTaskLabel(task);
      if (taskLabel) return <span key={task.id}>{taskLabel}</span>;
      if (task.status === 'failed') return <span key={task.id}>{task.error ? <span className="cwu-utility-error" role="alert">{task.error}</span> : null}<button type="button" aria-label={`重试转写 ${task.createdAt || task.id}`} disabled={disabled || retryingTaskIds.has(task.id)} onClick={() => retryTask(task)}>{retryingTaskIds.has(task.id) ? '正在转写…' : '重试转写'}</button></span>;
      if (task.status === 'completed' && task.text) return <button key={task.id} type="button" disabled={disabled || insertedTaskIds.current.has(task.id)} onClick={() => void insertTask(task)}>{insertedTaskIds.current.has(task.id) ? '已插入' : '插入文字'}</button>;
      if (task.status === 'completed') return <button key={task.id} type="button" disabled={disabled} onClick={() => void acknowledgeTask(task)}>未识别到文字，关闭</button>;
      return null;
    })}</span> : null}
    {recoveries.length ? <span className="cwu-voice-recoveries" role="status">{recoveries.map((recovery) => <button key={recovery.id} type="button" aria-label={`重试转写 ${recovery.createdAt || recovery.id}`} disabled={disabled || busy || recording} onClick={() => recoverVoice(recovery)}>{recoveringId === recovery.id ? '正在转写…' : '重试转写'}</button>)}</span> : null}
    {context ? <button type="button" className={`cwu-context-button is-${variant}`} onClick={readContext} title="查看上下文" aria-label="查看上下文"><span className="cwu-context-meter" style={{ '--context-percent': `${percent || 0}%` }} aria-hidden="true"/><span>上下文 {label}</span></button> : null}
    {error && !open ? <span className="cwu-utility-error" role="alert">{error}<button type="button" aria-label="关闭提示" onClick={() => setError('')}>×</button></span> : null}
    {open ? <dialog className="cwu-session-finder cwu-context-dialog" ref={dialog} aria-label="当前会话上下文" onCancel={(event) => { event.preventDefault(); setOpen(false); }}>
      <header><strong>当前会话上下文</strong><button type="button" aria-label="关闭上下文" onClick={() => setOpen(false)}>×</button></header>
      <p>{description}</p>
      {status?.snapshot?.model ? <p>模型：{status.snapshot.model}</p> : null}
      {typeof status?.snapshot === 'string' ? <pre>{status.snapshot}</pre> : null}
      {context.onCompact ? <button className="cwu-button" type="button" disabled={disabled || busy} onClick={compactContext}>压缩上下文</button> : null}
      {busy ? <p role="status">处理中…</p> : null}{error ? <p role="alert">{error}</p> : null}
    </dialog> : null}
  </>;
}
