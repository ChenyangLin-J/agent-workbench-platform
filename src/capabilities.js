const SUBAGENT_MODES = new Set(['hidden', 'summary', 'full']);
const VISIBILITY_MODES = new Set(['hidden', 'visible']);

export function normalizeSessionFeatures(features = {}) {
  return {
    attachments: normalizeVisibility(features.attachments, 'visible'),
    externalLink: normalizeVisibility(features.externalLink, 'visible'),
    realtime: normalizeVisibility(features.realtime ?? features.realtimeV3, 'hidden'),
    sideChats: normalizeFeatureMode(features.sideChats),
    steer: features.steer !== false,
    subagents: normalizeSubagentMode(features.subagents),
    technicalDetails: Boolean(features.technicalDetails),
  };
}

export function normalizeSubagentMode(value) {
  return normalizeFeatureMode(value);
}

export function normalizeSideChatMode(value) {
  return normalizeFeatureMode(value);
}

function normalizeFeatureMode(value) {
  if (value === true) return 'full';
  if (value === false || value == null) return 'hidden';
  const mode = String(value).trim().toLowerCase();
  return SUBAGENT_MODES.has(mode) ? mode : 'hidden';
}

export function normalizeVisibility(value, fallback = 'hidden') {
  if (value === true) return 'visible';
  if (value === false) return 'hidden';
  const mode = String(value ?? '').trim().toLowerCase();
  return VISIBILITY_MODES.has(mode) ? mode : fallback;
}
