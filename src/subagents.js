export class CodexSubagentService {
  constructor(requester, { metadata = new Map() } = {}) {
    if (typeof requester !== 'function') throw new TypeError('A Codex App Server requester is required.');
    this.request = requester;
    this.metadata = metadata;
  }

  async list(parentThreadId, { limit = 100, useStateDbOnly = true } = {}) {
    requiredId(parentThreadId, 'Parent thread');
    const response = await this.request('thread/list', {
      ancestorThreadId: parentThreadId,
      limit,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      useStateDbOnly,
    });
    const threads = Array.isArray(response?.data) ? response.data : [];
    return Promise.all(threads
      .filter((thread) => String(thread?.id || '') && String(thread.id) !== String(parentThreadId))
      .map(async (thread) => {
        let activeTurnId = '';
        if (codexThreadStatus(thread?.status).type === 'active') {
          const result = await this.request('thread/read', {
            threadId: String(thread.id),
            includeTurns: true,
          }).catch(() => null);
          activeTurnId = activeCodexTurn(result?.thread)?.id || '';
        }
        return normalizeCodexSubagent(thread, {
          activeTurnId,
          metadata: this.metadata.get(String(thread.id)) || {},
        });
      }));
  }

  async stop(parentThreadId, threadId) {
    requiredId(parentThreadId, 'Parent thread');
    requiredId(threadId, 'Sub-agent thread');
    if (String(parentThreadId) === String(threadId)) throw new Error('The parent thread is not a sub-agent.');
    const descendants = await this.list(parentThreadId);
    const target = descendants.find((thread) => thread.id === String(threadId));
    if (!target) throw new Error('The selected thread is not a descendant of this Session.');
    if (!target.activeTurnId) throw new Error('The selected sub-agent does not have an active Turn.');
    await this.request('turn/interrupt', { threadId: target.id, turnId: target.activeTurnId });
    return { threadId: target.id, turnId: target.activeTurnId };
  }
}

export function rememberCodexSubagentMetadata(store, item) {
  if (!(store instanceof Map) || item?.type !== 'collabAgentToolCall') return store;
  const ids = new Set([
    ...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []),
    ...Object.keys(item.agentsStates || {}),
  ]);
  for (const value of ids) {
    const id = String(value || '');
    if (!id) continue;
    const previous = store.get(id) || {};
    const agentState = item.agentsStates?.[id] || {};
    store.set(id, {
      ...previous,
      prompt: item.prompt || previous.prompt || '',
      model: item.model || previous.model || '',
      reasoningEffort: item.reasoningEffort || previous.reasoningEffort || '',
      state: agentState.status || previous.state || '',
      stateMessage: agentState.message || previous.stateMessage || '',
      tool: item.tool || previous.tool || '',
    });
  }
  return store;
}

export function normalizeCodexSubagent(thread = {}, { activeTurnId = '', metadata = {} } = {}) {
  const status = codexThreadStatus(thread.status);
  return {
    id: String(thread.id || ''),
    parentId: String(thread.parentThreadId || ''),
    name: cleanLabel(thread.name) || cleanLabel(thread.preview) || '子 Agent',
    nickname: String(thread.agentNickname || ''),
    role: String(thread.agentRole || ''),
    status: status.label,
    statusType: status.type,
    prompt: cleanText(metadata.prompt, 4_000),
    model: String(metadata.model || ''),
    reasoningEffort: String(metadata.reasoningEffort || ''),
    state: String(metadata.state || ''),
    stateMessage: String(metadata.stateMessage || ''),
    activeTurnId: String(activeTurnId || ''),
    canStop: Boolean(activeTurnId),
    cwd: String(thread.cwd || ''),
    updatedAt: codexTimestamp(thread.updatedAt),
  };
}

export function normalizeCodexThreadTree(entries = [], { currentThreadId = '', relationFor } = {}) {
  const normalizedEntries = entries
    .map((entry) => ({ thread: entry?.thread || entry, archived: Boolean(entry?.archived) }))
    .filter((entry) => String(entry.thread?.id || ''));
  const byId = new Map(normalizedEntries.map((entry) => [String(entry.thread.id), entry]));
  const relation = (id, thread) => {
    const value = relationFor?.(id, thread) || {};
    return {
      parentThreadId: String(value.parentThreadId || thread?.parentThreadId || ''),
      forkedFromId: String(value.forkedFromId || thread?.forkedFromId || ''),
    };
  };
  const related = new Set();
  const pending = [String(currentThreadId || '')];
  while (pending.length) {
    const id = pending.shift();
    if (!id || related.has(id)) continue;
    related.add(id);
    const thread = byId.get(id)?.thread;
    const links = relation(id, thread);
    const parentId = links.parentThreadId || links.forkedFromId;
    if (parentId) pending.push(parentId);
    for (const candidate of normalizedEntries) {
      const candidateId = String(candidate.thread.id);
      const candidateLinks = relation(candidateId, candidate.thread);
      if ((candidateLinks.parentThreadId || candidateLinks.forkedFromId) === id) pending.push(candidateId);
    }
  }
  return [...related].map((id) => {
    const entry = byId.get(id);
    if (!entry) return null;
    const thread = entry.thread;
    const links = relation(id, thread);
    const parentId = links.parentThreadId || links.forkedFromId;
    const status = codexThreadStatus(thread.status);
    return {
      id,
      parentId: related.has(parentId) ? parentId : '',
      relation: links.parentThreadId ? 'agent' : links.forkedFromId ? 'branch' : 'root',
      current: id === String(currentThreadId),
      archived: entry.archived,
      name: cleanLabel(thread.name) || cleanLabel(thread.preview) || 'Untitled session',
      nickname: String(thread.agentNickname || ''),
      role: String(thread.agentRole || ''),
      status: status.label,
      statusType: status.type,
      cwd: String(thread.cwd || ''),
      updatedAt: codexTimestamp(thread.updatedAt),
    };
  }).filter(Boolean);
}

export function activeCodexTurn(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  return [...turns].reverse().find((turn) => turn?.status === 'inProgress') || null;
}

export function codexThreadStatus(status) {
  const type = String(status?.type || status || '');
  return {
    type: type || 'unknown',
    label: {
      active: '运行中',
      idle: '已完成',
      notLoaded: '未载入',
      systemError: '错误',
    }[type] || type || '未知',
  };
}

function codexTimestamp(value) {
  if (typeof value === 'string' && value.trim() && Number.isNaN(Number(value))) {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? '' : new Date(timestamp).toISOString();
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return new Date(seconds < 1e12 ? seconds * 1_000 : seconds).toISOString();
}

function cleanLabel(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function cleanText(value, limit) {
  return String(value || '').trim().slice(0, limit);
}

function requiredId(value, label) {
  if (!String(value || '').trim()) throw new TypeError(`${label} id is required.`);
}
