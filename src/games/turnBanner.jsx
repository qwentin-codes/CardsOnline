import { useEffect, useRef, useState, useMemo } from 'react';

// Curated hue palette shared across games. Shuffled per-seed so each
// match gets a fresh assignment of colors to player slots.
export const PLAYER_HUES = [20, 65, 110, 155, 200, 245, 290, 335];

// Mulberry32 PRNG → fast, deterministic Fisher-Yates shuffle. Same
// seed → same sequence on every client (so multiplayer agrees on
// color assignments).
export function seededShuffle(seed, arr) {
  let s = (seed | 0) || 1;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Hook: returns a `hueFor(playerId) → hue` function stable per state.
export function useHueFor(state) {
  const palette = useMemo(
    () => seededShuffle(state?.seed || 0, PLAYER_HUES),
    [state?.seed],
  );
  return (id) => {
    const idx = state?.playerOrder?.indexOf(id) ?? -1;
    if (idx < 0) return 153;
    return palette[idx % palette.length];
  };
}

// Hook that returns a key which increments whenever the turn changes.
// Pass `flightCount` if the calling game has in-flight card animations
// — the banner waits for them to land before firing so it doesn't
// step on an opponent's still-moving discard ghost.
//
// The fire is deferred by `settleMs` (default 120ms). This absorbs the
// transient render between a state update arriving and the action's
// useLayoutEffect populating the flights array — without the delay,
// useEffect can fire ONCE with flightCount=0 (because the flights
// state hasn't been updated yet in that render) before the next
// render commits with flights populated. The effect's cleanup
// correctly cancels the pending timer if flightCount goes back above
// zero, so the banner only fires after everything has actually
// settled at zero for the full settle window.
export function useTurnAnnounceKey(turn, flightCount = 0, settleMs = 120) {
  const [key, setKey] = useState(0);
  const lastTurnRef = useRef(null);
  const pendingRef = useRef(false);
  useEffect(() => {
    if (lastTurnRef.current !== turn) {
      lastTurnRef.current = turn;
      pendingRef.current = true;
    }
    if (pendingRef.current && flightCount === 0) {
      const t = setTimeout(() => {
        pendingRef.current = false;
        setKey((k) => k + 1);
      }, settleMs);
      return () => clearTimeout(t);
    }
  }, [turn, flightCount, settleMs]);
  return key;
}

// Drop-in banner element. Caller renders this inside the board with
// the current state + key + hue. Only renders when key > 0 so the
// element animates on mount each turn.
export function TurnBanner({ announceKey, hue, name, isMe, hidden }) {
  if (hidden || !announceKey) return null;
  return (
    <div
      key={announceKey}
      className="turn-announcement"
      style={{ '--player-hue': hue }}
    >
      {isMe ? 'Your' : `${name || 'Player'}'s`} turn
    </div>
  );
}
