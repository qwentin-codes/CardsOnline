import { useEffect, useRef } from 'react';
import { cardLabel } from './engine.js';

// Playing card wrapper for Thirty-One. Same approach as the shared
// cardmeister custom element renders the SVG, but React's reconciliation
// can leave stale inner SVGs on the wrapper so we replace the child
// element imperatively every render.

const SUIT_NAME = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
// cardmeister is picky about rank names: 2-9 use digits, 10 must be
// "Ten" (the string "10" silently renders as Ace), faces use their word.
const RANK_NAME = {
  1: 'Ace', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7',
  8: '8', 9: '9', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King',
};

function cidFor(card) {
  const rank = RANK_NAME[card.rank];
  const suit = SUIT_NAME[card.suit];
  if (!rank || !suit) return '';
  return `${rank}-of-${suit}`;
}

export function PlayingCard({ card, faceDown, onClick, className = '', selected, highlight, dim, style }) {
  const hostRef = useRef(null);
  const cid = !faceDown && card ? cidFor(card) : null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!cid) { host.replaceChildren(); return; }
    const pc = document.createElement('playing-card');
    pc.setAttribute('cid', cid);
    host.replaceChildren(pc);
  });

  const classes = ['pc'];
  if (selected) classes.push('selected');
  if (highlight) classes.push('t31-highlight');
  if (dim) classes.push('t31-dim');
  if (onClick) classes.push('clickable');
  if (className) classes.push(className);

  if (faceDown) {
    return <div className={`${classes.join(' ')} face-down`} onClick={onClick} style={style} />;
  }
  if (!card) {
    return <div className={`${classes.join(' ')} empty`} onClick={onClick} style={style} />;
  }
  classes.push('pc-svg');
  return (
    <div
      ref={hostRef}
      className={classes.join(' ')}
      onClick={onClick}
      style={style}
      aria-label={cardLabel(card)}
      data-cid={cid}
    />
  );
}
