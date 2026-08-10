const PRESENTATION_GROUPS = [
  { id: 'pending', label: '待处理', kinds: ['attention', 'unread', 'error'] },
  { id: 'running', label: '进行中', kinds: ['running'] },
  { id: 'ready', label: '空闲', kinds: ['ready', 'released'] },
];

export function deriveSessionPresentation(session = {}) {
  const pendingRequestCount = Number(
    session.pendingServerRequestCount
      ?? session.pendingRequestCount
      ?? (session.waitingForUser ? 1 : 0),
  );
  if (pendingRequestCount > 0) {
    return { kind: 'attention', state: 'attention', label: '等你处理', pendingRequestCount };
  }
  if (session.turnState?.interrupted || session.status === 'interrupted') {
    return { kind: 'attention', state: 'interrupted', label: '需要继续', pendingRequestCount: 0 };
  }
  if (session.status === 'error') {
    return { kind: 'error', state: 'error', label: session.statusLabel || '异常', pendingRequestCount: 0 };
  }
  if (session.released || session.suspended) {
    if (session.hasUnreadResult || session.status === 'unread') {
      return { kind: 'unread', state: 'unread', label: '新结果', pendingRequestCount: 0 };
    }
    return { kind: 'released', state: 'released', label: '已暂停', pendingRequestCount: 0 };
  }
  if (session.ready === false || session.status === 'connecting') {
    return { kind: 'running', state: 'restoring', label: '恢复中', pendingRequestCount: 0 };
  }
  if (session.turnState?.active || session.turnState?.stopping || session.status === 'running') {
    const stopping = Boolean(session.turnState?.stopping);
    return {
      kind: 'running',
      state: stopping ? 'stopping' : 'running',
      label: stopping ? '停止中' : (session.statusLabel || '运行中'),
      pendingRequestCount: 0,
    };
  }
  if (session.hasUnreadResult || session.status === 'unread') {
    return { kind: 'unread', state: 'unread', label: '新结果', pendingRequestCount: 0 };
  }
  if (session.status === 'waiting') {
    return { kind: 'attention', state: 'waiting', label: session.statusLabel || '等待确认', pendingRequestCount: 0 };
  }
  return { kind: 'ready', state: 'waiting', label: session.statusLabel || '空闲', pendingRequestCount: 0 };
}

export function sessionCurrentTask(session = {}) {
  const requirements = [
    ...(Array.isArray(session.turnState?.requirements) ? session.turnState.requirements : []),
    ...(Array.isArray(session.turnState?.queuedTurns) ? session.turnState.queuedTurns : []),
  ];
  const current = [...requirements].reverse().find((requirement) =>
    ['working', 'queued', 'interrupted'].includes(String(requirement?.status || '')),
  ) || [...requirements].reverse().find((requirement) => String(requirement?.text || '').trim());
  return current?.text ? String(current.text).replace(/\s+/g, ' ').trim() : '';
}

export function sessionTaskPresentation({
  previewOnly = false,
  sessionId = null,
  ready = true,
  turnState = {},
  interruptPending = false,
} = {}) {
  if (previewOnly) {
    return sessionId
      ? { state: 'preview', tone: 'idle', label: '已暂停' }
      : { state: 'draft', tone: 'idle', label: '待发送' };
  }
  if (!ready) return { state: 'connecting', tone: 'running', label: '连接中' };
  if (turnState.interrupted) return { state: 'interrupted', tone: 'waiting', label: '已中断' };
  if (turnState.stopping || interruptPending) {
    return { state: 'stopping', tone: 'running', label: '正在停止' };
  }
  if (turnState.active) {
    return { state: 'working', tone: 'running', label: turnState.statusLabel || '正在处理' };
  }
  if (turnState.lastStoppedTurnId && turnState.lastStoppedTurnId === turnState.lastCompletedTurnId) {
    return { state: 'stopped', tone: 'idle', label: '已停止' };
  }
  return { state: 'idle', tone: 'idle', label: turnState.statusLabel || '当前无任务' };
}

export function sessionMessagePresentation(message = {}) {
  const sourceRole = String(message.role || message.type || '').toLowerCase();
  const role = sourceRole === 'user' ? 'user' : 'assistant';
  const sourcePhase = String(message.phase || '').toLowerCase();
  const phase = role === 'assistant' && sourcePhase && !['answer', 'final_answer'].includes(sourcePhase)
    ? 'commentary'
    : 'answer';
  return {
    role,
    phase,
    label: String(message.label || (role === 'user' ? '你' : phase === 'commentary' ? '过程' : 'Agent')),
    tone: role === 'user' ? 'user' : phase === 'commentary' ? 'commentary' : 'assistant',
  };
}

export function sessionComposerPresentation({
  running = false,
  previewOnly = false,
  sessionId = null,
  editing = false,
  submitting = false,
  canSteer = true,
} = {}) {
  const primaryMode = running && !editing ? canSteer ? 'steer' : 'queue' : 'turn';
  const primaryLabel = submitting
    ? '发送中…'
    : editing
      ? '提交编辑'
      : previewOnly
        ? sessionId ? '发送并恢复' : '发送并创建'
        : running
          ? canSteer ? '追加当前' : '下一轮'
          : '发送';
  return {
    primaryMode,
    primaryLabel,
    secondaryMode: 'queue',
    secondaryLabel: '下一轮',
    showSecondary: Boolean(running && !editing && canSteer),
  };
}

export function groupSessionSummaries(sessions = [], mode = 'context', now = Date.now()) {
  const normalized = Array.isArray(sessions) ? sessions : [];
  if (mode === 'attention') {
    return PRESENTATION_GROUPS.map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      sessions: normalized.filter((session) => descriptor.kinds.includes(deriveSessionPresentation(session).kind)),
    })).filter((group) => group.sessions.length);
  }

  const groups = new Map();
  for (const session of normalized) {
    const descriptor = mode === 'time'
      ? timeGroupDescriptor(session.updatedAt, now)
      : { id: session.contextId || 'unassigned', label: session.contextLabel || '未分类' };
    const group = groups.get(descriptor.id) || { ...descriptor, sessions: [] };
    group.sessions.push(session);
    groups.set(descriptor.id, group);
  }
  return [...groups.values()].sort((left, right) => {
    const timeDelta = (right.sessions[0]?.updatedAt || 0) - (left.sessions[0]?.updatedAt || 0);
    return timeDelta || left.label.localeCompare(right.label);
  });
}

export function sessionStatusTone(statusOrSession) {
  const kind = typeof statusOrSession === 'string'
    ? deriveSessionPresentation({ status: statusOrSession }).kind
    : deriveSessionPresentation(statusOrSession).kind;
  return {
    attention: 'waiting',
    running: 'running',
    unread: 'unread',
    ready: 'idle',
    released: 'idle',
    error: 'error',
  }[kind] || 'neutral';
}

function timeGroupDescriptor(timestamp, now) {
  if (!timestamp) return { id: 'older', label: '更早' };
  const date = new Date(timestamp);
  const today = new Date(now);
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startToday - startDate) / 86400000);
  if (days === 0) return { id: 'today', label: '今天' };
  if (days === 1) return { id: 'yesterday', label: '昨天' };
  if (days < 7) return { id: 'week', label: '近 7 天' };
  if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth()) {
    return { id: 'month', label: '本月' };
  }
  return {
    id: `${date.getFullYear()}-${date.getMonth() + 1}`,
    label: new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(date),
  };
}
