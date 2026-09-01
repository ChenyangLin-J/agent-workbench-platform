import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { SessionBrowser } from '../ui/index.jsx';
import { minimalHostSessionPresentation, selectMinimalHostSession } from './host-presentation.js';
import '../ui/styles.css';
import './assets/host.css';

const bootstrap = globalThis.__AGENT_WORKBENCH_BOOTSTRAP__ || {};

function MinimalHostApp() {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [session, setSession] = useState(null);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [error, setError] = useState('');
  const refreshTimer = useRef(null);
  const refreshRunning = useRef(false);
  const refreshQueued = useRef(false);

  const request = useCallback(async (path, options = {}) => {
    const response = await fetch(path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        'x-agent-workbench-token': bootstrap.accessToken || '',
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || `Request failed (${response.status})`);
    return body;
  }, []);

  const refreshSessions = useCallback(async () => {
    const body = await request('/api/sessions');
    const nextSessions = (body.sessions || []).map(minimalHostSessionPresentation);
    setSessions(nextSessions);
    setSelectedId((current) => selectMinimalHostSession(nextSessions, current));
    return nextSessions;
  }, [request]);

  const refreshSession = useCallback(async (sessionId = selectedId) => {
    if (!sessionId) return null;
    const body = await request(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const nextSession = minimalHostSessionPresentation(body.session);
    setSession(nextSession);
    return nextSession;
  }, [request, selectedId]);

  const scheduleRefresh = useCallback(() => {
    refreshQueued.current = true;
    if (refreshTimer.current || refreshRunning.current) return;
    refreshTimer.current = setTimeout(async () => {
      refreshTimer.current = null;
      refreshQueued.current = false;
      refreshRunning.current = true;
      try {
        await refreshSessions();
        await refreshSession();
        setError('');
      } catch (nextError) {
        setError(nextError.message);
      } finally {
        refreshRunning.current = false;
        if (refreshQueued.current) scheduleRefresh();
      }
    }, 180);
  }, [refreshSession, refreshSessions]);

  useEffect(() => {
    refreshSessions().catch((nextError) => setError(nextError.message));
    return () => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      refreshQueued.current = false;
    };
  }, [refreshSessions]);

  useEffect(() => {
    if (!selectedId) {
      setSession(null);
      return undefined;
    }
    refreshSession(selectedId).catch((nextError) => setError(nextError.message));
    const controller = new AbortController();
    void streamEvents(selectedId, controller.signal, scheduleRefresh).catch((nextError) => {
      if (nextError.name !== 'AbortError') setError(nextError.message);
    });
    return () => controller.abort();
  }, [refreshSession, scheduleRefresh, selectedId]);

  async function createSession() {
    setError('');
    try {
      const body = await request('/api/sessions', { method: 'POST', body: JSON.stringify({}) });
      await refreshSessions();
      setSelectedId(body.session.sessionId);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function submit({ prompt, mode }) {
    setError('');
    try {
      await request(`/api/sessions/${encodeURIComponent(selectedId)}/turns`, {
        method: 'POST',
        body: JSON.stringify({ prompt, mode }),
      });
      setSession((current) => current ? { ...current, status: 'running', statusLabel: '正在处理' } : current);
      scheduleRefresh();
    } catch (nextError) {
      setError(nextError.message);
      throw nextError;
    }
  }

  async function interrupt() {
    const expectedTurnId = session?.runtimeBinding?.activeTurnId;
    if (!expectedTurnId) return;
    await request(`/api/sessions/${encodeURIComponent(selectedId)}/interrupt`, {
      method: 'POST',
      body: JSON.stringify({ expectedTurnId }),
    });
  }

  async function respondToRequest({ token, decision, answers }) {
    await request(`/api/sessions/${encodeURIComponent(selectedId)}/requests/${encodeURIComponent(token)}`, {
      method: 'POST',
      body: JSON.stringify({ response: answers ? { answers } : { decision } }),
    });
    scheduleRefresh();
  }

  const detail = useMemo(() => session ? {
    session,
    features: {
      attachments: false,
      externalLink: false,
      realtime: false,
      sessionStatus: false,
      sideChats: false,
      steer: false,
      subagents: false,
      technicalDetails: false,
    },
    actions: {
      onSubmit: submit,
      onInterrupt: session.status === 'running' ? interrupt : null,
      onRespondToRequest: respondToRequest,
      onError: (nextError) => setError(nextError.message),
    },
    labels: {
      composerPlaceholder: '输入问题……',
      emptyTitle: '开始对话',
      emptyBody: '直接输入问题即可开始。',
    },
  } : null, [session, selectedId]);

  const runtimeError = session?.status === 'error' ? session.runtimeBinding?.lastError : '';
  const visibleError = error || runtimeError;

  return (
    <main className="awb-minimal-host">
      <SessionBrowser
        actions={{
          onCreate: createSession,
          onSelect: (nextSession) => setSelectedId(nextSession.id),
          onToggleList: setListCollapsed,
        }}
        browser={{
          sessions,
          selectedSessionId: selectedId,
          listCollapsed,
          groupMode: 'time',
          groupOptions: [{ id: 'time', label: '最近' }],
          createTargets: [{ id: 'environment', label: '对话' }],
          showCreateTargetSelect: false,
        }}
        detail={detail}
        labels={{
          countSuffix: '个对话',
          createLabel: '新建对话',
          createAriaLabel: '新建对话',
          detailEmptyTitle: '新建一个对话',
          detailEmptyBody: '输入问题后即可开始。',
          collapseList: '收起对话列表',
          expandList: '展开对话列表',
          listAriaLabel: '对话列表',
          searchAriaLabel: '搜索对话',
          searchPlaceholder: '搜索对话',
        }}
      />
      {visibleError ? <div className="awb-host-error" role="alert">{visibleError}</div> : null}
    </main>
  );
}

async function streamEvents(sessionId, signal, onEvent) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
    headers: { 'x-agent-workbench-token': bootstrap.accessToken || '' },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`Event stream failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      if (block.split('\n').some((line) => line.startsWith('data: '))) onEvent();
    }
  }
}

createRoot(document.getElementById('root')).render(<MinimalHostApp />);
