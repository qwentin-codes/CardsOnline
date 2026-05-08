// Skip-Bo bot with three difficulty bands:
//   easy   — plays stock-top when possible, otherwise picks a random
//            legal build play or discards a random card. Uses wilds
//            eagerly (beginner move).
//   normal — current greedy: stock > discard tops > hand, wild saved
//            unless "worth it." Current baseline.
//   hard   — normal, but much stricter about wilds (only plays them
//            when they directly clear stock or finish a build pile)
//            and prefers discards that leave stackable tops.

import { canPlayToBuild, applyAction, SKIPBO } from './engine.js';

function findPlayablePile(card, buildPiles) {
  for (let i = 0; i < buildPiles.length; i++) {
    if (canPlayToBuild(card, buildPiles[i])) return i;
  }
  return -1;
}

// Would playing `card` from `from` be useful (i.e. not a waste of a wild)?
// Wilds are only "useful" here if they (a) clear stock, or (b) extend a build
// pile that the next stock value can use, or (c) come from stock/discard
// themselves.
function wildIsWorthIt(state, cpuId, from, difficulty = 'normal') {
  if (from === 'stock' || from === 'discard') return true;
  const p = state.players[cpuId];
  const stockTop = p.stock[p.stock.length - 1];
  if (stockTop === undefined) return true;
  for (const bp of state.buildPiles) {
    const next = bp.length + 1;
    if (next > 12) continue;
    // Hard mode: only play wild if it directly unblocks the stock top
    // (next === stockTop - 1 so playing wild makes stock playable) or
    // finishes a build pile for a redraw. No speculative chains.
    if (difficulty === 'hard') {
      if (stockTop === SKIPBO && next === 12) return true;
      if (typeof stockTop === 'number' && next === stockTop - 1) return true;
      if (next === 12) return true; // completes a pile → redraw
      continue;
    }
    if (stockTop === SKIPBO || stockTop === next + 1) return true;
    if (p.hand.includes(next + 1)) return true;
  }
  return false;
}

function chooseDiscard(state, cpuId) {
  const p = state.players[cpuId];
  if (p.hand.length === 0) return null;
  // Pick hand card: prefer highest non-wild, keep wilds.
  const sorted = p.hand.map((c, i) => ({ c, i })).sort((a, b) => {
    const av = a.c === SKIPBO ? -1 : a.c;
    const bv = b.c === SKIPBO ? -1 : b.c;
    return bv - av;
  });
  const pick = sorted[0];
  const piles = p.discards;
  for (let di = 0; di < piles.length; di++) {
    if (piles[di].length > 0 && piles[di][piles[di].length - 1] === pick.c) {
      return { handIndex: pick.i, discardPile: di };
    }
  }
  for (let di = 0; di < piles.length; di++) {
    if (piles[di].length === 0) return { handIndex: pick.i, discardPile: di };
  }
  let shortest = 0;
  for (let di = 1; di < piles.length; di++) {
    if (piles[di].length < piles[shortest].length) shortest = di;
  }
  return { handIndex: pick.i, discardPile: shortest };
}

// Easy plan: a beginner-level opponent. Always plays stock-top when a
// legal spot exists (otherwise the game would drag), but otherwise
// makes random legal moves and a random discard.
function easyPlan(state, cpuId) {
  const actions = [];
  let s = state;
  let safety = 50;
  while (safety-- > 0 && s.turn === cpuId && !s.winner) {
    const p = s.players[cpuId];
    let played = false;

    // Always play stock when possible.
    if (p.stock.length > 0) {
      const top = p.stock[p.stock.length - 1];
      const bp = findPlayablePile(top, s.buildPiles);
      if (bp >= 0) {
        const act = { type: 'play', from: 'stock', buildPile: bp };
        const res = applyAction(s, cpuId, act);
        if (res.ok) { actions.push(act); s = res.state; played = true; continue; }
      }
    }

    // Collect any legal non-stock play and pick one at random.
    const legal = [];
    for (let di = 0; di < p.discards.length; di++) {
      const pile = p.discards[di];
      const top = pile[pile.length - 1];
      if (top === undefined) continue;
      const bp = findPlayablePile(top, s.buildPiles);
      if (bp >= 0) legal.push({ type: 'play', from: 'discard', index: di, buildPile: bp });
    }
    for (let i = 0; i < p.hand.length; i++) {
      const c = p.hand[i];
      const bp = findPlayablePile(c, s.buildPiles);
      if (bp >= 0) legal.push({ type: 'play', from: 'hand', index: i, buildPile: bp });
    }
    // Easy player makes plays with 70% probability per step — occasionally
    // just stops short and discards. Keeps matches winnable.
    if (legal.length > 0 && Math.random() < 0.7) {
      const act = legal[Math.floor(Math.random() * legal.length)];
      const res = applyAction(s, cpuId, act);
      if (res.ok) { actions.push(act); s = res.state; played = true; continue; }
    }
    break;
  }

  if (!s.winner && s.turn === cpuId) {
    const p = s.players[cpuId];
    if (p.hand.length > 0) {
      const handIndex = Math.floor(Math.random() * p.hand.length);
      const discardPile = Math.floor(Math.random() * p.discards.length);
      actions.push({ type: 'discard', handIndex, discardPile });
    }
  }
  return actions;
}

// Returns an array of actions the bot wants to perform (for animation).
export function cpuPlan(state, cpuId, difficulty = 'normal') {
  if (difficulty === 'easy') return easyPlan(state, cpuId);

  const actions = [];
  let s = state;
  let safety = 200;
  while (safety-- > 0 && s.turn === cpuId && !s.winner) {
    const p = s.players[cpuId];
    let played = false;

    // 1. Stock
    if (p.stock.length > 0) {
      const top = p.stock[p.stock.length - 1];
      const bp = findPlayablePile(top, s.buildPiles);
      if (bp >= 0) {
        const act = { type: 'play', from: 'stock', buildPile: bp };
        const res = applyAction(s, cpuId, act);
        if (res.ok) { actions.push(act); s = res.state; played = true; continue; }
      }
    }

    // 2. Discard tops
    for (let di = 0; di < p.discards.length; di++) {
      const pile = p.discards[di];
      const top = pile[pile.length - 1];
      if (top === undefined) continue;
      const bp = findPlayablePile(top, s.buildPiles);
      if (bp >= 0) {
        const act = { type: 'play', from: 'discard', index: di, buildPile: bp };
        const res = applyAction(s, cpuId, act);
        if (res.ok) { actions.push(act); s = res.state; played = true; break; }
      }
    }
    if (played) continue;

    // 3. Hand — non-wild first
    const order = p.hand
      .map((c, i) => ({ c, i }))
      .sort((a, b) => {
        if (a.c === SKIPBO && b.c !== SKIPBO) return 1;
        if (b.c === SKIPBO && a.c !== SKIPBO) return -1;
        return a.c - b.c;
      });
    for (const { c, i } of order) {
      const bp = findPlayablePile(c, s.buildPiles);
      if (bp < 0) continue;
      if (c === SKIPBO && !wildIsWorthIt(s, cpuId, 'hand', difficulty)) continue;
      const act = { type: 'play', from: 'hand', index: i, buildPile: bp };
      const res = applyAction(s, cpuId, act);
      if (res.ok) { actions.push(act); s = res.state; played = true; break; }
    }
    if (played) continue;

    break;
  }

  if (!s.winner && s.turn === cpuId) {
    const pick = chooseDiscard(s, cpuId);
    if (pick) actions.push({ type: 'discard', handIndex: pick.handIndex, discardPile: pick.discardPile });
  }
  return actions;
}
