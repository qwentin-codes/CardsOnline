import { useEffect, useState } from 'react';
import { getProfile, setProfile, getHistory, computeStats, formatDuration, clearHistory } from './stats.js';
import { fetchHistoryForProfile, backendEnabled } from './profiles.js';

// Normalize a MongoDB game_records row so it can share GameRow + the
// stats helper with localStorage records.
function adaptCloudRecord(row) {
  const players = row.players || [];
  const winner = players.find((p) => p.isWinner);
  const endedAt = row.ended_at ? new Date(row.ended_at).getTime() : Date.now();
  const startedAt = row.started_at ? new Date(row.started_at).getTime() : null;
  return {
    id: row.id,
    endedAt,
    startedAt,
    durationMs: row.duration_ms ?? (startedAt ? endedAt - startedAt : null),
    turnCount: row.turn_count,
    didIWin: !!row.won,
    winnerName: winner?.name || null,
    rules: row.rules || {},
    deckCount: row.deck_count || 1,
    players,
  };
}

export function Stats({ onBack, gameType = 'skipbo', gameName = 'Skip-Bo' }) {
  const [profile, setProfileState] = useState(getProfile());
  const [history, setHistory] = useState(() => {
    // Start with localStorage so the UI has something to render while
    // cloud data loads. Cloud results will replace this on arrival.
    return getHistory().slice().reverse();
  });
  const [loadingCloud, setLoadingCloud] = useState(Boolean(backendEnabled && profile?.id));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile);
  const stats = computeStats(history);

  useEffect(() => {
    if (!backendEnabled || !profile?.id) return;
    let cancelled = false;
    fetchHistoryForProfile(profile.id, { gameType, limit: 100 }).then((rows) => {
      if (cancelled) return;
      setHistory(rows.map(adaptCloudRecord));
      setLoadingCloud(false);
    });
    return () => { cancelled = true; };
  }, [profile?.id, gameType]);

  const saveProfile = () => {
    const cleanName = String(draft.name || '').slice(0, 20).trim();
    const next = setProfile({ name: cleanName || 'Player', color: draft.color });
    setProfileState(next);
    setEditing(false);
  };

  const onClearHistory = () => {
    if (!confirm('Clear local cached history? Cloud history will repopulate on the next load.')) return;
    clearHistory();
    if (!backendEnabled) setHistory([]);
  };

  const recent = history.slice(0, 20);

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 620, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 24 }}>{gameName} Stats</h2>
        <button className="secondary" onClick={onBack}>Back</button>
      </div>

      {/* Profile */}
      <div className="card-panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 48, height: 48, borderRadius: '50%',
            background: profile.color, color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, fontSize: 22,
          }}>
            {(profile.name || '?').slice(0, 1).toUpperCase()}
          </div>
          <div style={{ flex: 1 }}>
            {editing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  maxLength={20}
                  placeholder="Your name"
                />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {['#38bdf8', '#22c55e', '#ec4899', '#f59e0b', '#a855f7', '#14b8a6', '#f43f5e', '#eab308'].map((c) => (
                    <div key={c}
                      onClick={() => setDraft({ ...draft, color: c })}
                      style={{
                        width: 24, height: 24, borderRadius: '50%',
                        background: c, cursor: 'pointer',
                        border: draft.color === c ? '2px solid white' : '2px solid transparent',
                      }}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <>
                <div style={{ fontWeight: 600, fontSize: 18 }}>{profile.name || 'Unnamed'}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Since {new Date(profile.createdAt).toLocaleDateString()}
                </div>
              </>
            )}
          </div>
          {editing ? (
            <>
              <button onClick={saveProfile}>Save</button>
              <button className="secondary" onClick={() => { setDraft(profile); setEditing(false); }}>Cancel</button>
            </>
          ) : (
            <button className="secondary" onClick={() => { setDraft(profile); setEditing(true); }}>Edit</button>
          )}
        </div>
      </div>

      {/* Lifetime stats — split by opponent type. */}
      {(() => {
        const vsHumanHistory = history.filter((r) => !isCpuGame(r));
        const vsCpuHistory = history.filter(isCpuGame);
        const vsHuman = computeStats(vsHumanHistory);
        const vsCpu = computeStats(vsCpuHistory);
        return (
          <>
            <LifetimePanel title="vs Humans" s={vsHuman} syncing={loadingCloud} />
            <LifetimePanel title="vs CPUs" s={vsCpu} />
          </>
        );
      })()}

      {/* Head-to-head: per-opponent record, humans only. */}
      {(() => {
        const byProfile = new Map(); // profileId -> { name, wins, losses }
        for (const r of history) {
          if (isCpuGame(r)) continue;
          const won = r.didIWin;
          for (const p of r.players || []) {
            if (!p.profileId || p.profileId === profile.id) continue;
            const entry = byProfile.get(p.profileId) || { name: p.name, wins: 0, losses: 0 };
            entry.name = p.name; // keep most recent spelling
            if (won) entry.wins += 1; else entry.losses += 1;
            byProfile.set(p.profileId, entry);
          }
        }
        const rows = [...byProfile.values()].sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses));
        if (rows.length === 0) return null;
        return (
          <div className="card-panel">
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Head-to-head</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {rows.map((row) => {
                const total = row.wins + row.losses;
                const pct = total ? Math.round((row.wins / total) * 100) : 0;
                return (
                  <div key={row.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--panel-2)', borderRadius: 8, padding: '6px 10px', fontSize: 13 }}>
                    <div style={{ fontWeight: 600 }}>{row.name}</div>
                    <div style={{ color: 'var(--muted)' }}>
                      <span style={{ color: 'var(--accent-2)' }}>{row.wins}W</span> ·
                      <span> {row.losses}L</span> ·
                      <span> {pct}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* History */}
      <div className="card-panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontWeight: 600 }}>Recent games</div>
          {history.length > 0 && !backendEnabled && (
            <button className="secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={onClearHistory}>
              Clear
            </button>
          )}
        </div>
        {recent.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: 13 }}>
            {loadingCloud ? 'Loading…' : "No games played yet. Finish a game and it'll show up here."}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {recent.map((r) => (
              <GameRow key={r.id} record={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Returns true if the record includes any CPU opponent. Works on both
// old (no profileIds) and new (profileId-aware) snapshots by pattern-
// matching the legacy gameId/name convention.
function isCpuGame(record) {
  const players = record.players || [];
  return players.some((p) => {
    if (typeof p.gameId === 'string' && /^cpu\d+$/i.test(p.gameId)) return true;
    if (typeof p.name === 'string' && /^CPU\s?\d+$/.test(p.name)) return true;
    return false;
  });
}

function LifetimePanel({ title, s, syncing }) {
  return (
    <div className="card-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        {syncing && <div style={{ fontSize: 11, color: 'var(--muted)' }}>syncing…</div>}
      </div>
      {s.total === 0 ? (
        <div style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: 13 }}>No games yet.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          <Stat label="Games" value={s.total} />
          <Stat label="Wins" value={s.wins} />
          <Stat label="Win %" value={`${s.winPct}%`} />
          <Stat label="Avg turns" value={s.avgTurnsPerGame || '—'} />
          <Stat label="Avg length" value={formatDuration(s.avgDurationMs)} />
          <Stat label="Losses" value={s.losses} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ background: 'var(--panel-2)', borderRadius: 8, padding: '8px 10px' }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 18 }}>{value}</div>
    </div>
  );
}

function GameRow({ record }) {
  const date = new Date(record.endedAt);
  const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const playerList = (record.players || []).map((p) => p.name).join(', ');
  const stockSize = record.rules?.stockSize ?? record.rules?.stock_size;
  return (
    <div style={{ background: 'var(--panel-2)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span style={{ color: record.didIWin ? 'var(--accent-2)' : 'var(--muted)', fontWeight: 700 }}>
            {record.didIWin ? '🏆 Win' : 'Loss'}
          </span>
          <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
            · {record.winnerName || '?'} won in {record.turnCount ?? '?'} turns
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{dateStr}</div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
        {playerList}
        {record.durationMs ? ` · ${formatDuration(record.durationMs)}` : ''}
        {record.deckCount > 1 ? ` · ${record.deckCount} decks` : ''}
        {stockSize ? ` · stock ${stockSize}` : ''}
      </div>
    </div>
  );
}
