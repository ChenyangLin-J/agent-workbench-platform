import React, { useEffect, useRef, useState } from 'react';

/** Shared input utilities. A Host supplies capture and authorized Session operations. */
export function SessionComposerUtilities({ voice = null, context = null, sessionId, setDraft, disabled = false, variant = 'actions' }) {
  const capture = useRef(null);
  const generation = useRef(0);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const dialog = useRef(null);
  useEffect(() => {
    generation.current++;
    capture.current?.dispose?.(); capture.current = null;
    setRecording(false); setBusy(false); setError(''); setOpen(false); setStatus(null);
    return () => { generation.current++; capture.current?.dispose?.(); capture.current = null; };
  }, [sessionId]);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  async function toggleVoice() {
    const expected = generation.current;
    setError(''); setBusy(true);
    try {
      if (capture.current) {
        const active = capture.current; capture.current = null; setRecording(false);
        const text = await active.stop();
        if (generation.current === expected && text) setDraft((draft) => `${draft || ''}${draft ? '\n' : ''}${String(text)}`);
      } else {
        const active = await voice.start();
        if (generation.current !== expected) { active?.dispose?.(); return; }
        if (!active || typeof active.stop !== 'function') throw new Error('语音输入未返回可停止的录音。');
        capture.current = active; setRecording(true);
      }
    } catch (error) { if (generation.current === expected) { setError(error.message); setRecording(false); } }
    finally { if (generation.current === expected) setBusy(false); }
  }
  async function readContext() {
    const expected = generation.current;
    setOpen(true); setBusy(true); setError('');
    try { const result = await context.onRead?.(); if (generation.current === expected) setStatus(result ?? null); }
    catch (error) { if (generation.current === expected) setError(error.message); }
    finally { if (generation.current === expected) setBusy(false); }
  }
  const usage = status?.tokenUsage || context?.usage;
  const used = Number(usage?.contextUsedTokens ?? usage?.usedTokens);
  const total = Number(usage?.modelContextWindow ?? usage?.contextWindow);
  const known = usage && Number.isFinite(used) && Number.isFinite(total) && total > 0;
  const percent = known ? Math.min(100, Math.round(used / total * 100)) : null;
  return <>
    {variant === 'actions' && voice?.start ? <button type="button" className={`cwu-voice-input${recording ? ' is-recording' : ''}`} aria-label={recording ? '结束录音并转写' : '语音输入'} title={recording ? '结束录音并转写' : '语音输入'} disabled={disabled || busy} onClick={toggleVoice}>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6"/></svg>
    </button> : null}
    {context ? <button type="button" className={`cwu-context-button is-${variant}`} onClick={readContext} title="查看上下文" aria-label="查看上下文"><span className="cwu-context-meter" style={{ '--context-percent': `${percent || 0}%` }} aria-hidden="true"/><span>上下文 {percent == null ? '未知' : `${percent}%`}</span></button> : null}
    {error && !open ? <span className="cwu-utility-error" role="alert">{error}</span> : null}
    {open ? <dialog className="cwu-session-finder cwu-context-dialog" ref={dialog} aria-label="当前会话上下文" onCancel={(event) => { event.preventDefault(); setOpen(false); }}>
      <header><strong>当前会话上下文</strong><button type="button" aria-label="关闭上下文" onClick={() => setOpen(false)}>×</button></header>
      <p>{known ? `${used.toLocaleString()} / ${total.toLocaleString()} tokens · ${percent}%` : '尚未获得上下文容量信息'}</p>
      {status?.model ? <p>模型：{status.model}</p> : null}
      {typeof status === 'string' ? <pre>{status}</pre> : null}
      {context.onCompact ? <button className="cwu-button" type="button" disabled={disabled || busy} onClick={async () => { setBusy(true); setError(''); try { await context.onCompact(); setStatus(await context.onRead?.()); } catch (error) { setError(error.message); } finally { setBusy(false); } }}>压缩上下文</button> : null}
      {busy ? <p role="status">处理中…</p> : null}{error ? <p role="alert">{error}</p> : null}
    </dialog> : null}
  </>;
}
