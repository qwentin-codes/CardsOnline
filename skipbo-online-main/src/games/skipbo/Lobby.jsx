import { useState } from 'react';
import { Chat } from '../../Chat.jsx';
import { MAX_PLAYERS, MIN_PLAYERS, requiredDecks } from './engine.js';

export function Lobby({ lobby, isHost, myId, onStart, onUpdateRules, onRename, onAddCpu, onRemoveCpu, onSetCpuDifficulty, chatMessages, onSendChat, onLeave, error, peerStatus, inviteUrl }) {
  const [editingName, setEditingName] = useState(false);
  const me = lobby.players.find((p) => p.id === myId);
  const [nameDraft, setNameDraft] = useState(me?.name || '');

  const rules = lobby.rules || {};
  const effectiveStock = rules.stockSize ?? 30;
  const effectiveHand = rules.handSize ?? 5;
  const decks = requiredDecks(lobby.players.length, effectiveStock, effectiveHand);

  const humanCount = lobby.players.filter((p) => !p.isCpu).length;
  const needsMorePlayers = lobby.players.length < MIN_PLAYERS;
  const needsAnotherHuman = humanCount < 2;
  const startDisabled = needsMorePlayers || needsAnotherHuman;
  const startLabel = needsMorePlayers
    ? `Need ≥${MIN_PLAYERS} players`
    : needsAnotherHuman
      ? 'Waiting for another human player to join'
      : 'Start game';

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
          label="Stockpile size"
          value={rules.stockSize ?? 30}
          isHost={isHost}
          options={[[5, 5], [10, 10], [15, 15], [20, 20], [25, 25], [30, 30], [35, 35], [40, 40], [45, 45], [50, 50]]}
          onChange={(v) => onUpdateRules({ stockSize: v })}
        />
        <RuleRow
          label="Hand size"
          value={rules.handSize ?? 5}
          isHost={isHost}
          options={[[5, 5], [10, 10]]}
          onChange={(v) => onUpdateRules({ handSize: v })}
        />
        <RuleRow
          label="Max discard depth"
          value={rules.maxDiscardDepth ?? 'unlimited'}
          isHost={isHost}
          options={[[4, 4], [6, 6], [8, 8], ['unlimited', null]]}
          onChange={(v) => onUpdateRules({ maxDiscardDepth: v })}
        />
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
          {decks === 1 ? '1 deck' : `${decks} decks`}
        </div>
      </div>

      {isHost && (
        <button onClick={onStart} disabled={startDisabled}>{startLabel}</button>
      )}
      {!isHost && <div style={{ textAlign: 'center', color: 'var(--muted)' }}>Waiting for host to start…</div>}
      {error && <div className="error">{error}</div>}

      <div>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Chat</div>
        <Chat messages={chatMessages} onSend={onSendChat} compact />
      </div>
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
              style={{ padding: '2px 6px', fontSize: 12, borderRadius: 6, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid #334155' }}
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

function CopyInviteButton({ url }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Older browsers / insecure contexts: fall back to a prompt.
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
  let text = '';
  if (status.kind === 'connecting') { color = 'var(--gold)'; text = status.attempt > 1 ? `retrying host (${status.attempt})…` : 'connecting…'; }
  else if (status.kind === 'retrying') { color = 'var(--gold)'; text = 'waiting for host…'; }
  else if (status.kind === 'reconnecting') { color = 'var(--gold)'; text = 'reconnecting…'; }
  else if (status.kind === 'reclaiming') { color = 'var(--gold)'; text = `reclaiming room (${status.attempts}/${status.maxAttempts})…`; }
  else if (status.kind === 'open') { color = 'var(--accent-2)'; text = 'connected'; }
  else if (status.kind === 'disconnected') { color = 'var(--gold)'; text = 'reconnecting…'; }
  else if (status.kind === 'error') { color = 'var(--danger)'; text = status.message || status.type; }
  return (
    <div style={{ fontSize: 10, color, display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
      <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: color, boxShadow: `0 0 4px ${color}` }} />
      <span>{text}</span>
    </div>
  );
}

function RuleRow({ label, value, detail, isHost, options, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #334155' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14 }}>{label}</div>
        {detail && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{detail}</div>}
      </div>
      {isHost ? (
        <select
          value={String(value)}
          onChange={(e) => {
            const opt = options.find(([label]) => String(label) === e.target.value);
            if (opt) onChange(opt[1]);
          }}
          style={{
            background: 'var(--panel-2)',
            color: 'var(--text)',
            border: '1px solid #334155',
            borderRadius: 6,
            padding: '6px 8px',
            font: 'inherit',
          }}
        >
          {options.map(([label, val]) => (
            <option key={String(label)} value={String(label)}>{label}</option>
          ))}
        </select>
      ) : (
        <div style={{ color: 'var(--muted)' }}>{String(value)}</div>
      )}
    </div>
  );
}
