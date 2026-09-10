const TERMINAL_TURN_STATUSES = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'canceled']);

export function parseMinimalHostSessionEvent(envelope) {
  let event;
  try {
    event = JSON.parse(String(envelope?.data || ''));
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object' || typeof event.type !== 'string'
    || typeof event.sessionId !== 'string') return null;
  return { ...event, eventId: envelope?.eventId ?? event.eventId ?? null };
}

export function applyMinimalHostSessionEvent(current, event) {
  if (!current || !event || sessionIdentifier(current) !== event.sessionId) {
    return { session: current, snapshotRequired: false };
  }
  if (event.type === 'replay_gap' || event.payload?.snapshotRequired === true) {
    return { session: current, snapshotRequired: true };
  }
  const session = {
    ...current,
    messages: (current.messages || []).map((message) => ({ ...message })),
    technicalItems: (current.technicalItems || []).map((item) => ({ ...item })),
    pendingRequests: (current.pendingRequests || []).map((request) => ({ ...request })),
    runtimeBinding: current.runtimeBinding ? { ...current.runtimeBinding } : null,
    livePublishedMediaByTurn: { ...(current.livePublishedMediaByTurn || {}) },
  };
  const timestamp = eventTimestamp(event);
  if (event.type === 'turn_started' || event.type === 'turn_accepted') {
    session.status = 'running';
    session.statusLabel = '正在处理';
    session.runtimeBinding = {
      ...(session.runtimeBinding || {}),
      activeTurnId: event.runtimeTurnId || session.runtimeBinding?.activeTurnId || null,
      status: 'running',
    };
    bindLatestUserMessage(session, event.runtimeTurnId);
  } else if (event.type === 'turn_completed') {
    const status = String(event.payload?.status || 'completed');
    session.status = status === 'completed' ? 'idle' : 'error';
    session.statusLabel = status === 'completed' ? '空闲' : '发生错误';
    session.completedAt = timestamp;
    session.runtimeBinding = {
      ...(session.runtimeBinding || {}),
      activeTurnId: null,
      lastTurnId: event.runtimeTurnId || null,
      status,
      lastError: event.payload?.error?.message || null,
    };
    for (const message of session.messages) {
      if (message.turnId === event.runtimeTurnId) message.turnStatus = status;
    }
    publishTurnMedia(session, event.runtimeTurnId);
  } else if (event.type === 'request_opened') {
    session.status = 'waiting';
    session.statusLabel = '等待输入';
    const token = String(event.payload?.requestToken || '');
    if (token && !session.pendingRequests.some((request) => request.token === token)) {
      const request = event.payload?.request || {};
      session.pendingRequests.push({
        token,
        title: 'Approval required',
        detail: String(request.command || request.reason || event.payload?.requestType || ''),
        kind: String(event.payload?.requestType || 'approval'),
        questions: Array.isArray(request.questions) ? request.questions : [],
      });
    }
  } else if (['request_resolved', 'request_rejected', 'request_expired'].includes(event.type)) {
    const token = String(event.payload?.requestToken || '');
    session.pendingRequests = session.pendingRequests.filter((request) => request.token !== token);
    session.status = session.runtimeBinding?.activeTurnId ? 'running' : 'idle';
    session.statusLabel = session.status === 'running' ? '正在处理' : '空闲';
  } else if (event.type === 'connection_exited' || event.type === 'core_error') {
    session.status = 'error';
    session.statusLabel = '发生错误';
    session.runtimeBinding = {
      ...(session.runtimeBinding || {}),
      activeTurnId: null,
      status: 'disconnected',
      lastError: event.payload?.reason || event.payload?.message || 'connection_exited',
    };
  } else if (event.type === 'plan_updated') {
    session.plan = normalizePlan(event.payload?.plan);
  } else if (event.type === 'item_delta') {
    applyAgentDelta(session, event);
  } else if (['item_started', 'item_completed'].includes(event.type)) {
    applyRuntimeItem(session, event);
  }
  session.updatedAt = timestamp;
  session.lastEventId = event.eventId ?? session.lastEventId ?? null;
  return { session, snapshotRequired: false };
}

export function patchMinimalHostSessionSummary(sessions, detail) {
  const sessionId = sessionIdentifier(detail);
  if (!sessionId) return sessions;
  return (sessions || []).map((session) => sessionIdentifier(session) === sessionId ? {
    ...session,
    title: detail.title,
    status: detail.status,
    statusLabel: detail.statusLabel,
    updatedAt: detail.updatedAt,
    completedAt: detail.completedAt,
  } : session);
}

function applyAgentDelta(session, event) {
  const itemId = String(event.payload?.itemId || `agent-${event.runtimeTurnId || 'unknown'}`);
  let message = session.messages.find((candidate) => candidate.id === itemId);
  if (!message) {
    message = {
      id: itemId,
      role: 'assistant',
      phase: /agentMessage/i.test(event.providerEvent || '') ? 'answer' : 'commentary',
      content: '',
      turnId: event.runtimeTurnId || null,
      turnStatus: 'inProgress',
      createdAt: eventTimestamp(event),
    };
    session.messages.push(message);
  }
  message.content = `${message.content || ''}${String(event.payload?.delta ?? '')}`;
}

function applyRuntimeItem(session, event) {
  const item = event.payload?.item;
  if (!item || typeof item !== 'object') return;
  if (['userMessage', 'agentMessage'].includes(item.type)) {
    const role = item.type === 'userMessage' ? 'user' : 'assistant';
    const content = runtimeItemText(item);
    const id = String(item.id || `${role}-${event.runtimeTurnId || 'unknown'}`);
    const existing = session.messages.find((candidate) => candidate.id === id);
    const existingUserTurn = role === 'user'
      ? session.messages.find((candidate) => candidate.role === 'user' && candidate.turnId === event.runtimeTurnId)
      : null;
    const message = {
      id,
      role,
      phase: item.phase === 'commentary' ? 'commentary' : 'answer',
      content,
      turnId: event.runtimeTurnId || null,
      turnStatus: item.status || (event.type === 'item_completed' ? 'completed' : 'inProgress'),
      createdAt: eventTimestamp(event),
    };
    if (existing) Object.assign(existing, message);
    else if (!existingUserTurn && !session.messages.some((candidate) => (
      candidate.role === role && candidate.turnId === message.turnId && candidate.content === content
    ))) session.messages.push(message);
    if (role === 'assistant' && message.phase !== 'commentary') publishTurnMedia(session, event.runtimeTurnId);
    return;
  }
  if (item.type === 'imageGeneration' && item.publishedMedia) {
    const turnId = String(event.runtimeTurnId || '');
    if (turnId) {
      const media = session.livePublishedMediaByTurn[turnId] ||= [];
      if (!media.some((candidate) => candidate.resourceId === item.publishedMedia.resourceId)) {
        media.push({ ...item.publishedMedia });
      }
      publishTurnMedia(session, turnId);
    }
    return;
  }
  const id = String(item.id || `technical-${event.runtimeTurnId || 'unknown'}`);
  const existing = session.technicalItems.find((candidate) => candidate.id === id);
  const technical = {
    id,
    turnId: event.runtimeTurnId || null,
    kind: String(item.type || 'runtimeItem'),
    title: runtimeItemTitle(item),
    status: String(item.status || (event.type === 'item_completed' ? 'completed' : 'running')),
    detail: runtimeItemText(item).slice(0, 16_000),
    startedAt: existing?.startedAt || eventTimestamp(event),
    updatedAt: eventTimestamp(event),
  };
  if (TERMINAL_TURN_STATUSES.has(technical.status)) technical.completedAt = technical.updatedAt;
  if (existing) Object.assign(existing, technical);
  else session.technicalItems.push(technical);
}

function publishTurnMedia(session, turnId) {
  const published = session.livePublishedMediaByTurn?.[turnId];
  if (!Array.isArray(published) || !published.length) return;
  const targets = session.messages.filter((message) => (
    message.role === 'assistant' && message.phase !== 'commentary' && message.turnId === turnId
  ));
  const target = targets.at(-1);
  if (!target) return;
  const current = Array.isArray(target.media) ? [...target.media] : [];
  const seen = new Set(current.map(mediaIdentifier).filter(Boolean));
  target.media = [...current, ...published.filter((media) => {
    const identifier = mediaIdentifier(media);
    if (!identifier || seen.has(identifier)) return false;
    seen.add(identifier);
    return true;
  })];
}

function mediaIdentifier(media) {
  return media?.resourceId || media?.attachmentId || media?.id || null;
}

function bindLatestUserMessage(session, turnId) {
  if (!turnId) return;
  const message = [...session.messages].reverse().find((candidate) => candidate.role === 'user' && !candidate.turnId);
  if (message) {
    message.turnId = turnId;
    message.turnStatus = 'inProgress';
  }
}

function normalizePlan(value) {
  return Array.isArray(value) ? value.map((step, index) => ({
    id: String(step?.id || `plan-${index}`),
    text: String(step?.step || step?.text || ''),
    status: String(step?.status || 'pending'),
  })).filter((step) => step.text) : [];
}

function runtimeItemText(item) {
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    return item.content.map((part) => part?.text || part?.content || '').filter(Boolean).join('\n');
  }
  if (typeof item.output === 'string') return item.output;
  if (typeof item.command === 'string') return item.command;
  return '';
}

function runtimeItemTitle(item) {
  return ({
    commandExecution: 'Command',
    fileChange: 'File change',
    mcpToolCall: 'Tool call',
    reasoning: 'Reasoning',
    webSearch: 'Web search',
  })[item.type] || String(item.type || 'Runtime item');
}

function eventTimestamp(event) {
  const value = Number(event.createdAt);
  return new Date(Number.isFinite(value) && value >= 0 ? value : Date.now()).toISOString();
}

function sessionIdentifier(session) {
  return String(session?.sessionId || session?.id || '');
}
