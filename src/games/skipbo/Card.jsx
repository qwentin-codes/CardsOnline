import { SKIPBO } from './engine.js';

// Real Skip-Bo color groups: 1-4 purple, 5-8 green, 9-12 pink.
const COLOR_NAMES = ['purple', 'green', 'pink'];
export function cardColorClass(card) {
  if (card === SKIPBO || typeof card !== 'number') return '';
  return `num-${COLOR_NAMES[Math.floor((card - 1) / 4)]}`;
}

export function Card({ card, onClick, selected, faceDown, className = '', style }) {
  if (card === undefined || card === null) {
    return <EmptySlot onClick={onClick} className={className} style={style} />;
  }
  if (faceDown) {
    return <div className={`sb-card back ${className}`} onClick={onClick} style={style} />;
  }
  const isWild = card === SKIPBO;
  // Real Skip-Bo prints an underline beneath 6 so a rotated 6 can be
  // distinguished from a 9.
  const needsUnderline = card === 6;
  return (
    <div
      className={`sb-card ${isWild ? 'wild' : cardColorClass(card)} ${selected ? 'selected' : ''} ${needsUnderline ? 'underlined' : ''} ${className}`}
      onClick={onClick}
      style={style}
    >
      {isWild ? (
        <>
          <span className="wild-pennant wp-tr" />
          <span className="wild-pennant wp-bl" />
          <span className="sb-badge sb-tl">SB</span>
          <span className="wild-logo upper">SKIP-BO</span>
          <span className="wild-logo lower">SKIP-BO</span>
          <span className="sb-badge sb-br">SB</span>
        </>
      ) : (
        <>
          <span className="corner top-left">{card}</span>
          <span className="pennant pennant-tr" />
          <span className="center">{card}</span>
          <span className="pennant pennant-bl" />
          <span className="corner bottom-right">{card}</span>
        </>
      )}
    </div>
  );
}

// The deck pile — a stack of face-down cards with the classic red/blue
// SKIP-BO card back. Shows count and briefly lifts when a card is drawn.
export function Deck({ count, drawPulse }) {
  return (
    <div className="deck">
      <div className="deck-label">DECK</div>
      <div className={`deck-frame ${drawPulse ? 'pulse' : ''}`}>
        <div className="deck-shadow one" aria-hidden="true" />
        <div className="deck-shadow two" aria-hidden="true" />
        <div className="deck-shadow three" aria-hidden="true" />
        <div className="sb-card card-back">
          <span className="back-logo">
            <span>SKIP-</span>
            <span>BO</span>
          </span>
        </div>
      </div>
      <div className="deck-count">{count}</div>
    </div>
  );
}

export function EmptySlot({ onClick, label, className = '', style }) {
  return (
    <div className={`sb-card empty ${className}`} onClick={onClick} style={style}>
      {label && <span className="empty-label">{label}</span>}
    </div>
  );
}

// A player's stockpile: top card face-up, rendered on a 3D stack
// and with a count badge so it reads very differently from discards.
export function Stockpile({ topCard, count, selected, onClick, className = '', label = 'STOCK' }) {
  return (
    <div className={`stockpile ${className}`}>
      <div className="stockpile-label">{label}</div>
      <div className="stockpile-frame">
        <div className="stockpile-stack" aria-hidden="true" />
        <div className="stockpile-stack two" aria-hidden="true" />
        {topCard !== undefined ? (
          <Card card={topCard} selected={selected} onClick={onClick} className="stockpile-top" />
        ) : (
          <EmptySlot label="empty" onClick={onClick} className="stockpile-top" />
        )}
      </div>
      <div className="stockpile-count">{count}</div>
    </div>
  );
}

// Cascading vertical stack of discard cards. Shows last visibleMax cards
// offset downward so you can read the whole column at a glance.
export function DiscardPile({
  cards,
  selected,
  selectable,
  targetable,
  onTopClick,
  label,
  visibleMax = 8,
  compact = false,
  expanded = false,
}) {
  const shown = cards.slice(-visibleMax);
  const hidden = cards.length - shown.length;
  const collapsedOffset = compact ? 3 : 5;
  const expandedOffset = compact ? 14 : 22;
  const offset = expanded ? expandedOffset : collapsedOffset;
  const cardH = 90;
  const totalH = cardH + Math.max(0, shown.length - 1) * offset + (hidden > 0 ? 6 : 0);

  return (
    <div className={`discard-pile ${targetable ? 'targetable' : ''} ${selectable ? 'selectable' : ''}`}>
      {label && <div className="discard-label">{label}</div>}
      <div
        className="discard-stack"
        style={{ height: totalH }}
        onClick={onTopClick}
      >
        {cards.length === 0 ? (
          <EmptySlot label={targetable ? 'Drop' : ''} />
        ) : (
          <>
            {hidden > 0 && (
              <div className="hidden-stack" title={`${hidden} more below`} />
            )}
            {shown.map((c, i) => {
              const isTop = i === shown.length - 1;
              const top = (hidden > 0 ? 6 : 0) + i * offset;
              // Key the top card by pile length so a new card remounts
              // and plays the fly-in animation.
              const cardKey = isTop ? `top-${cards.length}` : `c-${i}`;
              return (
                <Card
                  key={cardKey}
                  card={c}
                  selected={selected && isTop}
                  className={`cascade ${isTop && targetable ? 'target' : ''} ${isTop ? 'fly-in' : ''}`}
                  style={{ top, zIndex: i + 1 }}
                />
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
