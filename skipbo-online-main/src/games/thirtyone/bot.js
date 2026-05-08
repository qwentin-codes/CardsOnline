// Thirty-One CPU bot. Three difficulty tiers:
//   easy   — never knocks, half-random draws, sometimes suboptimal discard.
//   normal — knocks at ≥22, takes discard only if it improves ≥2, always
//            picks the best discard.
//   hard   — knocks at ≥24 (22 when 2 active players remain), takes discard
//            on any improvement, picks the best discard, slightly more
//            aggressive blitz-awareness.
//
// Plan shape matches the other games: returns an array of actions to
// apply in sequence for this CPU's turn. A typical turn is one draw +
// one discard (2 actions), or a single knock. Empty array means
// "nothing to do right now" (off-turn or eliminated).

import { handScore } from './engine.js';

function scoreAfterDiscard(hand, discardIdx) {
  const next = hand.slice();
  next.splice(discardIdx, 1);
  return handScore(next);
}

// Returns { idx, score } for the best legal discard.
function bestDiscard(hand, forbiddenIdx = -1) {
  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < hand.length; i++) {
    if (i === forbiddenIdx) continue;
    const s = scoreAfterDiscard(hand, i);
    if (s > bestScore) { bestScore = s; bestIdx = i; }
  }
  return { idx: bestIdx, score: bestScore };
}

// Peek: if I took the discard top, what score could I reach after my
// best follow-up discard?
function discardPeekScore(hand, discardTop) {
  if (!discardTop) return -Infinity;
  const trial = hand.concat(discardTop);
  // Forbidden index = the just-added discard (last slot). Standard
  // rule: you can't take from discard and immediately re-discard it.
  return bestDiscard(trial, trial.length - 1).score;
}

function activeCount(state) {
  return state.playerOrder.filter((id) => !state.players[id].eliminated).length;
}

export function cpuPlan(state, cpuId, difficulty = 'normal') {
  if (state.winner) return [];
  // Round end: wait for a human to click "Next round". CPUs don't
  // auto-advance — otherwise the last turn in a CPU-ending round
  // would flash past the reveal overlay.
  if (state.phase === 'roundEnd') return [];

  const player = state.players[cpuId];
  if (!player || player.eliminated) return [];
  if (state.turn !== cpuId) return [];

  const hand = player.hand;
  const discardTop = state.discard[state.discard.length - 1] || null;

  if (state.phase === 'preDraw') {
    const currentScore = handScore(hand);
    const peekScore = discardPeekScore(hand, discardTop);

    // Knock threshold. Don't knock if someone already did (impossible —
    // the engine would have advanced past us — but defensive anyway).
    const canKnock = !state.knockBy;
    let knockThreshold;
    if (difficulty === 'easy') {
      knockThreshold = Infinity; // never knock
    } else if (difficulty === 'hard') {
      knockThreshold = activeCount(state) <= 2 ? 22 : 24;
    } else {
      knockThreshold = 22;
    }

    // Only knock if:
    // - we haven't already
    // - hand is strong enough
    // - taking the discard top wouldn't meaningfully improve us
    //   (if it would, just take the improvement and knock next turn)
    if (canKnock && currentScore >= knockThreshold && peekScore <= currentScore + 1) {
      return [{ type: 'knock' }];
    }

    // Draw decision. Minimum improvement threshold for taking discard.
    let minGain;
    if (difficulty === 'easy') minGain = 3;
    else if (difficulty === 'hard') minGain = 1;
    else minGain = 2;

    // If a knock is already on the table, this is our last turn —
    // grab anything that helps, even marginally (gain >= 1).
    if (state.knockBy) minGain = 1;

    let drawAction;
    if (peekScore >= currentScore + minGain) {
      drawAction = { type: 'drawDiscard' };
    } else if (difficulty === 'easy') {
      // Easy sometimes takes the discard for no good reason.
      drawAction = Math.random() < 0.35 ? { type: 'drawDiscard' } : { type: 'drawDeck' };
    } else {
      drawAction = { type: 'drawDeck' };
    }

    return [drawAction];
  }

  // postDraw: must discard.
  const forbidden = state.pickupSource === 'discard' ? state.pickupIndex : -1;
  const { idx } = bestDiscard(hand, forbidden);
  if (idx < 0) {
    // Safety net — should not happen with a 4-card hand and 1 forbidden
    // index, but pick any legal discard.
    for (let i = 0; i < hand.length; i++) {
      if (i !== forbidden) return [{ type: 'discard', cardIndex: i }];
    }
    return [];
  }

  // Easy sometimes makes a suboptimal discard (still legal).
  if (difficulty === 'easy' && Math.random() < 0.3) {
    const legal = [];
    for (let i = 0; i < hand.length; i++) if (i !== forbidden) legal.push(i);
    const pick = legal[Math.floor(Math.random() * legal.length)];
    return [{ type: 'discard', cardIndex: pick }];
  }

  return [{ type: 'discard', cardIndex: idx }];
}
