// Quick smoke test of the engine. Run with: node src/engine.test.mjs
import { createGame, applyAction, SKIPBO, canPlayToBuild, buildDeck, shuffle, requiredDecks, CARDS_PER_DECK } from './engine.js';
import { cpuPlan } from './bot.js';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('  ok -', msg);
}

console.log('Deck composition');
const d = buildDeck();
assert(d.length === 162, 'deck has 162 cards');
assert(d.filter((c) => c === SKIPBO).length === 18, '18 skip-bo wilds');
for (let n = 1; n <= 12; n++) {
  assert(d.filter((c) => c === n).length === 12, `12 copies of ${n}`);
}

// Starter is now randomized, so loop until we get the seat we want.
// Keeps each assertion deterministic without needing to thread a
// starter option through the engine API.
function createWithStarter(ids, names, starter) {
  let g;
  for (let i = 0; i < 500; i++) {
    g = createGame(ids, names);
    if (g.turn === starter) return g;
  }
  throw new Error(`could not force starter ${starter} after 500 tries`);
}

console.log('\nGame creation');
const g = createWithStarter(['a', 'b'], { a: 'Alice', b: 'Bob' }, 'a');
assert(g.turn === 'a', 'alice goes first (forced)');
assert(g.players.a.stock.length === 30, 'alice has 30 stock cards');
assert(g.players.b.stock.length === 30, 'bob has 30 stock cards');
assert(g.players.a.hand.length === 5, 'alice has 5 hand cards');
assert(g.players.b.hand.length === 0, 'bob has 0 hand cards pregame');
assert(g.buildPiles.length === 4, '4 build piles');

console.log('\nForce a state where alice has a 1 to play');
let s = createWithStarter(['a', 'b'], { a: 'Alice', b: 'Bob' }, 'a');
s.players.a.hand = [1, 5, 7, SKIPBO, 12];
s.players.a.stock = [2, 3, 4, 9];
// play the 1
let r = applyAction(s, 'a', { type: 'play', from: 'hand', index: 0, buildPile: 0 });
assert(r.ok, 'played 1 to build pile');
assert(r.state.buildPiles[0].length === 1, 'build pile 0 has one card');
assert(r.state.players.a.hand.length === 4, 'hand decreased');
// play skipbo as 2
r = applyAction(r.state, 'a', { type: 'play', from: 'hand', index: 2, buildPile: 0 });
assert(r.ok, 'played skipbo as 2');
assert(r.state.buildPiles[0].length === 2, 'pile has 2 cards');
// can't play 5 now (needs 3)
r = applyAction(r.state, 'a', { type: 'play', from: 'hand', index: 0, buildPile: 0 });
assert(!r.ok, 'cannot play 5 when 3 is expected');

console.log('\nDiscard ends turn');
let s2 = createWithStarter(['a', 'b'], { a: 'Alice', b: 'Bob' }, 'a');
const hand0 = s2.players.a.hand[0];
let r2 = applyAction(s2, 'a', { type: 'discard', handIndex: 0, discardPile: 0 });
assert(r2.ok, 'alice discards');
assert(r2.state.turn === 'b', 'turn passed to bob');
assert(r2.state.players.a.discards[0][0] === hand0, 'discard pile has the card');
assert(r2.state.players.b.hand.length === 5, 'bob drew 5');

console.log('\nWin condition');
let s3 = createGame(['a', 'b'], { a: 'Alice', b: 'Bob' });
s3.players.a.hand = [SKIPBO, 2, 3, 4, 5];
s3.players.a.stock = [1]; // one card left
let r3 = applyAction(s3, 'a', { type: 'play', from: 'stock', buildPile: 0 });
assert(r3.ok, 'played last stock card');
assert(r3.state.winner === 'a', 'alice wins');

console.log('\nMax discard depth rule');
let s4 = createGame(['a', 'b'], { a: 'A', b: 'B' }, { maxDiscardDepth: 2 });
s4.players.a.discards[0] = [1, 2];
let r4 = applyAction(s4, 'a', { type: 'discard', handIndex: 0, discardPile: 0 });
assert(!r4.ok, 'discard rejected at max depth');

console.log('\nBuild pile completion resets and cycles');
let s5 = createGame(['a', 'b'], { a: 'A', b: 'B' });
s5.buildPiles[0] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]; // needs a 12
s5.players.a.hand = [12, 1, 1, 1, 1];
let r5 = applyAction(s5, 'a', { type: 'play', from: 'hand', index: 0, buildPile: 0 });
assert(r5.ok, 'played 12 to complete pile');
assert(r5.state.buildPiles[0].length === 0, 'pile was cleared');
assert(r5.state.completedPiles.length === 12, 'completed cards moved aside');

console.log('\nMulti-deck auto-scaling');
assert(requiredDecks(4, 30, 5) === 1, '4p × 30 stock fits in 1 deck');
assert(requiredDecks(6, 20, 5) === 1, '6p × 20 stock fits in 1 deck');
assert(requiredDecks(6, 30, 5) === 2, '6p × 30 stock needs 2 decks');
assert(requiredDecks(8, 20, 5) === 2, '8p × 20 stock needs 2 decks');
assert(requiredDecks(8, 50, 5) === 3, '8p × 50 stock needs 3 decks');

console.log('\n8-player game uses 2 decks automatically');
const many = ['a','b','c','d','e','f','g','h'];
const names8 = Object.fromEntries(many.map((id) => [id, id.toUpperCase()]));
const g8 = createGame(many, names8, { stockSize: 30, handSize: 5 });
assert(g8.deckCount === 2, `g8.deckCount = ${g8.deckCount} (expected 2 for 8p × 30 stock)`);
assert(isCanonicalDeck(inventory(g8), 2), '2-deck game has 2× canonical cards');
assert(g8.players.a.stock.length === 30, 'each player still gets 30 stock');

console.log('\nCustom rule: stockSize override');
const gc = createGame(['a', 'b'], { a: 'A', b: 'B' }, { stockSize: 25 });
assert(gc.players.a.stock.length === 25, 'custom stockSize=25 respected');

// ─────────────── Card conservation & shuffle uniformity ───────────────
// Track every card in every location to ensure nothing is created,
// duplicated, or lost during play — the deck stays a real-world deck.

function inventory(state) {
  const counts = new Map();
  const bump = (c) => counts.set(c, (counts.get(c) || 0) + 1);
  for (const c of state.deck) bump(c);
  for (const c of state.completedPiles) bump(c);
  for (const bp of state.buildPiles) for (const c of bp) bump(c);
  for (const p of Object.values(state.players)) {
    for (const c of p.stock) bump(c);
    for (const c of p.hand) bump(c);
    for (const pile of p.discards) for (const c of pile) bump(c);
  }
  return counts;
}
function totalCards(counts) {
  let t = 0;
  for (const v of counts.values()) t += v;
  return t;
}
function isCanonicalDeck(counts, deckCount = 1) {
  if (totalCards(counts) !== 162 * deckCount) return false;
  if (counts.get(SKIPBO) !== 18 * deckCount) return false;
  for (let n = 1; n <= 12; n++) if (counts.get(n) !== 12 * deckCount) return false;
  return true;
}

console.log('\nCard conservation');
{
  const s = createGame(['a','b','c'], { a: 'A', b: 'B', c: 'C' });
  const inv = inventory(s);
  assert(isCanonicalDeck(inv), 'starting state has exactly 12×each + 18 wilds = 162');
}

console.log('\nConservation across a full game played by the CPU bot');
{
  let s = createGame(['a','b','c','d'], { a: 'A', b: 'B', c: 'C', d: 'D' });
  let actions = 0;
  let turns = 0;
  while (!s.winner && turns < 5000) {
    const plan = cpuPlan(s, s.turn);
    if (!plan.length) break;
    for (const act of plan) {
      const res = applyAction(s, s.turn, act);
      if (!res.ok) throw new Error('bot picked an illegal move: ' + res.error);
      s = res.state;
      actions += 1;
      if (s.winner) break;
    }
    turns += 1;
    if (!isCanonicalDeck(inventory(s))) {
      throw new Error(`card count drifted after turn ${turns}`);
    }
  }
  assert(actions > 100, `played ${actions} legal actions across ${turns} turns`);
  assert(isCanonicalDeck(inventory(s)), 'deck still canonical at end of game');
  if (s.winner) assert(true, `game ended with winner: ${s.winner}`);
}

console.log('\nShuffle produces many distinct orderings');
{
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(shuffle(buildDeck()).join(','));
  assert(seen.size === 500, `500/500 shuffles were distinct (got ${seen.size})`);
}

console.log('\nShuffle is roughly uniform — chi-square on first-position card');
{
  // Over N shuffles, the first slot should land on each unique card type
  // proportional to its count in the deck. 18 wilds / 162 = 11.1%.
  const N = 20000;
  const first = new Map();
  for (let i = 0; i < N; i++) {
    const d = shuffle(buildDeck());
    first.set(d[0], (first.get(d[0]) || 0) + 1);
  }
  // Expected counts: wild → 18/162 * N, each number → 12/162 * N.
  const expWild = 18 / 162 * N;
  const expNum  = 12 / 162 * N;
  let chi = 0;
  chi += ((first.get(SKIPBO) - expWild) ** 2) / expWild;
  for (let n = 1; n <= 12; n++) chi += ((first.get(n) - expNum) ** 2) / expNum;
  // 13 categories → df=12; critical value at p=0.001 is ~32.9.
  assert(chi < 32.9, `chi-square ${chi.toFixed(2)} < 32.9 (uniform at p=0.001)`);
}

console.log('\nAll engine tests passed.');
