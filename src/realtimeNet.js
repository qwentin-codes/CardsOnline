// MongoDB/Vercel networking. The room document in
// MongoDB is the single source of truth for lobby + game state;
// everyone subscribes via Realtime and applies their own actions
// through optimistic-concurrency UPDATEs (version-gated). Dropping
// the "host holds state" model is the whole point: a backgrounded
// phone no longer kills the room.
//
// Concurrency model
// -----------------
// Game state lives in `rooms.state` (jsonb) with `rooms.version` (int)
// bumped on every write. Any client can submit an action:
//   1. Run applyAction(state, me, action) locally (engine is pure).
//   2. UPDATE rooms SET state=new, version=version+1
//      WHERE code=? AND version=expected.
//   3. If 0 rows updated, we were stale — refetch and drop the attempt.
//   4. polling delivers the write to everyone.
//
// Bot election
// ------------
// When a CPU seat is to act, every non-CPU client schedules the bot
// action locally, staggered by their index in playerOrder. First write
// wins the optimistic update; others harmlessly no-op when they see
// the state advance. Collapses to a single bot action even if several
// clients are online, and keeps moving if the "primary" bot runner is
// offline.
//
// Chat
// ----
// Ephemeral Realtime broadcast on the same channel — not persisted.
// Messages are fire-and-forget and echo to the sender locally.


const localId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'p_' + Math.random().toString(36).slice(2, 10);
};

// Stable per-device id for profileless fallback. Not durable across
// browsers but fine for a single session.
function stableId(profileId) {
  if (profileId) return profileId;
  try {
    const k = 'skipbo.anonId';
    let v = localStorage.getItem(k);
    if (!v) { v = localId(); localStorage.setItem(k, v); }
    return v;
  } catch {
    return localId();
  }
}

// Reasonable cap on bot cadence — the engine supplies per-action
// delays but we also enforce a floor so a bot's "fast" action doesn't
// fly before UI has rendered the previous state.
const BOT_STAGGER_MS = 1500;

// How long an open undo vote stays live. Matches the legacy net.js
// constant. Any voter who hasn't voted by the deadline is counted as
// YES (the house rule: silent = no objection). Actual finalization
// is triggered by whichever client first notices the deadline is
// past (see maybeFinalizeUndoVote in attachRoom).
const UNDO_VOTE_MS = 15_000;

function nowIso() { return new Date().toISOString(); }

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function fetchRoom(code) {
  const data = await api(`/api/rooms?code=${encodeURIComponent(code)}`);
  return data.row || null;
}

// Update room with optimistic version check. Returns the new row or
// null on version conflict. Callers retry-by-resync when null.
async function updateRoomAtomic(code, patch, expectedVersion) {
  const data = await api('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ op: 'atomicUpdate', code, patch, expectedVersion }),
  });
  return data.row || null;
}

// Shared setup for both creator and joiner — subscribes to the room
// row + broadcast channel, exposes submit helpers. `initialRow` is the
// freshly-fetched-or-upserted row state.
//
// Transport strategy
// ------------------
// Polling the room document is the authoritative sync path. A 2-3s poll is plenty for turn-based card games and keeps the app simple on Vercel serverless functions.
function attachRoom({ game, roomCode, myPlayerId, myProfileId, myName, initialRow, onLobby, onState, onChat, onStatus }) {
  let currentRow = initialRow;
  let destroyed = false;
  let botTimer = null;
  let pollTimer = null;

  const POLL_INTERVAL_MS = 2200;

  onStatus?.({ kind: 'open', peerId: myPlayerId });

  // MongoDB/Vercel transport uses polling as the authoritative sync path.
  // This keeps the multiplayer flow deployment-friendly without WebRTC. Chat is persisted on the room row and delivered
  // on the same poll cycle.
  let seenChatCount = Array.isArray(currentRow?.chat) ? currentRow.chat.length : 0;

  // Push initial state through the callbacks so the UI renders the
  // current lobby/state even before the first Realtime event arrives.
  if (currentRow) applyRow(currentRow);

  function applyRow(row) {
    // Skip no-op events to avoid needless re-renders. version is the
    // cheapest signal for "anything happened"; updated_at catches lobby
    // mutations (which don't bump version).
    if (currentRow
      && currentRow.version === row.version
      && currentRow.updated_at === row.updated_at) {
      return;
    }
    currentRow = row;
    if (Array.isArray(row.chat) && row.chat.length > seenChatCount) {
      for (const msg of row.chat.slice(seenChatCount)) onChat?.(msg);
      seenChatCount = row.chat.length;
    }
    if (row.lobby) onLobby?.(row.lobby);
    if (row.state) {
      // Expose undoAvailable/lastActor to the UI, derived from the
      // undoSnapshot meta stashed inside state. undoVote is passed
      // through as-is.
      const snap = row.state.undoSnapshot;
      const payload = {
        ...row.state,
        undoAvailable: !!snap,
        lastActor: snap?.actor || null,
      };
      onState?.(payload);
    }
    scheduleBotIfNeeded();
    // Any time state moves, also check if a pending undo vote is
    // fully voted or has hit its deadline. Finalization uses the same
    // optimistic-concurrency pattern, so multiple clients racing to
    // finalize collapse to a single winner.
    maybeFinalizeUndoVote().catch(() => {});
  }

  // Poll the room row as the primary sync mechanism. Realtime would be
  // ideal but has been flaky in practice; a 2.2s poll reliably delivers
  // lobby + state changes within game-appropriate latency without
  // depending on WebSocket lifecycle quirks.
  function schedulePoll() {
    if (destroyed) return;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (destroyed) return;
      try {
        const row = await fetchRoom(roomCode);
        if (row) applyRow(row);
      } catch {
        // Network blip — keep polling; if persistent the user sees
        // staleness but the app doesn't hard-error.
      }
      schedulePoll();
    }, POLL_INTERVAL_MS);
  }
  schedulePoll();

  async function refetch() {
    try {
      const row = await fetchRoom(roomCode);
      if (row) applyRow(row);
    } catch (err) {
      onStatus?.({ kind: 'error', type: 'fetch', message: err.message || String(err) });
    }
  }

  // Lobby mutation: retry-on-conflict since pre-game writes (add CPU,
  // rename, etc.) don't have a natural version to gate on — we just
  // re-read and re-apply if something raced us.
  async function mutateLobby(mutator, { maxAttempts = 3 } = {}) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (!currentRow) await refetch();
      if (!currentRow) return { ok: false, error: 'Room not found.' };
      const lobby = currentRow.lobby || { players: [], rules: { ...game.defaultRules }, started: false };
      const nextLobby = mutator({ ...lobby, players: (lobby.players || []).map((p) => ({ ...p })) });
      if (!nextLobby) return { ok: true }; // mutator signalled no-op
      const playerCount = nextLobby.players?.length ?? currentRow.player_count ?? 0;
      const updated = await updateRoomAtomic(
        roomCode,
        { lobby: nextLobby, player_count: playerCount },
        currentRow.version,
      );
      if (updated) { applyRow(updated); return { ok: true }; }
      await refetch();
    }
    return { ok: false, error: 'Could not apply change — please retry.' };
  }

  // Strip undo meta before running the engine — the engine only
  // knows about its own state shape. Re-attach snapshot + cleared
  // vote before writing back.
  function pureState(raw) {
    if (!raw) return raw;
    const { undoSnapshot, undoVote, ...rest } = raw;
    return rest;
  }

  async function submitAction(playerId, action) {
    if (!currentRow) return { ok: false, error: 'Room not ready.' };
    if (!currentRow.state) return { ok: false, error: 'Game has not started.' };
    const expectedVersion = currentRow.version;

    // Engine-level undo.
    // The engine reads state.undoSnapshot itself and restores from it,
    // so pass the full state through without stripping, and don't
    // wrap the result — the engine has already zeroed the snapshot to
    // prevent chained undos. Skip-Bo's vote-based undo does NOT go
    // through this path (it uses requestUndo / castUndoVote directly).
    if (action?.type === 'undo') {
      const res = game.applyAction(currentRow.state, playerId, action);
      if (!res.ok) return res;
      const updated = await updateRoomAtomic(
        roomCode,
        { state: res.state, version: expectedVersion + 1 },
        expectedVersion,
      );
      if (!updated) { await refetch(); return { ok: false, error: 'stale-state' }; }
      applyRow(updated);
      return { ok: true };
    }

    const pre = pureState(currentRow.state);
    const res = game.applyAction(pre, playerId, action);
    if (!res.ok) return res;
    const newState = {
      ...res.state,
      undoSnapshot: { state: pre, actor: playerId },
      // Any in-flight undo vote was for a previous action; the new
      // action invalidates it.
      undoVote: null,
    };
    const updated = await updateRoomAtomic(
      roomCode,
      { state: newState, version: expectedVersion + 1 },
      expectedVersion,
    );
    if (!updated) {
      await refetch();
      return { ok: false, error: 'stale-state' };
    }
    applyRow(updated);
    return { ok: true };
  }

  // Undo flow — ported from the legacy PeerJS net.js. The undo state
  // (snapshot + in-flight vote) travels as two extra keys on the
  // state jsonb so every client can see it via the same sync path.
  // All writes go through updateRoomAtomic with the current version
  // as the expected version, so simultaneous votes collapse to one
  // winner per round of optimistic concurrency.
  async function handleUndoRequest(playerId) {
    if (!currentRow?.state) return { ok: false, error: 'Room not ready.' };
    const state = currentRow.state;
    if (state.winner) return { ok: false, error: 'Match is over.' };
    const snap = state.undoSnapshot;
    if (!snap || snap.actor !== playerId) {
      return { ok: false, error: 'No undoable action right now.' };
    }
    if (state.undoVote) return { ok: false, error: 'A vote is already in progress.' };
    const lobby = currentRow.lobby;
    const voters = (lobby?.players || [])
      .filter((p) => p.id !== playerId)
      .map((p) => p.id);

    // Solo game (or only CPUs left as voters) — skip the vote and
    // just restore the snapshot directly.
    if (voters.length === 0) {
      const restored = { ...snap.state, undoSnapshot: null, undoVote: null };
      const updated = await updateRoomAtomic(
        roomCode,
        { state: restored, version: (currentRow.version || 0) + 1 },
        currentRow.version,
      );
      if (!updated) { await refetch(); return { ok: false, error: 'stale-state' }; }
      applyRow(updated);
      return { ok: true };
    }

    // Pre-fill YES for CPU voters — bots can't click "allow".
    const votes = {};
    for (const v of voters) {
      const seat = lobby.players.find((p) => p.id === v);
      if (seat?.isCpu) votes[v] = true;
    }
    const newVote = {
      requester: playerId,
      voters,
      votes,
      required: Math.floor(voters.length / 2) + 1,
      deadlineAt: Date.now() + UNDO_VOTE_MS,
    };
    const newState = { ...state, undoVote: newVote };
    const updated = await updateRoomAtomic(
      roomCode,
      { state: newState, version: (currentRow.version || 0) + 1 },
      currentRow.version,
    );
    if (!updated) { await refetch(); return { ok: false, error: 'stale-state' }; }
    applyRow(updated);
    // If bot auto-yeses already met the threshold, finalize immediately.
    await maybeFinalizeUndoVote();
    return { ok: true };
  }

  async function handleUndoVote(playerId, yes) {
    if (!currentRow?.state) return { ok: false, error: 'Room not ready.' };
    const state = currentRow.state;
    const vote = state.undoVote;
    if (!vote) return { ok: false, error: 'No active vote.' };
    if (playerId === vote.requester) return { ok: false, error: 'Cannot vote on your own undo.' };
    if (!vote.voters.includes(playerId)) return { ok: false, error: 'You are not in this game.' };
    if (typeof vote.votes[playerId] === 'boolean') return { ok: false, error: 'Already voted.' };
    const nextVote = {
      ...vote,
      votes: { ...vote.votes, [playerId]: !!yes },
    };
    const newState = { ...state, undoVote: nextVote };
    const updated = await updateRoomAtomic(
      roomCode,
      { state: newState, version: (currentRow.version || 0) + 1 },
      currentRow.version,
    );
    if (!updated) { await refetch(); return { ok: false, error: 'stale-state' }; }
    applyRow(updated);
    await maybeFinalizeUndoVote();
    return { ok: true };
  }

  async function maybeFinalizeUndoVote() {
    const state = currentRow?.state;
    const vote = state?.undoVote;
    if (!vote) return;
    const allVoted = vote.voters.every((v) => typeof vote.votes[v] === 'boolean');
    const deadlinePassed = Date.now() >= vote.deadlineAt;
    if (!allVoted && !deadlinePassed) return;
    await finalizeUndoVote();
  }

  async function finalizeUndoVote() {
    const state = currentRow?.state;
    const vote = state?.undoVote;
    if (!vote) return;
    const snap = state.undoSnapshot;
    // Unvoted counts as YES per house rules.
    let yes = 0;
    for (const vid of vote.voters) {
      const v = vote.votes[vid];
      if (v === true || v === undefined) yes += 1;
    }
    const approved = yes >= vote.required && !!snap;
    const newState = approved
      ? { ...snap.state, undoSnapshot: null, undoVote: null }
      : { ...state, undoVote: null };
    const updated = await updateRoomAtomic(
      roomCode,
      { state: newState, version: (currentRow.version || 0) + 1 },
      currentRow.version,
    );
    // If our optimistic update lost the race, another client finalized
    // first — refetch the winning state and move on.
    if (!updated) { await refetch(); return; }
    applyRow(updated);
  }

  function scheduleBotIfNeeded() {
    if (botTimer) { clearTimeout(botTimer); botTimer = null; }
    if (destroyed) return;
    const state = currentRow?.state;
    const lobby = currentRow?.lobby;
    if (!state || state.winner || !lobby) return;
    // Pause bots while an undo vote is live — otherwise the bot's
    // setTimeout can fire, apply its action, and (via submitAction's
    // "new action clears vote" rule) silently cancel the human's
    // undo request.
    if (state.undoVote) return;
    const turnSeat = lobby.players?.find((p) => p.id === state.turn);
    if (!turnSeat?.isCpu) return;

    // Election: only non-CPU clients run bots. Each client picks its
    // staggered delay based on its rank among non-CPUs in playerOrder,
    // so the "primary" fires first and the rest collapse to no-ops
    // when they see the state advance. This lets the game keep moving
    // even if the primary is offline.
    const nonCpuSeats = (state.playerOrder || []).filter((id) => {
      const seat = lobby.players.find((p) => p.id === id);
      return seat && !seat.isCpu;
    });
    const myRank = nonCpuSeats.indexOf(myPlayerId);
    if (myRank < 0) return;

    const plan = game.cpuPlan(state, state.turn, turnSeat.cpuDifficulty || 'normal');
    if (!plan || plan.length === 0) return;
    const firstAction = plan[0];
    const baseDelay = game.botActionDelay ? game.botActionDelay(firstAction) : 1200;
    const stagger = myRank * BOT_STAGGER_MS;

    botTimer = setTimeout(async () => {
      botTimer = null;
      if (destroyed) return;
      // Re-verify it's still this CPU's turn at the same version —
      // avoids racing against another client who already fired.
      const cur = currentRow;
      if (!cur?.state) return;
      if (cur.state.turn !== state.turn) return;
      if (cur.version !== state.version) return;
      await submitAction(state.turn, firstAction);
    }, baseDelay + stagger);
  }

  async function sendChat(text) {
    const clean = String(text || '').slice(0, 500).trim();
    if (!clean) return;
    const msg = { from: myPlayerId, name: myName, text: clean, ts: Date.now() };
    try {
      await api('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ op: 'appendChat', code: roomCode, message: msg }),
      });
    } catch {}
    onChat?.(msg); // self-echo so the sender sees their message immediately
    seenChatCount += 1;
  }

  function destroy() {
    destroyed = true;
    if (botTimer) { clearTimeout(botTimer); botTimer = null; }
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  return {
    myPlayerId,
    roomCode,
    getLobby: () => currentRow?.lobby,
    getState: () => currentRow?.state,
    refetch,

    // Lobby ops (UI gates creator-only ones).
    async updateRules(rules) {
      return mutateLobby((lobby) => ({ ...lobby, rules: { ...lobby.rules, ...rules } }));
    },
    async setName(newName) {
      const clean = String(newName || '').slice(0, 20).trim();
      if (!clean) return { ok: false, error: 'Name required.' };
      return mutateLobby((lobby) => ({
        ...lobby,
        players: lobby.players.map((p) => (p.id === myPlayerId ? { ...p, name: clean } : p)),
      }));
    },
    async addCpu(difficulty = 'normal') {
      if (!['easy', 'normal', 'hard'].includes(difficulty)) difficulty = 'normal';
      return mutateLobby((lobby) => {
        if ((lobby.players?.length || 0) >= game.maxPlayers) return null;
        const usedNums = new Set(
          lobby.players
            .filter((p) => p.isCpu)
            .map((p) => parseInt(String(p.id).replace(/^cpu_/, ''), 10))
            .filter((n) => !Number.isNaN(n)),
        );
        let n = 1;
        while (usedNums.has(n)) n += 1;
        return {
          ...lobby,
          players: [
            ...lobby.players,
            { id: `cpu_${n}`, name: `CPU ${n}`, profileId: null, isCpu: true, cpuDifficulty: difficulty },
          ],
        };
      });
    },
    async removeCpu(id) {
      return mutateLobby((lobby) => {
        const seat = lobby.players.find((p) => p.id === id);
        if (!seat || !seat.isCpu) return null;
        return { ...lobby, players: lobby.players.filter((p) => p.id !== id) };
      });
    },
    async setCpuDifficulty(id, difficulty) {
      if (!['easy', 'normal', 'hard'].includes(difficulty)) return { ok: false, error: 'Invalid difficulty' };
      return mutateLobby((lobby) => {
        const seat = lobby.players.find((p) => p.id === id);
        if (!seat || !seat.isCpu) return null;
        return { ...lobby, players: lobby.players.map((p) => (p.id === id ? { ...p, cpuDifficulty: difficulty } : p)) };
      });
    },
    async startGame() {
      if (!currentRow) await refetch();
      if (!currentRow) return { ok: false, error: 'Room not found.' };
      const lobby = currentRow.lobby;
      if (!lobby) return { ok: false, error: 'No lobby.' };
      const humans = lobby.players.filter((p) => !p.isCpu);
      if ((lobby.players?.length || 0) < game.minPlayers) {
        return { ok: false, error: `Need at least ${game.minPlayers} players` };
      }
      if (humans.length < 2) {
        return { ok: false, error: 'Need at least one other human in the room. Use "Play vs CPU" for solo games.' };
      }
      const ids = lobby.players.map((p) => p.id);
      const names = Object.fromEntries(lobby.players.map((p) => [p.id, p.name]));
      let state;
      try {
        state = game.createGame(ids, names, lobby.rules);
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
      for (const lp of lobby.players) {
        if (state.players[lp.id]) state.players[lp.id].profileId = lp.profileId || null;
      }
      const updated = await updateRoomAtomic(
        roomCode,
        { state, version: 0, started: true, lobby: { ...lobby, started: true } },
        currentRow.version,
      );
      if (!updated) {
        await refetch();
        return { ok: false, error: 'Lobby changed while starting — please try again.' };
      }
      applyRow(updated);
      return { ok: true };
    },

    submitAction(action) { return submitAction(myPlayerId, action); },
    sendChat,
    requestUndo() { return handleUndoRequest(myPlayerId); },
    castUndoVote(yes) { return handleUndoVote(myPlayerId, yes); },
    sendRename(newName) { return this.setName(newName); },
    destroy,
  };
}

// ───────────────────────────── CREATOR ─────────────────────────────
export async function createHost({ game, roomCode, hostName, hostProfileId, onLobby, onState, onChat, onError, onStatus }) {
  onStatus?.({ kind: 'connecting' });
  const myPlayerId = stableId(hostProfileId);
  const initialLobby = {
    roomCode,
    creatorId: myPlayerId,
    hostId: myPlayerId,
    players: [{
      id: myPlayerId,
      name: hostName,
      profileId: hostProfileId || null,
      isCpu: false,
      isCreator: true,
    }],
    rules: { ...game.defaultRules },
    started: false,
  };

  // If a stale row exists for this code (previous session, broker TTL
  // etc.) and it's clearly not an active game of ours, upsert over it.
  // A genuine collision (two different hosts choosing the same code
  // within the freshness window) is vanishingly rare given 4-char
  // codes and short TTL.
  const row = {
    code: roomCode,
    host_name: hostName,
    player_count: 1,
    max_players: game.maxPlayers,
    started: false,
    game_type: game.id,
    lobby: initialLobby,
    state: null,
    version: 0,
    updated_at: nowIso(),
  };
  let savedRow;
  try {
    const res = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ op: 'upsert', row }),
    });
    savedRow = res.row || row;
  } catch (error) {
    onStatus?.({ kind: 'error', type: 'insert', message: error.message });
    throw error;
  }

  const handle = attachRoom({
    game,
    roomCode,
    myPlayerId,
    myProfileId: hostProfileId,
    myName: hostName,
    initialRow: savedRow,
    onLobby, onState, onChat, onStatus,
  });

  // Expose `hostId` for App.jsx which uses it to identify the creator's
  // seat in the local UI (isHost checks).
  return { ...handle, hostId: myPlayerId };
}

// ───────────────────────────── JOINER ─────────────────────────────
export async function createClient({ game, roomCode, name, profileId, onLobby, onState, onChat, onError, onWelcome, onStatus }) {
  onStatus?.({ kind: 'connecting', phase: 'signaling' });

  const row = await fetchRoom(roomCode);
  if (!row) {
    const msg = `Room ${roomCode} not found. Check the code or ask the host to create one.`;
    onStatus?.({ kind: 'error', type: 'peer-unavailable', message: msg });
    throw Object.assign(new Error(msg), { type: 'peer-unavailable' });
  }

  const lobby = row.lobby || { players: [], rules: { ...game.defaultRules }, started: false };
  const myPlayerId = stableId(profileId);

  // Reconnect path: if a seat with this profileId already exists, reuse
  // it (keeps game state references valid). Otherwise add a new seat.
  const existing = profileId
    ? lobby.players.find((p) => p.profileId === profileId)
    : lobby.players.find((p) => p.id === myPlayerId);

  if (!existing) {
    if (lobby.started) {
      const msg = 'Game already in progress.';
      onStatus?.({ kind: 'error', type: 'already-started', message: msg });
      throw new Error(msg);
    }
    if (lobby.players.length >= game.maxPlayers) {
      const msg = 'Room is full.';
      onStatus?.({ kind: 'error', type: 'room-full', message: msg });
      throw new Error(msg);
    }
    const nextLobby = {
      ...lobby,
      players: [
        ...lobby.players,
        { id: myPlayerId, name, profileId: profileId || null, isCpu: false, isCreator: false },
      ],
    };
    const updated = await updateRoomAtomic(
      roomCode,
      { lobby: nextLobby, player_count: nextLobby.players.length },
      row.version,
    );
    if (updated) row.lobby = updated.lobby;
  } else if (existing.name !== name) {
    // Keep the display name in sync with whatever the client chose.
    const nextLobby = {
      ...lobby,
      players: lobby.players.map((p) => (p.id === existing.id ? { ...p, name } : p)),
    };
    await updateRoomAtomic(roomCode, { lobby: nextLobby }, row.version);
  }

  const freshRow = await fetchRoom(roomCode);
  const handle = attachRoom({
    game,
    roomCode,
    myPlayerId: existing?.id || myPlayerId,
    myProfileId: profileId,
    myName: name,
    initialRow: freshRow || row,
    onLobby, onState, onChat, onStatus,
  });

  onWelcome?.(existing?.id || myPlayerId, freshRow?.lobby || row.lobby);
  return handle;
}

// Room code generator preserved from net.js so callers stay identical.
export function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
