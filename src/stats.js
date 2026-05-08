// Profile cache + game history. The authoritative profile store is
// MongoDB (see profiles.js), but we mirror the selected profile into
// localStorage so the app can read it synchronously on every render.
// History is kept in both places: localStorage for immediate display
// while the cloud round-trips, and MongoDB (game_records) so lifetime
// stats follow a profile across devices.

import { recordGameForProfile } from './profiles.js';

const PROFILE_KEY = 'skipbo.profile';
const HISTORY_KEY = 'skipbo.history';
const HISTORY_LIMIT = 200;

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const COLORS = [
  '#38bdf8', '#22c55e', '#ec4899', '#f59e0b',
  '#a855f7', '#14b8a6', '#f43f5e', '#eab308',
];

export function getProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  const profile = {
    id: uuid(),
    name: localStorage.getItem('skipbo.name') || '',
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    createdAt: Date.now(),
  };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  return profile;
}

export function setProfile(partial) {
  const current = getProfile();
  const next = { ...current, ...partial };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
  if (typeof next.name === 'string') localStorage.setItem('skipbo.name', next.name);
  return next;
}

export function getHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

// Append a game outcome to local history. `state` is the final engine
// state; `profileId` is this device's player's stable id (so we can
// tell "did I win?" even if my display name changed).
export function recordGame(state, profileId, humanGameId, gameType = 'skipbo') {
  const history = getHistory();
  const winnerHumanId = state.winner;
  // vsHuman = at least one seat that's not this profile has a non-null
  // profileId, i.e. a real player other than me was in the match.
  // CPU seats have profileId === null, so they don't count.
  const vsHuman = state.playerOrder.some((id) => {
    const pid = state.players[id]?.profileId;
    return pid && pid !== profileId;
  });
  const record = {
    id: uuid(),
    endedAt: Date.now(),
    startedAt: state.startedAt ?? null,
    durationMs: state.startedAt ? Date.now() - state.startedAt : null,
    turnCount: state.turnNumber ?? null,
    winnerGameId: winnerHumanId,
    winnerName: winnerHumanId ? state.players[winnerHumanId]?.name ?? null : null,
    didIWin: humanGameId != null && winnerHumanId === humanGameId,
    myProfileId: profileId,
    vsHuman,
    rules: {
      stockSize: state.rules?.stockSize,
      handSize: state.rules?.handSize,
      maxDiscardDepth: state.rules?.maxDiscardDepth,
    },
    deckCount: state.deckCount ?? 1,
    players: state.playerOrder.map((id) => ({
      gameId: id,
      name: state.players[id]?.name ?? id,
      profileId: state.players[id]?.profileId ?? null,
      stockRemaining: state.players[id]?.stock?.length ?? 0,
      isWinner: id === winnerHumanId,
    })),
  };
  history.push(record);
  // Cap history so localStorage never grows unbounded.
  while (history.length > HISTORY_LIMIT) history.shift();
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  // Best-effort push to the cloud so stats follow this profile to any
  // other device they sign in on. Fire-and-forget; local cache is the
  // source of truth for the immediate UI.
  recordGameForProfile(profileId, {
    won: record.didIWin,
    turnCount: record.turnCount,
    durationMs: record.durationMs,
    deckCount: record.deckCount,
    rules: record.rules,
    players: record.players,
    gameType,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    vsHuman,
  });
  return record;
}

// Replace the locally-cached profile with one that came from MongoDB
// (id, name). Stats already keyed by profileId will continue to work.
export function selectProfile({ id, name, color }) {
  if (!id) return null;
  const current = (() => {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || null; } catch { return null; }
  })();
  const next = {
    ...(current || {}),
    id,
    name: name ?? current?.name ?? '',
    color: color ?? current?.color ?? COLORS[Math.floor(Math.random() * COLORS.length)],
    createdAt: current?.createdAt ?? Date.now(),
  };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
  if (typeof next.name === 'string') localStorage.setItem('skipbo.name', next.name);
  return next;
}

// Forget the current profile so the home screen shows the picker again.
export function clearProfile() {
  localStorage.removeItem(PROFILE_KEY);
  localStorage.removeItem('skipbo.name');
}

export function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
}

// Summary statistics computed over the local history array.
// Pass { vsHumanOnly: true } to count only games that had at least one
// other real player in them (CPU-only games excluded).
export function computeStats(history = getHistory(), opts = {}) {
  const filtered = opts.vsHumanOnly
    ? history.filter((r) => r.vsHuman)
    : history;
  const total = filtered.length;
  const wins = filtered.filter((r) => r.didIWin).length;
  const totalTurns = filtered.reduce((s, r) => s + (r.turnCount || 0), 0);
  const totalDuration = filtered.reduce((s, r) => s + (r.durationMs || 0), 0);
  const avgTurnsPerGame = total ? Math.round(totalTurns / total) : 0;
  const avgDurationMs = total ? Math.round(totalDuration / total) : 0;
  return {
    total,
    wins,
    losses: total - wins,
    winPct: total ? Math.round((wins / total) * 1000) / 10 : 0,
    avgTurnsPerGame,
    avgDurationMs,
  };
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}
