import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SessionBrowser } from './index.jsx';

export function useSessionHost(controller) {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

/** The common application tree; Hosts supply transport and product extension slots. */
export function SessionApplication({ controller = null, browser = {}, detail = null, actions = {}, extensions = {}, labels = {}, start = true, ...props }) {
  if (!controller) return <SessionBrowser browser={browser} detail={detail} actions={actions} extensions={extensions} labels={labels} {...props} />;
  return <ControlledApplication controller={controller} browser={browser} detail={detail} actions={actions} extensions={extensions} labels={labels} start={start} {...props} />;
}

function ControlledApplication({ controller, browser, detail, actions, extensions, labels, start, ...props }) {
  const state = useSessionHost(controller);
  const [finderOpen, setFinderOpen] = useState(false);
  const [listCollapsed, setListCollapsed] = useState(() => {
    try { return localStorage.getItem('agent-workbench.sidebar-collapsed') === '1'; } catch { return false; }
  });
  const toggleList = (collapsed) => {
    setListCollapsed(collapsed);
    try { localStorage.setItem('agent-workbench.sidebar-collapsed', collapsed ? '1' : '0'); } catch { /* Storage may be disabled. */ }
  };
  useEffect(() => {
    if (!start) return undefined;
    void controller.start().catch(() => {});
    return () => controller.dispose();
  }, [controller, start]);
  const suppliedBrowser = typeof browser === 'function' ? browser(state) : browser;
  const suppliedDetail = typeof detail === 'function' ? detail(state) : detail;
  const select = actions.onSelect || ((session) => controller.select(session.id || session.sessionId));
  const effectiveDetail = suppliedDetail ? { compactComposer: true, ...suppliedDetail } : null;
  return <div className="cwu-session-application"><SessionBrowser
    {...props}
    browser={{ sessions: state.sessions, selectedSessionId: state.selectedId, groupMode: 'time', listCollapsed, showSessionCount: false, ...suppliedBrowser }}
    detail={effectiveDetail}
    actions={{ onSelect: select, onCreate: () => controller.execute('create'), onToggleList: toggleList, ...actions, onOpenHistory: null,
      onOpenSessionFinder: () => setFinderOpen(true) }}
    extensions={extensions}
    labels={{ searchAriaLabel: '搜索与历史', searchPlaceholder: '搜索标题或正文', ...labels }}
  />{state.error ? <p className="cwu-host-error" role="alert">{state.error}</p> : null}{finderOpen ? <SessionFinder controller={controller} onClose={() => setFinderOpen(false)} onSelect={async (session) => { await select(session); setFinderOpen(false); }} /> : null}</div>;
}

export function SessionFinder({ controller, onClose, onSelect }) {
  const dialog = useRef(null);
  const input = useRef(null);
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState({ sessions: [], nextCursor: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestGeneration = useRef(0);
  useEffect(() => {
    const returnFocus = document.activeElement;
    dialog.current.showModal();
    input.current.focus();
    return () => { dialog.current?.close(); returnFocus?.focus?.(); };
  }, []);
  useEffect(() => {
    const controllerAbort = new AbortController();
    const generation = ++requestGeneration.current;
    setLoading(true);
    const timer = setTimeout(() => {
      Promise.resolve(controller.searchSessions({ query: query.trim(), archived, signal: controllerAbort.signal }))
        .then((result) => { if (generation === requestGeneration.current && !controllerAbort.signal.aborted) { setPage(Array.isArray(result) ? { sessions: result } : result); setError(''); } })
        .catch((error) => { if (!controllerAbort.signal.aborted) setError(error.message); })
        .finally(() => { if (generation === requestGeneration.current) setLoading(false); });
    }, query ? 200 : 0);
    return () => { controllerAbort.abort(); clearTimeout(timer); };
  }, [controller, query, archived]);
  async function loadMore() {
    if (!page.nextCursor || loading) return;
    const generation = requestGeneration.current;
    setLoading(true);
    try {
      const result = await controller.searchSessions({ query: query.trim(), archived, cursor: page.nextCursor });
      if (generation !== requestGeneration.current) return;
      if (result.nextCursor === page.nextCursor) throw new Error('历史分页游标未前进。');
      setPage((previous) => ({ ...result, sessions: [...new Map([...(previous.sessions || []), ...(result.sessions || [])].map((session) => [session.sessionId || session.id, session])).values()] }));
    } catch (error) { if (generation === requestGeneration.current) setError(error.message); }
    finally { if (generation === requestGeneration.current) setLoading(false); }
  }
  return <dialog className="cwu-session-finder" ref={dialog} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === dialog.current) onClose(); }} aria-label="搜索与历史">
    <header><strong>搜索与历史</strong><button type="button" aria-label="关闭搜索与历史" onClick={onClose}>×</button></header>
    <label className="cwu-finder-query"><input ref={input} type="search" placeholder="搜索标题或正文" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索标题或正文" /></label>
    <label className="cwu-finder-archive"><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />包含已归档</label>
    <div className="cwu-finder-results" aria-busy={loading}>
      {(page.sessions || []).map((session) => <button type="button" key={session.sessionId || session.id} onClick={() => Promise.resolve(onSelect(session)).catch((error) => setError(error.message))}>
        <strong>{session.title || '新对话'}</strong><small>{session.contextLabel || ''}{session.archived ? ' · 已归档' : ''}</small>{session.snippet ? <p>{session.snippet}</p> : null}
      </button>)}
      {!page.sessions?.length && !loading ? <p>{query ? '没有匹配的对话' : '暂无历史对话'}</p> : null}
      {page.nextCursor ? <button type="button" disabled={loading} onClick={loadMore}>加载更多历史</button> : null}
    </div>
    {loading ? <p role="status">正在读取…</p> : null}{error ? <p role="alert">{error}</p> : null}
  </dialog>;
}
