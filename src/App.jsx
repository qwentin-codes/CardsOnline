import { Component, useEffect, useRef, useState } from 'react';
import { createHost, createClient, generateRoomCode } from './realtimeNet.js';
import { Stats } from './Stats.jsx';
import { skipboGame } from './games/skipbo/index.js';
import { thirtyoneGame } from './games/thirtyone/index.js';

// Thin error boundary so a render crash inside the game (e.g. during
// the end-of-round reveal) surfaces the real exception instead of
// leaving a blank screen — React eats the error silently otherwise.
class GameErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null, info: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    this.setState({ info });
    console.error('[GameErrorBoundary]', error, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      const err = this.state.error;
      // Safari's error.stack omits the message line; explicit display.
      const name = err?.name || 'Error';
      const message = err?.message || String(err);
      const stack = err?.stack || '';
      const componentStack = this.state.info?.componentStack || '';
      return (
        <div style={{ padding: 24, maxWidth: 560, margin: '40px auto', color: '#fecaca' }}>
          <h2 style={{ marginTop: 0 }}>Game crashed</h2>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, color: '#fee2e2' }}>
            {name}: {message}
          </div>
          {componentStack && (
            <>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10, marginBottom: 4 }}>Component stack:</div>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, background: 'rgba(0,0,0,0.3)', padding: 10, borderRadius: 8 }}>
                {componentStack.trim()}
              </pre>
            </>
          )}
          {stack && (
            <>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10, marginBottom: 4 }}>Stack:</div>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, background: 'rgba(0,0,0,0.3)', padding: 10, borderRadius: 8 }}>
                {stack}
              </pre>
            </>
          )}
          <button onClick={() => { this.setState({ error: null, info: null }); this.props.onReset?.(); }} style={{ marginTop: 12 }}>
            Back to home
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Registry of available online card games keyed by the ?game=... URL param.
const GAMES = {
  skipbo: skipboGame,
  thirtyone: thirtyoneGame,
};

// Resolve once at module load. The ?game= param survives reloads and
// can be linked to directly; defaults to Skip-Bo.
function resolveGame() {
  if (typeof window === 'undefined') return skipboGame;
  const param = new URLSearchParams(window.location.search).get('game');
  return GAMES[param] || skipboGame;
}

const currentGame = resolveGame();
const { Game, Lobby, createGame, applyAction, cpuPlan, requiredDecks, maxPlayers: MAX_PLAYERS } = currentGame;
import { getProfile, recordGame, setProfile, selectProfile, clearProfile } from './stats.js';
import {
  backendEnabled,
  createRoom,
  updateRoom,
  deleteRoom,
  subscribeOpenRooms,
  HEARTBEAT_MS,
} from './rooms.js';
import { listProfiles, createProfile, touchProfile } from './profiles.js';

const NAME_KEY = 'skipbo.name';
const HUMAN_ID = 'human';
const DEFAULT_PRACTICE_RULES = { stockSize: 30, handSize: 5, maxDiscardDepth: null };

export default function App() {
  const [phase, setPhase] = useState('home'); // home | connecting | lobby | game
  const [mode, setMode] = useState(null); // 'host' | 'client' | 'practice'
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) || '');
  // Pre-fill the join code from ?room=XXXX if an invite link was used.
  // Invitees land on the home screen with the code already in the input
  // so they can confirm and join; a host who lost their tab can likewise
  // click Create to reclaim the same code.
  const [joinCode, setJoinCode] = useState(() => {
    if (typeof window === 'undefined') return '';
    const raw = new URLSearchParams(window.location.search).get('room') || '';
    return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });
  const [error, setError] = useState(null);
  const [cpuCount, setCpuCount] = useState(2);
  const [cpuDifficulties, setCpuDifficulties] = useState(['normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal']);
  const [practiceRules, setPracticeRules] = useState(DEFAULT_PRACTICE_RULES);
  const setCpuDifficultyAt = (idx, value) => {
    setCpuDifficulties((prev) => {
      const next = [...prev];
      while (next.length <= idx) next.push('normal');
      next[idx] = value;
      return next;
    });
  };

  const [net, setNet] = useState(null); // host or client handle
  const [lobbyState, setLobbyState] = useState(null);
  const [gameState, setGameState] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [myId, setMyId] = useState(null);
  const [peerStatus, setPeerStatus] = useState(null);
  const [openRooms, setOpenRooms] = useState([]);
  const [profileList, setProfileList] = useState([]);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [currentProfile, setCurrentProfile] = useState(() => {
    try { return JSON.parse(localStorage.getItem('skipbo.profile')) || null; } catch { return null; }
  });
  const [newProfileName, setNewProfileName] = useState('');
  const practiceStateRef = useRef(null);
  const cpuTimerRef = useRef(null);
  const recordedGameRef = useRef(false);

  // Fetch the profile directory so the home screen can show the
  // "who are you?" picker. Listed by most-recently-seen first.
  useEffect(() => {
    if (!backendEnabled) { setProfileLoaded(true); return; }
    let cancelled = false;
    listProfiles().then((list) => {
      if (cancelled) return;
      setProfileList(list);
      setProfileLoaded(true);
      // If the cached profile id no longer exists in the directory
      // (e.g., deleted elsewhere, or a legacy local-only id), drop it
      // so the picker re-appears.
      if (currentProfile && !list.some((p) => p.id === currentProfile.id)) {
        setCurrentProfile(null);
        clearProfile();
      }
    });
    return () => { cancelled = true; };
  }, []);

  const pickProfile = (profile) => {
    const saved = selectProfile(profile);
    setCurrentProfile(saved);
    setName(saved.name);
    touchProfile(saved.id);
  };

  const addProfile = async () => {
    const clean = newProfileName.trim().slice(0, 20);
    if (!clean) { setError('Please enter a name.'); return; }
    setError(null);
    const res = await createProfile(clean);
    if (!res.ok) { setError(res.error); return; }
    setProfileList((list) => [res.profile, ...list.filter((p) => p.id !== res.profile.id)]);
    pickProfile(res.profile);
    setNewProfileName('');
  };

  const switchProfile = () => {
    clearProfile();
    setCurrentProfile(null);
    setName('');
  };

  useEffect(() => {
    return () => { net?.destroy(); };
  }, [net]);

  // Public room list: poll while idle on the home screen so players
  // can click a live room instead of typing a code.
  useEffect(() => {
    if (phase !== 'home' || !backendEnabled) return;
    const unsubscribe = subscribeOpenRooms(setOpenRooms, currentGame.id);
    return () => { unsubscribe(); setOpenRooms([]); };
  }, [phase]);

  // Host-side room advertisement: keep player_count/started fresh on
  // every lobby change, and heartbeat so stale rooms drop off the list
  // if the host closes the tab without cleanup.
  useEffect(() => {
    if (mode !== 'host' || !net || !lobbyState) return;
    updateRoom(net.roomCode, {
      player_count: lobbyState.players.length,
      started: lobbyState.started,
    });
  }, [mode, net, lobbyState]);

  useEffect(() => {
    if (mode !== 'host' || !net) return;
    const timer = setInterval(() => { updateRoom(net.roomCode, {}); }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [mode, net]);

  useEffect(() => {
    if (name) {
      localStorage.setItem(NAME_KEY, name);
      setProfile({ name });
    }
  }, [name]);

  // Record the game outcome exactly once when the game ends.
  useEffect(() => {
    if (!gameState?.winner || recordedGameRef.current || !myId) return;
    recordedGameRef.current = true;
    try {
      const profile = getProfile();
      recordGame(gameState, profile.id, myId, currentGame.id);
    } catch (err) {
      console.error('failed to record game', err);
    }
  }, [gameState?.winner, myId]);

  const goHome = () => {
    if (mode === 'host' && net?.roomCode) deleteRoom(net.roomCode);
    net?.destroy();
    if (cpuTimerRef.current) { clearTimeout(cpuTimerRef.current); cpuTimerRef.current = null; }
    practiceStateRef.current = null;
    recordedGameRef.current = false;
    setNet(null);
    setLobbyState(null);
    setGameState(null);
    setChatMessages([]);
    setMyId(null);
    setPeerStatus(null);
    setMode(null);
    setError(null);
    setPhase('home');
    clearRoomFromUrl();
  };

  const onLobby = (lobby) => {
    setLobbyState(lobby);
    if (lobby.started) setPhase('game');
    else setPhase('lobby');
  };
  const onState = (s) => { setGameState(s); setPhase('game'); };
  const onChat = (msg) => setChatMessages((prev) => [...prev, msg]);
  const onErr = (msg) => setError(typeof msg === 'string' ? msg : (msg?.message || String(msg)));

  async function host() {
    setError(null);
    if (!name.trim()) { setError('Enter a name first.'); return; }
    setPhase('connecting');
    // Prefer a code carried in the URL so a host who closed their tab
    // can reclaim the same code by clicking their invite link and
    // pressing Create again. Falls back to a fresh random code.
    const urlCode = new URLSearchParams(window.location.search).get('room') || '';
    const cleanUrlCode = urlCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    const code = cleanUrlCode.length === 4 ? cleanUrlCode : generateRoomCode();
    try {
      const h = await createHost({
        game: currentGame,
        roomCode: code,
        hostName: name.trim(),
        hostProfileId: getProfile().id,
        onLobby, onState, onChat, onError: onErr,
        onStatus: setPeerStatus,
      });
      setNet(h);
      setMode('host');
      setMyId(h.hostId);
      setLobbyState(h.getLobby());
      setPhase('lobby');
      writeRoomToUrl(code);
    } catch (err) {
      setError(err.message || String(err));
      setPhase('home');
    }
  }

  // Mirror the room code into the URL so the host (and anyone they
  // share with) can bookmark the link — reloading or clicking it later
  // pre-fills the same code and lets them rehost / rejoin.
  function writeRoomToUrl(code) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('game', currentGame.id);
      url.searchParams.set('room', code);
      window.history.replaceState(null, '', url.toString());
    } catch {}
  }

  function clearRoomFromUrl() {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('room');
      window.history.replaceState(null, '', url.toString());
    } catch {}
  }

  function inviteUrl(code) {
    try {
      const url = new URL(window.location.origin + window.location.pathname);
      url.searchParams.set('game', currentGame.id);
      url.searchParams.set('room', code);
      return url.toString();
    } catch {
      return '';
    }
  }

  async function join(codeArg) {
    setError(null);
    const code = (codeArg || joinCode).toUpperCase();
    if (!name.trim()) { setError('Enter a name first.'); return; }
    if (!/^[A-Z0-9]{4}$/.test(code)) { setError('Enter a 4-character room code.'); return; }
    setPhase('connecting');
    try {
      const c = await createClient({
        game: currentGame,
        roomCode: code,
        name: name.trim(),
        profileId: getProfile().id,
        onLobby, onState, onChat,
        onError: onErr,
        onStatus: setPeerStatus,
        onWelcome: (id) => setMyId(id),
      });
      setNet(c);
      setMode('client');
      setMyId(c.myPlayerId);
      writeRoomToUrl(code);
    } catch (err) {
      setError(err.message || String(err));
      setPhase('home');
    }
  }

  function openPracticeSetup() {
    setError(null);
    setPhase('practice-setup');
  }

  function startPractice() {
    setError(null);
    const humanName = name.trim() || 'You';
    // Respect the active game's player cap regardless of what state
    // was carried over from another game's setup screen.
    const maxCpus = Math.max(1, (currentGame.maxPlayers ?? 8) - 1);
    const effectiveCpus = Math.max(1, Math.min(cpuCount, maxCpus));
    const ids = [HUMAN_ID];
    const names = { [HUMAN_ID]: humanName };
    for (let i = 0; i < effectiveCpus; i++) {
      const id = `cpu${i + 1}`;
      ids.push(id);
      names[id] = `CPU ${i + 1}`;
    }
    try {
      // Merge descriptor defaults with whatever the setup screen
      // configured (practiceRules might carry shape from a different
      // game, so defaults win for keys the current game expects).
      const rulesForGame = { ...currentGame.defaultRules, ...practiceRules };
      const g = createGame(ids, names, rulesForGame);
      // Link the human seat to the current profile so recorded games
      // know which profile to credit. CPUs stay null.
      if (g.players[HUMAN_ID]) g.players[HUMAN_ID].profileId = getProfile().id;
      // Stamp each CPU player with the difficulty picked on the setup
      // screen so scheduleCpuTurn can look it up on each turn.
      for (let i = 0; i < effectiveCpus; i++) {
        const id = `cpu${i + 1}`;
        if (g.players[id]) g.players[id].cpuDifficulty = cpuDifficulties[i] || 'normal';
      }
      practiceStateRef.current = g;
      setGameState(g);
      setMyId(HUMAN_ID);
      setMode('practice');
      setPhase('game');
      scheduleCpuTurn(g);
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  function scheduleCpuTurn(state) {
    if (cpuTimerRef.current) { clearTimeout(cpuTimerRef.current); cpuTimerRef.current = null; }
    if (!state || state.winner) return;
    if (state.turn === HUMAN_ID) return;
    const difficulty = state.players[state.turn]?.cpuDifficulty || 'normal';
    const plan = cpuPlan(state, state.turn, difficulty);
    // Delay the first CPU action by the turn-announcement banner
    // duration (see .turn-announcement in styles.css, ~900ms) so the
    // flight / fly-in animations don't step on the banner. Passed as
    // a "headStart" to playCpuActions which adds it only to i===0.
    const TURN_BANNER_MS = 950;
    playCpuActions(state, plan, 0, TURN_BANNER_MS);
  }

  function playCpuActions(state, actions, i, headStart = 0) {
    if (i >= actions.length) {
      // Pause between CPU turns so the final move reads clearly.
      cpuTimerRef.current = setTimeout(() => scheduleCpuTurn(state), currentGame.botBetweenTurns ?? 900);
      return;
    }
    const act = actions[i];
    // Let the active game pick its own per-action cadence (Skip-Bo
    // plays fast plays + slow discards; other games can provide their own pacing.
    const baseDelay = currentGame.botActionDelay ? currentGame.botActionDelay(act, state) : 1500;
    const delay = baseDelay + (i === 0 ? headStart : 0);
    cpuTimerRef.current = setTimeout(() => {
      const res = applyAction(state, state.turn, act);
      if (!res.ok) {
        setError(`CPU error: ${res.error}`);
        scheduleCpuTurn(state);
        return;
      }
      practiceStateRef.current = res.state;
      setGameState(res.state);
      playCpuActions(res.state, actions, i + 1);
    }, delay);
  }
  // (headStart only applies to the first action of a turn; follow-up
  // actions use the normal cadence.)

  const onStart = async () => {
    const res = await net?.startGame?.();
    if (res && !res.ok) setError(res.error);
  };
  const onUpdateRules = (rules) => net?.updateRules?.(rules);
  const onRename = (newName) => {
    setName(newName);
    if (mode === 'host') net?.setName?.(newName);
    else net?.sendRename?.(newName);
  };
  const onSendChat = (text) => net?.sendChat?.(text);
  const onAction = async (action) => {
    if (mode === 'practice') {
      const s = practiceStateRef.current;
      if (!s) return;
      const res = applyAction(s, HUMAN_ID, action);
      if (!res.ok) { setError(res.error); return; }
      setError(null);
      practiceStateRef.current = res.state;
      setGameState(res.state);
      // Always re-scheduleCpuTurn: it clears any stale pending CPU
      // timer, then either arms a new one for a CPU turn or no-ops
      // when it's the human's turn. Important for undo, which can
      // flip the turn back to the human after the CPU was already
      // queued.
      scheduleCpuTurn(res.state);
      return;
    }
    // Online rooms: all players submit their own actions directly.
    // The authoritative MongoDB write + version check happens inside submitAction;
    // stale-state conflicts surface as {ok:false, error:'stale-state'} and
    // the subscription will push the correct state shortly, so we drop
    // the error silently rather than flashing an alarming banner.
    const res = await net?.submitAction?.(action);
    if (res && !res.ok && res.error !== 'stale-state') setError(res.error);
  };

  if (phase === 'stats') {
    return (
      <div className="app">
        <Stats onBack={() => setPhase('home')} gameType={currentGame.id} gameName={currentGame.name} />
      </div>
    );
  }

  if (phase === 'home' || phase === 'connecting') {
    const needsProfile = false;
    return (
      <div className="app">
        <div className="lobby">
          <h1>Online Card Games</h1>
          <div style={{ color: 'var(--muted)', marginTop: -8, marginBottom: 8 }}>{currentGame.name}</div>

          {needsProfile ? (
            <>
              <div className="card-panel">
                <div style={{ fontSize: 16, fontWeight: 600, alignSelf: 'flex-start' }}>Who are you?</div>
                {profileList.length > 0 ? (
                  <>
                    <div style={{ fontSize: 13, color: 'var(--muted)', alignSelf: 'flex-start' }}>Tap your name:</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {profileList.map((p) => (
                        <button key={p.id} className="secondary" onClick={() => pickProfile(p)}>
                          {p.name}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--muted)' }}>No profiles yet — be the first.</div>
                )}
              </div>
              <div className="card-panel">
                <div style={{ fontSize: 13, color: 'var(--muted)', alignSelf: 'flex-start' }}>Someone new?</div>
                <input
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  maxLength={20}
                  placeholder="Enter your name"
                  onKeyDown={(e) => { if (e.key === 'Enter') addProfile(); }}
                />
                <button onClick={addProfile}>Create profile</button>
              </div>
              {error && <div className="error">{error}</div>}
            </>
          ) : (
            <div className="card-panel">
              <div style={{ fontSize: 13, color: 'var(--muted)', alignSelf: 'flex-start' }}>Display name</div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={20}
                placeholder="Enter your name"
              />
            </div>
          )}

          {!needsProfile && (<>

          <div className="card-panel">
            <div style={{ fontSize: 13, color: 'var(--muted)', alignSelf: 'flex-start' }}>Game</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {Object.values(GAMES).map((g) => (
                <button
                  key={g.id}
                  className={g.id === currentGame.id ? '' : 'secondary'}
                  style={{ flex: 1, minWidth: 120 }}
                  onClick={() => {
                    if (g.id === currentGame.id) return;
                    const url = new URL(window.location.href);
                    url.searchParams.set('game', g.id);
                    window.location.href = url.toString();
                  }}
                >
                  {g.name}
                </button>
              ))}
            </div>
          </div>

          {backendEnabled && openRooms.length > 0 && (
            <div className="card-panel">
              <div style={{ fontSize: 13, color: 'var(--muted)', alignSelf: 'flex-start' }}>Open rooms</div>
              {openRooms.map((r) => {
                // Lobby rooms: block the tile if the room is at max
                // capacity. Started rooms stay clickable no matter the
                // count — the realtimeNet joiner will reclaim the
                // player's seat by profileId and bounce strangers with
                // "game already in progress".
                const full = !r.started && r.player_count >= r.max_players;
                const rightLabel = r.started
                  ? 'in progress'
                  : full ? 'full' : `${r.player_count}/${r.max_players}`;
                return (
                  <button
                    key={r.code}
                    className="secondary"
                    onClick={() => join(r.code)}
                    disabled={phase === 'connecting' || full}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <strong>{r.host_name}</strong> · {r.code}
                    </span>
                    <span style={{
                      color: r.started ? 'var(--accent-2, var(--gold))' : 'var(--muted)',
                      fontSize: 13,
                      flexShrink: 0,
                    }}>
                      {rightLabel}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="card-panel">
            <button onClick={host} disabled={phase === 'connecting'}>
              {phase === 'connecting' && mode === null ? 'Creating room…' : 'Create a room'}
            </button>
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>or join an existing one:</div>
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
              placeholder="ROOM"
              maxLength={4}
              style={{ textAlign: 'center', letterSpacing: 6, fontSize: 22, fontFamily: 'ui-monospace, monospace' }}
            />
            <button className="secondary" onClick={() => join()} disabled={phase === 'connecting'}>
              {phase === 'connecting' ? 'Joining…' : 'Join room'}
            </button>
          </div>

          <div className="card-panel">
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>No friends around? Play offline:</div>
            <button className="secondary" onClick={openPracticeSetup} disabled={phase === 'connecting'}>
              Play vs CPU
            </button>
          </div>
          </>)}

          {error && <div className="error">{error}</div>}
          {peerStatus && <PeerStatusLine status={peerStatus} />}

          <button className="secondary" style={{ fontSize: 13 }} onClick={() => setPhase('stats')}>
            View stats
          </button>

          <div style={{ fontSize: 11, color: 'var(--muted)', maxWidth: 360 }}>
            Online rooms sync through MongoDB on Vercel. Keep this tab open while playing for the smoothest turns.
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'practice-setup' && currentGame.id === 'thirtyone') {
    const humanName = name.trim() || 'You';
    const maxCpus = Math.min(currentGame.maxPlayers - 1, 5);
    const safeCpus = Math.max(1, Math.min(cpuCount, maxCpus));
    const playerCount = 1 + safeCpus;
    const startingLives = practiceRules.startingLives ?? currentGame.defaultRules.startingLives ?? 3;
    const lifeOptions = [[2, 2], [3, 3], [4, 4], [5, 5]];
    const knockerPenalty = practiceRules.knockerPenalty ?? currentGame.defaultRules.knockerPenalty ?? 2;
    const knockerOptions = [['−2 lives (classic)', 2], ['−1 life (soft)', 1]];
    const patchRules = (patch) => setPracticeRules((r) => ({ ...currentGame.defaultRules, ...r, ...patch }));
    return (
      <div className="app">
        <div className="lobby">
          <h1 style={{ fontSize: 32 }}>Thirty-One vs CPU</h1>
          <div className="card-panel">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Players</div>
            <div style={{ fontSize: 14, color: 'var(--muted)' }}>
              {humanName} + {safeCpus} CPU{safeCpus === 1 ? '' : 's'} ({playerCount} total)
            </div>
            <PracticeRuleRow
              label="CPU opponents"
              value={safeCpus}
              options={Array.from({ length: maxCpus }, (_, i) => [i + 1, i + 1])}
              onChange={(v) => setCpuCount(v)}
            />
            <CpuDifficultyList
              count={safeCpus}
              values={cpuDifficulties}
              onChange={setCpuDifficultyAt}
            />
          </div>
          <div className="card-panel">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Rules</div>
            <PracticeRuleRow
              label="Starting lives"
              value={startingLives}
              options={lifeOptions}
              onChange={(v) => patchRules({ startingLives: v })}
            />
            <PracticeRuleRow
              label="Knocker-lowest penalty"
              value={knockerPenalty}
              options={knockerOptions}
              onChange={(v) => patchRules({ knockerPenalty: v })}
            />
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
              3 cards, best same-suit sum wins. Three of a kind = 30. Hit 31
              to blitz (others lose a life). Knock to call showdown — if
              you're lowest you lose {knockerPenalty} life{knockerPenalty === 1 ? '' : 's'}. Last
              player with lives wins.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, width: '100%', maxWidth: 400 }}>
            <button className="secondary" onClick={goHome} style={{ flex: 1 }}>Back</button>
            <button onClick={startPractice} style={{ flex: 2 }}>Start game</button>
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    );
  }

  if (phase === 'practice-setup') {
    const playerCount = 1 + cpuCount;
    const effStock = practiceRules.stockSize;
    const decks = requiredDecks(playerCount, effStock, practiceRules.handSize);
    const humanName = (name.trim() || 'You');
    return (
      <div className="app">
        <div className="lobby">
          <h1 style={{ fontSize: 32 }}>Practice vs CPU</h1>

          <div className="card-panel">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Players</div>
            <div style={{ fontSize: 14, color: 'var(--muted)' }}>
              {humanName} + {cpuCount} CPU{cpuCount === 1 ? '' : 's'} ({playerCount} total)
            </div>
            <PracticeRuleRow
              label="CPU opponents"
              value={cpuCount}
              options={[1, 2, 3, 4, 5, 6, 7].map((n) => [n, n])}
              onChange={(v) => setCpuCount(v)}
            />
            <CpuDifficultyList
              count={cpuCount}
              values={cpuDifficulties}
              onChange={setCpuDifficultyAt}
            />
          </div>

          <div className="card-panel">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Rules</div>
            <PracticeRuleRow
              label="Stockpile size"
              value={practiceRules.stockSize}
              options={[[5, 5], [10, 10], [15, 15], [20, 20], [25, 25], [30, 30], [35, 35], [40, 40], [45, 45], [50, 50]]}
              onChange={(v) => setPracticeRules((r) => ({ ...r, stockSize: v }))}
            />
            <PracticeRuleRow
              label="Hand size"
              value={practiceRules.handSize}
              options={[[5, 5], [10, 10]]}
              onChange={(v) => setPracticeRules((r) => ({ ...r, handSize: v }))}
            />
            <PracticeRuleRow
              label="Max discard depth"
              value={practiceRules.maxDiscardDepth ?? 'unlimited'}
              options={[[4, 4], [6, 6], [8, 8], ['unlimited', null]]}
              onChange={(v) => setPracticeRules((r) => ({ ...r, maxDiscardDepth: v }))}
            />
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
              {decks === 1 ? '1 deck' : `${decks} decks`}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, width: '100%', maxWidth: 400 }}>
            <button className="secondary" onClick={goHome} style={{ flex: 1 }}>Back</button>
            <button onClick={startPractice} style={{ flex: 2 }}>Start game</button>
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    );
  }

  if (phase === 'lobby' && lobbyState) {
    return (
      <div className="app">
        <Lobby
          lobby={lobbyState}
          isHost={mode === 'host'}
          myId={myId}
          onStart={onStart}
          onUpdateRules={onUpdateRules}
          onRename={onRename}
          onAddCpu={mode === 'host' ? ((difficulty) => net?.addCpu?.(difficulty)) : null}
          onRemoveCpu={mode === 'host' ? ((id) => net?.removeCpu?.(id)) : null}
          onSetCpuDifficulty={mode === 'host' ? ((id, difficulty) => net?.setCpuDifficulty?.(id, difficulty)) : null}
          chatMessages={chatMessages}
          onSendChat={onSendChat}
          onLeave={goHome}
          error={error}
          peerStatus={peerStatus}
          inviteUrl={lobbyState.roomCode ? inviteUrl(lobbyState.roomCode) : ''}
        />
      </div>
    );
  }

  if (phase === 'game' && gameState) {
    const displayState = { ...gameState, roomCode: lobbyState?.roomCode || (mode === 'practice' ? 'SOLO' : '') };
    return (
      <div className="app">
        <GameErrorBoundary onReset={goHome}>
        <Game
          state={displayState}
          myId={myId}
          onAction={onAction}
          onRequestUndo={mode === 'practice' ? null : () => net?.requestUndo?.()}
          onVoteUndo={mode === 'practice' ? null : (yes) => net?.castUndoVote?.(yes)}
          chatMessages={chatMessages}
          onSendChat={onSendChat}
          onLeave={goHome}
          error={error}
          hideChat={mode === 'practice'}
        />
        </GameErrorBoundary>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="lobby"><div>Loading…</div></div>
    </div>
  );
}

export function PeerStatusLine({ status, compact }) {
  if (!status) return null;
  let color = 'var(--muted)';
  let text = '';
  if (status.kind === 'connecting') {
    color = 'var(--gold)';
    text = status.phase === 'host' ? 'Reaching host…' : 'Connecting to signaling…';
  } else if (status.kind === 'open') {
    color = 'var(--accent-2)';
    text = compact ? 'Connected' : `Connected (peer ${status.peerId?.slice(-6) || ''})`;
  } else if (status.kind === 'disconnected') {
    color = 'var(--gold)';
    text = 'Disconnected from signaling server';
  } else if (status.kind === 'closed') {
    color = 'var(--muted)';
    text = 'Closed';
  } else if (status.kind === 'error') {
    color = 'var(--danger)';
    text = status.message || `Error: ${status.type}`;
  }
  return (
    <div style={{
      fontSize: 11,
      color,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      maxWidth: 400,
      textAlign: 'center',
    }}>
      <span style={{
        display: 'inline-block',
        width: 8, height: 8, borderRadius: '50%',
        background: color,
        boxShadow: `0 0 6px ${color}`,
      }} />
      <span>{text}</span>
    </div>
  );
}

function CpuDifficultyList({ count, values, onChange }) {
  if (!count) return null;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const val = values[i] || 'normal';
    rows.push(
      <div
        key={i}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}
      >
        <div style={{ fontSize: 13, color: 'var(--muted)', flex: 1 }}>CPU {i + 1}</div>
        <select
          value={val}
          onChange={(e) => onChange(i, e.target.value)}
          style={{
            background: 'var(--panel-2)',
            color: 'var(--text)',
            border: '1px solid #2a5a48',
            borderRadius: 6,
            padding: '4px 8px',
            font: 'inherit',
            fontSize: 13,
          }}
        >
          <option value="easy">Easy</option>
          <option value="normal">Normal</option>
          <option value="hard">Hard</option>
        </select>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 2 }}>Difficulty</div>
      {rows}
    </div>
  );
}

function PracticeRuleRow({ label, value, detail, options, onChange }) {
  // Options are [label, value] tuples. The <option> element must use
  // the *value* (not the label) in its HTML value attribute so the
  // controlled <select value={value}> has a matching option — otherwise
  // the browser silently snaps back to the first option and the dropdown
  // displays something different from what's actually in state.
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #2a5a48' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14 }}>{label}</div>
        {detail && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{detail}</div>}
      </div>
      <select
        value={String(value)}
        onChange={(e) => {
          const opt = options.find(([, v]) => String(v) === e.target.value);
          if (opt) onChange(opt[1]);
        }}
        style={{
          background: 'var(--panel-2)',
          color: 'var(--text)',
          border: '1px solid #2a5a48',
          borderRadius: 6,
          padding: '6px 8px',
          font: 'inherit',
        }}
      >
        {options.map(([lbl, v]) => (
          <option key={String(v)} value={String(v)}>{lbl}</option>
        ))}
      </select>
    </div>
  );
}
