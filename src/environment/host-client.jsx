import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { SessionBrowser } from '../ui/index.jsx';
import '../ui/styles.css';
import './assets/host.css';

const bootstrap = globalThis.__AGENT_WORKBENCH_BOOTSTRAP__ || {};

function MinimalHostApp() {
  const [environment, setEnvironment] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const refreshTimer = useRef(null);

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
    setSessions(body.sessions || []);
    return body.sessions || [];
  }, [request]);

  const refreshSession = useCallback(async (sessionId = selectedId) => {
    if (!sessionId) return null;
    const body = await request(`/api/sessions/${encodeURIComponent(sessionId)}`);
    setSession(body.session);
    return body.session;
  }, [request, selectedId]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      Promise.all([refreshSessions(), refreshSession()]).catch((nextError) => setError(nextError.message));
    }, 60);
  }, [refreshSession, refreshSessions]);

  useEffect(() => {
    Promise.all([request('/api/environment').then(setEnvironment), refreshSessions()])
      .catch((nextError) => setError(nextError.message));
    return () => clearTimeout(refreshTimer.current);
  }, [refreshSessions, request]);

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
      await Promise.all([refreshSessions(), refreshSession(selectedId)]);
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
    await refreshSession(selectedId);
  }

  async function stopRuntime() {
    if (!globalThis.confirm('Stop this Workbench Run?')) return;
    await request('/api/runtime/stop', { method: 'POST', body: '{}' });
  }

  const detail = useMemo(() => session ? {
    session,
    features: {
      attachments: false,
      externalLink: false,
      realtime: false,
      sideChats: false,
      steer: true,
      subagents: false,
      technicalDetails: true,
    },
    actions: {
      onBack: () => setSelectedId(null),
      onSubmit: submit,
      onInterrupt: session.status === 'running' ? interrupt : null,
      onRespondToRequest: respondToRequest,
      onError: (nextError) => setError(nextError.message),
    },
    labels: {
      back: 'Sessions',
      composerPlaceholder: 'Ask the agent…',
      emptyTitle: 'Start this Session',
      emptyBody: 'This Run retains the conversation without requiring a project.',
    },
  } : null, [session, selectedId]);

  const isolationSatisfied = environment?.isolation?.effectiveLevel === environment?.isolation?.requestedLevel
    || environment?.isolation?.effectiveLevel === 'ephemeral-machine';

  return (
    <main className="awb-minimal-host">
      <header className="awb-host-bar">
        <div className="awb-host-identity">
          <strong>{environment?.profile?.id || 'Minimal Host'}</strong>
          <span>{environment?.id || 'starting'}</span>
        </div>
        <div className="awb-host-meta">
          <span className="awb-host-isolation" data-satisfied={isolationSatisfied}>
            Isolation: {environment?.isolation?.effectiveLevel || 'checking'} / required {environment?.isolation?.requestedLevel || 'checking'}
          </span>
          <button className="awb-host-stop" onClick={() => stopRuntime().catch((nextError) => setError(nextError.message))} type="button">Stop Run</button>
        </div>
      </header>
      <SessionBrowser
        actions={{
          onCreate: createSession,
          onRefresh: refreshSessions,
          onSelect: (nextSession) => setSelectedId(nextSession.id),
        }}
        browser={{
          sessions,
          selectedSessionId: selectedId,
          groupMode: 'time',
          groupOptions: [{ id: 'time', label: 'Recent' }],
          createTargets: [{ id: 'environment', label: 'Environment' }],
          showCreateTargetSelect: false,
        }}
        detail={detail}
        labels={{
          countSuffix: 'Sessions',
          createLabel: 'New Session',
          detailEmptyTitle: sessions.length ? 'Choose a Session' : 'Create the first Session',
          detailEmptyBody: 'The Minimal Host does not require projects, tasks, or memory.',
          listAriaLabel: 'Sessions',
          refresh: 'Refresh',
        }}
      />
      {error ? <div className="awb-host-error" role="alert">{error}</div> : null}
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
