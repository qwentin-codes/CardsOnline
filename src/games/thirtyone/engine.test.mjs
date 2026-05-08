// Thirty-One engine tests. Run via:
//   node src/games/thirtyone/engine.test.mjs
//
// Covers deck composition, scoring edge cases (same-suit sum vs. 3-of-
// a-kind, high/low ace rules — there are none — empty/partial hands),
// and action/turn flow (knock mechanics, blitz, discard pickup rule,
// life loss + elimination). Thirty-One's engine is deliberately small,
// but every rule is easy to get subtly wrong so guard them with tests.

import {
  buildDeck, shuffle, handScore, bestSuit, cardValue,
  createGame, applyAction, DEFAULT_RULES,
} from './engine.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log('  ok -', msg); }
  else { failed += 1; console.log('  FAIL:', msg); }
}
function section(name) { console.log('\n' + name); }

// ─────────────────────────── Deck ───────────────────────────
section('Deck composition');
{
  const d = buildDeck();
  assert(d.length === 52, '52 cards total');
  const bySuit = { S: 0, H: 0, D: 0, C: 0 };
  for (const c of d) bySuit[c.suit] += 1;
  assert(bySuit.S === 13 && bySuit.H === 13 && bySuit.D === 13 && bySuit.C === 13,
    '13 per suit');
  const ranks = d.filter((c) => c.suit === 'S').map((c) => c.rank).sort((a, b) => a - b);
  assert(ranks.join(',') === '1,2,3,4,5,6,7,8,9,10,11,12,13', 'ranks 1..13 per suit');
}

section('Shuffle');
{
  const orig = buildDeck();
  const shuf = shuffle(orig);
  assert(shuf.length === orig.length, 'same size after shuffle');
  const key = (c) => `${c.rank}${c.suit}`;
  const a = [...orig].map(key).sort().join(',');
  const b = [...shuf].map(key).sort().join(',');
  assert(a === b, 'same multiset');
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(shuffle(buildDeck()).map(key).join(','));
  assert(seen.size === 500, '500/500 shuffles distinct');
}

// ─────────────────────────── Scoring ───────────────────────────
section('cardValue');
{
  assert(cardValue(1) === 11, 'Ace = 11');
  assert(cardValue(2) === 2, '2 = 2');
  assert(cardValue(10) === 10, '10 = 10');
  assert(cardValue(11) === 10, 'Jack = 10');
  assert(cardValue(12) === 10, 'Queen = 10');
  assert(cardValue(13) === 10, 'King = 10');
}

section('handScore: single-suit');
{
  // A♥ K♥ Q♥ = 11 + 10 + 10 = 31
  const s = handScore([{ rank: 1, suit: 'H' }, { rank: 13, suit: 'H' }, { rank: 12, suit: 'H' }]);
  assert(s === 31, 'A+K+Q hearts = 31');
}

section('handScore: mixed, best suit wins');
{
  // A♥ K♥ 5♠ = hearts 21, spades 5 → 21
  const s = handScore([{ rank: 1, suit: 'H' }, { rank: 13, suit: 'H' }, { rank: 5, suit: 'S' }]);
  assert(s === 21, 'A+K hearts + 5 spades = 21 (hearts wins)');
}

section('handScore: spread across suits');
{
  // 5♠ 5♥ 5♦ = 3-of-a-kind? No, same rank — YES this IS 3-of-a-kind.
  // User's variant: 3-of-a-kind = 30.
  const s = handScore([{ rank: 5, suit: 'S' }, { rank: 5, suit: 'H' }, { rank: 5, suit: 'D' }]);
  assert(s === 30, '5♠5♥5♦ = 30 (three of a kind)');
}

section('handScore: three of a kind (aces)');
{
  const s = handScore([{ rank: 1, suit: 'S' }, { rank: 1, suit: 'H' }, { rank: 1, suit: 'D' }]);
  // User's variant: 30, NOT 33 (three aces = 11*3 would be tempting but
  // scat doesn't sum same-rank different-suit — they must share a suit
  // to stack, and the 3-of-a-kind special case clamps to 30).
  assert(s === 30, 'three aces = 30 (not 33)');
}

section('handScore: three kings (face-card 3-of-a-kind)');
{
  const s = handScore([{ rank: 13, suit: 'S' }, { rank: 13, suit: 'H' }, { rank: 13, suit: 'D' }]);
  assert(s === 30, 'three kings = 30');
}

section('handScore: 4 cards (postDraw peek)');
{
  // A♥ K♥ Q♥ + random 2♠. Hearts = 31, spades = 2 → 31.
  const s = handScore([
    { rank: 1, suit: 'H' }, { rank: 13, suit: 'H' }, { rank: 12, suit: 'H' },
    { rank: 2, suit: 'S' },
  ]);
  assert(s === 31, '4-card peek: hearts 31 wins over spades 2');
}

section('handScore: empty / bad input');
{
  assert(handScore([]) === 0, 'empty hand = 0');
  assert(handScore(null) === 0, 'null = 0');
}

section('bestSuit: 3-of-a-kind flag');
{
  const b = bestSuit([{ rank: 7, suit: 'S' }, { rank: 7, suit: 'H' }, { rank: 7, suit: 'D' }]);
  assert(b.threeOfKind === true, 'flagged as 3-of-a-kind');
}

// ─────────────────────────── Game lifecycle ───────────────────────────
section('createGame: basic setup');
{
  const s = createGame(['a', 'b', 'c'], { a: 'A', b: 'B', c: 'C' });
  assert(s.playerOrder.length === 3, '3 players');
  assert(s.players.a.hand.length === 3, 'A has 3 cards');
  assert(s.players.b.hand.length === 3, 'B has 3 cards');
  assert(s.discard.length === 1, 'discard pile has 1 card');
  assert(s.deck.length === 52 - 3 * 3 - 1, 'deck has remainder');
  assert(s.players.a.lives === 3, 'A has 3 lives');
  assert(s.phase === 'preDraw' || s.phase === 'roundEnd', 'phase is preDraw (or roundEnd if dealt-31)');
}

section('createGame: rejects bad player counts');
{
  let threw = false;
  try { createGame(['a']); } catch { threw = true; }
  assert(threw, '1 player throws');
  threw = false;
  try { createGame(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']); } catch { threw = true; }
  assert(threw, '9 players throws');
}

// Deterministically-constructed hands for turn-flow tests. Defaults
// put 'a' as first to act (dealer is the LAST seat so next-after-dealer
// wraps back to seat 0).
function riggedGame(hands, { turnSeat = 0, extraDeck = [], discardTop = { rank: 4, suit: 'C' } } = {}) {
  const ids = Object.keys(hands);
  const state = createGame(ids, Object.fromEntries(ids.map((id) => [id, id.toUpperCase()])));
  for (const id of ids) state.players[id].hand = hands[id].map((c) => ({ ...c }));
  state.deck = extraDeck.map((c) => ({ ...c }));
  state.discard = [discardTop];
  state.phase = 'preDraw';
  state.pickupSource = null;
  state.pickupIndex = null;
  state.knockBy = null;
  state.turnsRemainingAfterKnock = null;
  state.roundEnd = null;
  state.winner = null;
  // Place dealer so that next-active = ids[turnSeat].
  const dealerIdx = (turnSeat - 1 + ids.length) % ids.length;
  state.dealer = ids[dealerIdx];
  state.turn = ids[turnSeat];
  return state;
}

section('draw+discard: basic turn');
{
  const s = riggedGame({
    a: [{ rank: 1, suit: 'H' }, { rank: 13, suit: 'H' }, { rank: 2, suit: 'S' }],
    b: [{ rank: 5, suit: 'S' }, { rank: 6, suit: 'S' }, { rank: 7, suit: 'S' }],
  }, { extraDeck: [{ rank: 5, suit: 'C' }] });
  // A draws top of deck (5♣) → A has 4 cards. Then A discards the 2♠.
  let r = applyAction(s, 'a', { type: 'drawDeck' });
  assert(r.ok, 'A drawDeck ok');
  assert(r.state.phase === 'postDraw', 'phase postDraw');
  assert(r.state.players.a.hand.length === 4, 'A holds 4 cards');
  r = applyAction(r.state, 'a', { type: 'discard', cardIndex: 2 });
  assert(r.ok, 'A discard ok');
  assert(r.state.phase === 'preDraw', 'back to preDraw');
  assert(r.state.players.a.hand.length === 3, 'A holds 3 cards');
  assert(r.state.turn === 'b', 'turn advanced to B');
  assert(r.state.discard[r.state.discard.length - 1].rank === 2, 'discard top is the 2♠');
}

section('discard pickup: cannot re-discard same card');
{
  const s = riggedGame({
    a: [{ rank: 3, suit: 'H' }, { rank: 5, suit: 'H' }, { rank: 2, suit: 'S' }],
    b: [{ rank: 5, suit: 'S' }, { rank: 6, suit: 'S' }, { rank: 7, suit: 'S' }],
  }, { discardTop: { rank: 13, suit: 'H' } });
  let r = applyAction(s, 'a', { type: 'drawDiscard' });
  assert(r.ok, 'A drawDiscard ok');
  assert(r.state.pickupSource === 'discard', 'pickupSource discard');
  const pickupIdx = r.state.pickupIndex;
  const bad = applyAction(r.state, 'a', { type: 'discard', cardIndex: pickupIdx });
  assert(!bad.ok, 'cannot re-discard the pickup');
  // Discarding any other index is fine.
  const otherIdx = pickupIdx === 0 ? 1 : 0;
  const good = applyAction(r.state, 'a', { type: 'discard', cardIndex: otherIdx });
  assert(good.ok, 'discarding a different card ok');
}

section('blitz after discard');
{
  // A holds A♥, K♥, Q♥ already (= 31). Trick: the engine scores AFTER
  // discard, so we give A a 4th card + make them discard it to trigger
  // the check. Give A a junk card, K♥, Q♥, A♥ and have them discard
  // the junk card. Post-discard they'll have A♥K♥Q♥ = 31.
  const s = riggedGame({
    a: [{ rank: 1, suit: 'H' }, { rank: 13, suit: 'H' }, { rank: 12, suit: 'H' }],
    b: [{ rank: 5, suit: 'S' }, { rank: 6, suit: 'S' }, { rank: 7, suit: 'S' }],
  }, { extraDeck: [{ rank: 2, suit: 'C' }] });
  let r = applyAction(s, 'a', { type: 'drawDeck' });
  assert(r.ok && r.state.players.a.hand.length === 4, 'A holds 4');
  // Discard the 2♣ (the 4th card, at index 3).
  r = applyAction(r.state, 'a', { type: 'discard', cardIndex: 3 });
  assert(r.ok, 'discard ok');
  assert(r.state.phase === 'roundEnd', 'round ended');
  assert(r.state.roundEnd.reason === 'blitz', 'reason blitz');
  assert(r.state.roundEnd.blitzWinner === 'a', 'A wins blitz');
  assert(r.state.roundEnd.losses.b === 1, 'B loses 1 life');
  assert(r.state.roundEnd.losses.a === 0, 'A loses 0 lives');
}

section('knock: non-knocker lowest loses 1');
{
  const s = riggedGame({
    a: [{ rank: 1, suit: 'H' }, { rank: 13, suit: 'H' }, { rank: 5, suit: 'H' }],   // 26
    b: [{ rank: 2, suit: 'S' }, { rank: 3, suit: 'C' }, { rank: 4, suit: 'D' }],    // 4
    c: [{ rank: 10, suit: 'C' }, { rank: 6, suit: 'C' }, { rank: 2, suit: 'H' }],   // 16
  });
  // A knocks. B, C get one turn each. We'll have B and C draw-deck + discard
  // their pickup's pair to keep hands roughly the same, then showdown.
  let r = applyAction(s, 'a', { type: 'knock' });
  assert(r.ok, 'A knocks');
  assert(r.state.knockBy === 'a', 'knockBy set');
  assert(r.state.turn === 'b', 'turn advanced to B');
  assert(r.state.turnsRemainingAfterKnock === 2, '2 turns remaining');
  // Seed the deck so draws are deterministic.
  r.state.deck = [{ rank: 2, suit: 'C' }, { rank: 3, suit: 'S' }];
  r = applyAction(r.state, 'b', { type: 'drawDeck' });
  r = applyAction(r.state, 'b', { type: 'discard', cardIndex: 3 }); // discard the drawn card
  assert(r.ok && r.state.turn === 'c', 'B done');
  r = applyAction(r.state, 'c', { type: 'drawDeck' });
  r = applyAction(r.state, 'c', { type: 'discard', cardIndex: 3 });
  assert(r.ok, 'C done');
  assert(r.state.phase === 'roundEnd', 'showdown');
  assert(r.state.roundEnd.losses.b === 1, 'B (lowest) loses 1');
  assert(r.state.roundEnd.losses.a === 0, 'A (knocker) safe');
  assert(r.state.roundEnd.losses.c === 0, 'C safe');
}

section('knock: knocker-lowest loses 2');
{
  const s = riggedGame({
    a: [{ rank: 2, suit: 'S' }, { rank: 3, suit: 'C' }, { rank: 4, suit: 'D' }],    // 4  ← lowest, knocker
    b: [{ rank: 1, suit: 'H' }, { rank: 13, suit: 'H' }, { rank: 2, suit: 'H' }],   // 23
    c: [{ rank: 10, suit: 'C' }, { rank: 6, suit: 'C' }, { rank: 2, suit: 'H' }],   // 16
  });
  let r = applyAction(s, 'a', { type: 'knock' });
  assert(r.ok, 'A (bad) knocks');
  r.state.deck = [{ rank: 2, suit: 'C' }, { rank: 3, suit: 'S' }];
  r = applyAction(r.state, 'b', { type: 'drawDeck' });
  r = applyAction(r.state, 'b', { type: 'discard', cardIndex: 3 });
  r = applyAction(r.state, 'c', { type: 'drawDeck' });
  r = applyAction(r.state, 'c', { type: 'discard', cardIndex: 3 });
  assert(r.state.phase === 'roundEnd', 'showdown');
  assert(r.state.roundEnd.losses.a === 2, 'A knocker-lowest loses 2');
  assert(r.state.roundEnd.losses.b === 0, 'B safe');
  assert(r.state.roundEnd.losses.c === 0, 'C safe');
}

section('knock: soft rule (knockerPenalty=1) — knocker & tied-lows all lose 1');
{
  const s = riggedGame({
    a: [{ rank: 2, suit: 'S' }, { rank: 3, suit: 'C' }, { rank: 4, suit: 'D' }],    // 4  ← knocker
    b: [{ rank: 1, suit: 'H' }, { rank: 13, suit: 'H' }, { rank: 2, suit: 'H' }],   // 23
    c: [{ rank: 4, suit: 'S' }, { rank: 3, suit: 'H' }, { rank: 2, suit: 'C' }],    // 4  ← tied lowest
  });
  s.rules.knockerPenalty = 1;
  let r = applyAction(s, 'a', { type: 'knock' });
  r.state.deck = [{ rank: 2, suit: 'C' }, { rank: 3, suit: 'S' }];
  r = applyAction(r.state, 'b', { type: 'drawDeck' });
  r = applyAction(r.state, 'b', { type: 'discard', cardIndex: 3 });
  r = applyAction(r.state, 'c', { type: 'drawDeck' });
  r = applyAction(r.state, 'c', { type: 'discard', cardIndex: 3 });
  assert(r.state.phase === 'roundEnd', 'showdown');
  assert(r.state.roundEnd.losses.a === 1, 'soft: A (knocker, lowest) loses 1');
  assert(r.state.roundEnd.losses.c === 1, 'soft: C (tied-lowest) also loses 1');
  assert(r.state.roundEnd.losses.b === 0, 'soft: B safe');
}

section('knock: ties at lowest (non-knocker) both lose');
{
  const s = riggedGame({
    a: [{ rank: 1, suit: 'H' }, { rank: 13, suit: 'H' }, { rank: 5, suit: 'H' }],   // 26  ← knocker
    b: [{ rank: 2, suit: 'S' }, { rank: 3, suit: 'C' }, { rank: 4, suit: 'D' }],    // 4
    c: [{ rank: 4, suit: 'S' }, { rank: 3, suit: 'H' }, { rank: 2, suit: 'C' }],    // 4
  });
  let r = applyAction(s, 'a', { type: 'knock' });
  r.state.deck = [{ rank: 2, suit: 'C' }, { rank: 3, suit: 'S' }];
  r = applyAction(r.state, 'b', { type: 'drawDeck' });
  r = applyAction(r.state, 'b', { type: 'discard', cardIndex: 3 });
  r = applyAction(r.state, 'c', { type: 'drawDeck' });
  r = applyAction(r.state, 'c', { type: 'discard', cardIndex: 3 });
  assert(r.state.phase === 'roundEnd', 'showdown');
  assert(r.state.roundEnd.losses.a === 0, 'A safe');
  assert(r.state.roundEnd.losses.b === 1, 'B loses 1');
  assert(r.state.roundEnd.losses.c === 1, 'C loses 1');
}

section('elimination + next round');
{
  const s = createGame(['a', 'b'], { a: 'A', b: 'B' }, { startingLives: 1 });
  // Force a rigged last-life blitz: A blitzes, B loses last life, match ends.
  s.players.a.hand = [{ rank: 1, suit: 'H' }, { rank: 13, suit: 'H' }, { rank: 12, suit: 'H' }];
  s.players.b.hand = [{ rank: 2, suit: 'S' }, { rank: 3, suit: 'S' }, { rank: 4, suit: 'S' }];
  s.deck = [{ rank: 2, suit: 'C' }];
  s.discard = [{ rank: 5, suit: 'C' }];
  s.phase = 'preDraw';
  s.turn = 'a';
  let r = applyAction(s, 'a', { type: 'drawDeck' });
  r = applyAction(r.state, 'a', { type: 'discard', cardIndex: 3 });
  assert(r.state.phase === 'roundEnd', 'round ended (blitz)');
  assert(r.state.players.b.lives === 0, 'B eliminated');
  assert(r.state.players.b.eliminated === true, 'B flagged eliminated');
  assert(r.state.winner === 'a', 'A wins match');
}

section('undo: reverts own action only');
{
  const s = riggedGame({
    a: [{ rank: 1, suit: 'H' }, { rank: 13, suit: 'H' }, { rank: 2, suit: 'S' }],
    b: [{ rank: 5, suit: 'S' }, { rank: 6, suit: 'S' }, { rank: 7, suit: 'S' }],
  }, { extraDeck: [{ rank: 12, suit: 'H' }] });
  let r = applyAction(s, 'a', { type: 'drawDeck' });
  assert(r.ok && r.state.phase === 'postDraw', 'drew');
  const u = applyAction(r.state, 'a', { type: 'undo' });
  assert(u.ok, 'A can undo own draw');
  assert(u.state.phase === 'preDraw', 'back to preDraw');
  assert(u.state.players.a.hand.length === 3, 'hand back to 3');
  // B cannot undo A's action.
  const bad = applyAction(r.state, 'b', { type: 'undo' });
  assert(!bad.ok, 'B cannot undo A action');
}

section('not-your-turn');
{
  const s = riggedGame({
    a: [{ rank: 1, suit: 'H' }, { rank: 13, suit: 'H' }, { rank: 2, suit: 'S' }],
    b: [{ rank: 5, suit: 'S' }, { rank: 6, suit: 'S' }, { rank: 7, suit: 'S' }],
  });
  const r = applyAction(s, 'b', { type: 'drawDeck' });
  assert(!r.ok, "B can't act on A's turn");
}

section('knock requires preDraw');
{
  const s = riggedGame({
    a: [{ rank: 1, suit: 'H' }, { rank: 13, suit: 'H' }, { rank: 2, suit: 'S' }],
    b: [{ rank: 5, suit: 'S' }, { rank: 6, suit: 'S' }, { rank: 7, suit: 'S' }],
  }, { extraDeck: [{ rank: 8, suit: 'D' }] });
  let r = applyAction(s, 'a', { type: 'drawDeck' });
  const k = applyAction(r.state, 'a', { type: 'knock' });
  assert(!k.ok, "can't knock after drawing");
}

// ─────────────────────────── Summary ───────────────────────────
console.log('\n' + '='.repeat(40));
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
