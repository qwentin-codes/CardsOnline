import { useState } from 'react';
import { Chat } from '../../Chat.jsx';
import { MAX_PLAYERS, MIN_PLAYERS } from './engine.js';

export function Lobby({
  lobby, isHost, myId, onStart, onUpdateRules, onRename,
  onAddCpu, onRemoveCpu, onSetCpuDifficulty,
  chatMessages, onSendChat, onLeave, error, peerStatus, inviteUrl,
}) {
  const [editingName, setEditingName] = useState(false);
  const me = lobby.players.find((p) => p.id === myId);
  const [nameDraft, setNameDraft] = useState(me?.name || '');
  const humanCount = lobby.players.filter((p) => !p.isCpu).length;
  const needsMorePlayers = lobby.players.length < MIN_PLAYERS;
  const needsAnotherHuman = humanCount < 2;
  const startDisabled = needsMorePlayers || needsAnotherHuman;
  const startLabel = needsMorePlayers
    ? `Need at least ${MIN_PLAYERS} players`
    : needsAnotherHuman
      ? 'Waiting for another human player to join'
      : 'Start game';
  const startingLives = lobby.rules?.startingLives ?? 3;
  const lifeOptions = [[2, 2], [3, 3], [4, 4], [5, 5]];
  const knockerPenalty = lobby.rules?.knockerPenalty ?? 2;
  const knockerOptions = [['−2 lives (classic)', 2], ['−1 life (soft)', 1]];

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 600, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Room code</div>
          <div className="room-code" style={{ fontSize: 28 }}>{lobby.roomCode}</div>
          {peerStatus && <StatusIndicator status={peerStatus} />}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {inviteUrl && <CopyInviteButton url={inviteUrl} />}
          <button className="secondary" onClick={onLeave}>Leave</button>
        </div>
      </div>

      <div style={{ background: 'var(--panel)', borderRadius: 10, padding: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          Players ({lobby.players.length}/{MAX_PLAYERS})
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {lobby.players.map((p) => (
            <PlayerRow
              key={p.id}
              player={p}
              isMe={p.id === myId}
              isHostSeat={p.id === lobby.hostId}
              canEditName={p.id === myId && !editingName}
              onBeginEditName={() => { setNameDraft(p.name); setEditingName(true); }}
              canManageCpu={isHost && p.isCpu}
              onSetCpuDifficulty={onSetCpuDifficulty}
              onRemoveCpu={onRemoveCpu}
            />
          ))}
        </div>
        {editingName && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} maxLength={20} />
            <button onClick={() => { onRename(nameDraft); setEditingName(false); }}>Save</button>
            <button className="secondary" onClick={() => setEditingName(false)}>Cancel</button>
          </div>
        )}
        {isHost && onAddCpu && lobby.players.length < MAX_PLAYERS && (
          <button
            className="secondary"
            style={{ marginTop: 10, padding: '6px 12px', fontSize: 13 }}
            onClick={() => onAddCpu('normal')}
          >
            + Add CPU
          </button>
        )}
      </div>

      <div style={{ background: 'var(--panel)', borderRadius: 10, padding: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Rules</div>
        <RuleRow
          label="Starting lives"
          value={startingLives}
          options={lifeOptions}
          disabled={!isHost}
          onChange={(v) => onUpdateRules?.({ startingLives: v })}
        />
        <RuleRow
          label="Knocker-lowest penalty"
          value={knockerPenalty}
          options={knockerOptions}
          disabled={!isHost}
          onChange={(v) => onUpdateRules?.({ knockerPenalty: v })}
        />
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
          3 cards each. Best same-suit sum wins. Three of a kind = 30.
          Reach 31 to blitz (everyone else loses a life). Knock to call
          showdown; if you're the lowest you lose {knockerPenalty} life{knockerPenalty === 1 ? '' : 's'}.
        </div>
      </div>

      {isHost ? (
        <button disabled={startDisabled} onClick={onStart}>{startLabel}</button>
      ) : (
        <div style={{ textAlign: 'center', color: 'var(--muted)' }}>Waiting for host to start…</div>
      )}

      {error && <div className="error">{error}</div>}

      <Chat messages={chatMessages} onSend={onSendChat} />
    </div>
  );
}

function PlayerRow({ player, isMe, isHostSeat, canEditName, onBeginEditName, canManageCpu, onSetCpuDifficulty, onRemoveCpu }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {player.isCpu && <span style={{ color: 'var(--muted)', marginRight: 6 }}>🤖</span>}
        {player.name}
        {isHostSeat && <span style={{ color: 'var(--accent)', marginLeft: 6 }}>(host)</span>}
        {isMe && <span style={{ color: 'var(--muted)', marginLeft: 6 }}>(you)</span>}
      </span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
        {canManageCpu && (
          <>
            <select
              value={player.cpuDifficulty || 'normal'}
              onChange={(e) => onSetCpuDifficulty?.(player.id, e.target.value)}
              style={{ padding: '2px 6px', fontSize: 12, borderRadius: 6, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid #2a5a48' }}
            >
              <option value="easy">Easy</option>
              <option value="normal">Normal</option>
              <option value="hard">Hard</option>
            </select>
            <button
              className="secondary"
              style={{ padding: '4px 8px', fontSize: 12 }}
              onClick={() => onRemoveCpu?.(player.id)}
            >
              Remove
            </button>
          </>
        )}
        {canEditName && (
          <button className="secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={onBeginEditName}>
            Rename
          </button>
        )}
      </div>
    </div>
  );
}

function RuleRow({ label, value, options, onChange, disabled }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' }}>
      <span style={{ fontSize: 14 }}>{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ padding: '4px 8px', borderRadius: 6, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid #2a5a48' }}
      >
        {options.map(([label, v]) => (
          <option key={label} value={v}>{label}</option>
        ))}
      </select>
    </div>
  );
}

function CopyInviteButton({ url }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('Copy this invite link:', url);
    }
  };
  return (
    <button className="secondary" onClick={onCopy} style={{ padding: '4px 10px', fontSize: 12 }}>
      {copied ? 'Copied!' : 'Copy invite'}
    </button>
  );
}

function StatusIndicator({ status }) {
  let color = 'var(--muted)';
  let text = 'idle';
  if (!status) { /* idle */ }
  else if (status.kind === 'open') { color = 'var(--accent-2)'; text = 'connected'; }
  else if (status.kind === 'connecting') { color = 'var(--gold)'; text = status.attempt > 1 ? `retrying host (${status.attempt})…` : 'connecting…'; }
  else if (status.kind === 'retrying') { color = 'var(--gold)'; text = 'waiting for host…'; }
  else if (status.kind === 'reconnecting') { color = 'var(--gold)'; text = 'reconnecting…'; }
  else if (status.kind === 'reclaiming') { color = 'var(--gold)'; text = `reclaiming room (${status.attempts}/${status.maxAttempts})…`; }
  else if (status.kind === 'disconnected') { color = 'var(--gold)'; text = 'reconnecting…'; }
  else if (status.kind === 'error') { color = '#ef4444'; text = 'error'; }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      {text}
    </span>
  );
}
