import { useEffect, useRef, useState } from 'react';

export function Chat({ messages, onSend, compact }) {
  const [text, setText] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const submit = (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--panel)',
      borderRadius: 10,
      padding: 8,
      gap: 6,
      minHeight: compact ? 120 : 200,
      maxHeight: compact ? 160 : 300,
    }}>
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          fontSize: 13,
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          padding: '2px 4px',
        }}
      >
        {messages.length === 0 && (
          <div style={{ color: 'var(--muted)', fontStyle: 'italic' }}>No messages yet.</div>
        )}
        {messages.map((m, i) => (
          <div key={i}>
            {m.from === 'system' ? (
              <em style={{ color: 'var(--muted)' }}>{m.text}</em>
            ) : (
              <>
                <strong style={{ color: 'var(--accent)' }}>{m.name}:</strong>{' '}
                <span>{m.text}</span>
              </>
            )}
          </div>
        ))}
      </div>
      <form onSubmit={submit} style={{ display: 'flex', gap: 4 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a message…"
          maxLength={500}
          style={{ flex: 1, maxWidth: 'none' }}
        />
        <button type="submit" disabled={!text.trim()}>Send</button>
      </form>
    </div>
  );
}
