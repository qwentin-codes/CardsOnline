// Thirty-One (a.k.a. Scat / Blitz) — pure engine. Classic knock-based
// card game: 3 cards per hand, closest to 31 in a single suit wins.
// No network, no rendering, no randomness beyond shuffle.
//
// Rules implemented (the user's variant):
// - Standard 52-card deck. Ace=11, K/Q/J=10, 2..10 face value.
// - Each player holds 3 cards. On your turn, either KNOCK (signals
//   the final round) or DRAW (top of deck or top of discard) then
//   DISCARD one card back to the pile. You can't draw from discard
//   and re-discard that same card in the same turn.
// - Hand score: the highest same-suit sum of your 3 cards. Three of
//   a kind scores 30 (this is the user's variant — standard is 30.5
//   placing it between 30 and 31; we clamp to 30).
// - 31 (e.g. A♥ + K♥ + Q♥) is a "blitz": if your hand is 31 after
//   your discard, you reveal immediately, the round ends, and every
//   other active player loses 1 life. Also checked at the initial
//   deal — a dealt 31 wins on the spot.
// - Knock: at the start of your turn (before drawing), you may knock
//   instead of drawing. Everyone else gets exactly one more turn;
//   then showdown. Lowest hand loses 1 life. If the knocker is among
//   the lowest (or tied for lowest), the knocker loses 2 lives
//   (penalty for a bad knock) and the other lows are safe.
// - Lives: each player starts with 3 lives. When you run out of lives
//   you're eliminated. Last player standing wins the match.

export const SUITS = ['S', 'H', 'D', 'C']; // spades, hearts, diamonds, clubs
export const RANK_ACE = 1;
export const RANK_JACK = 11;
export const RANK_QUEEN = 12;
export const RANK_KING = 13;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

export const DEFAULT_RULES = {
  startingLives: 3,
  // Lives the knocker loses when they end up at (or tied for) lowest.
  // 2 = classic double-penalty (punishes a bad knock); 1 = soft rule
  // where the knocker pays the same as anyone else.
  knockerPenalty: 2,
};

export function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank++) deck.push({ rank, suit });
  }
  return deck;
}

export function shuffle(deck) {
  const a = [...deck];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const RANK_LABELS = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
export function cardLabel(card) {
  if (!card) return '';
  return `${RANK_LABELS[card.rank] || card.rank}${SUIT_SYMBOLS[card.suit] || card.suit}`;
}

export function cardValue(rank) {
  if (rank === RANK_ACE) return 11;
  if (rank >= RANK_JACK) return 10;
  return rank;
}

// Best same-suit sum. Three of a kind overrides to 30. Empty/partial
// hands score by the best available suit (useful during postDraw's
// 4-card intermediate state for UI peeks).
export function handScore(cards) {
  if (!cards || cards.length === 0) return 0;
  if (cards.length === 3 && cards[0].rank === cards[1].rank && cards[1].rank === cards[2].rank) {
    return 30;
  }
  const suitTotals = { S: 0, H: 0, D: 0, C: 0 };
  for (const c of cards) suitTotals[c.suit] += cardValue(c.rank);
  return Math.max(suitTotals.S, suitTotals.H, suitTotals.D, suitTotals.C);
}

// Which suit is contributing the score, for UI highlighting. Returns
// { suit: 'S'|'H'|'D'|'C'|null, threeOfKind: bool }. Ties break
// alphabetically (C < D < H < S), but that's just a deterministic
// fallback for display.
export function bestSuit(cards) {
  if (!cards || cards.length === 0) return { suit: null, threeOfKind: false };
  if (cards.length === 3 && cards[0].rank === cards[1].rank && cards[1].rank === cards[2].rank) {
    return { suit: null, threeOfKind: true };
  }
  const suitTotals = { S: 0, H: 0, D: 0, C: 0 };
  for (const c of cards) suitTotals[c.suit] += cardValue(c.rank);
  let best = 'S';
  for (const s of ['H', 'D', 'C']) if (suitTotals[s] > suitTotals[best]) best = s;
  return { suit: best, threeOfKind: false };
}

function activeIds(state) {
  return state.playerOrder.filter((id) => !state.players[id].eliminated);
}

function nextActive(state, fromId) {
  const order = state.playerOrder;
  const n = order.length;
  const idx = order.indexOf(fromId);
  for (let i = 1; i <= n; i++) {
    const candidate = order[(idx + i) % n];
    if (!state.players[candidate].eliminated) return candidate;
  }
  return null;
}

export function createGame(playerIds, names = {}, rulesIn = {}) {
  if (playerIds.length < MIN_PLAYERS) throw new Error(`Thirty-One needs at least ${MIN_PLAYERS} players`);
  if (playerIds.length > MAX_PLAYERS) throw new Error(`Thirty-One supports at most ${MAX_PLAYERS} players`);

  const rules = { ...DEFAULT_RULES, ...rulesIn };

  const players = {};
  for (const id of playerIds) {
    players[id] = {
      id,
      name: names[id] || id,
      hand: [],
      lives: rules.startingLives,
      eliminated: false,
      score: 0,
    };
  }

  const dealerIdx = Math.floor(Math.random() * playerIds.length);

  const state = {
    rules,
    startedAt: Date.now(),
    seed: Math.floor(Math.random() * 0x7fffffff),
    players,
    playerOrder: [...playerIds],
    dealer: playerIds[dealerIdx],
    turn: null,
    phase: 'preDraw',     // 'preDraw' | 'postDraw' | 'roundEnd'
    deck: [],
    discard: [],
    // Pickup tracking for the postDraw phase. pickupIndex is where in
    // the hand the drawn card sits — used by the engine to block
    // re-discard of a discard-pickup, and by the UI to highlight the
    // just-taken card.
    pickupSource: null,   // 'deck' | 'discard' | null
    pickupIndex: null,
    knockBy: null,
    turnsRemainingAfterKnock: null,
    round: 1,
    roundEnd: null,
    winner: null,
    log: [],
    lastAction: null,     // { type, playerId, ... } — animation hint
    undoSnapshot: null,   // per-player undo
    version: 0,
  };

  dealRound(state);
  return state;
}

function dealRound(state) {
  const active = activeIds(state);
  if (active.length <= 1) {
    state.winner = active[0] || null;
    state.phase = 'roundEnd';
    return;
  }
  const deck = shuffle(buildDeck());
  for (const id of state.playerOrder) {
    state.players[id].hand = [];
    state.players[id].score = 0;
  }
  for (let r = 0; r < 3; r++) {
    for (const id of active) state.players[id].hand.push(deck.pop());
  }
  const firstDiscard = deck.pop();
  state.deck = deck;
  state.discard = [firstDiscard];
  state.turn = nextActive(state, state.dealer);
  state.phase = 'preDraw';
  state.pickupSource = null;
  state.pickupIndex = null;
  state.knockBy = null;
  state.turnsRemainingAfterKnock = null;
  state.roundEnd = null;
  state.lastAction = null;
  state.undoSnapshot = null;
  state.log.push(`Round ${state.round} dealt. ${state.players[state.turn].name} leads.`);

  // Dealt-31: if any active player was dealt 31, blitz immediately.
  // Walk forward from the first-to-play so that if multiple players
  // (vanishingly rare) hit 31 at the same time, the earliest one in
  // turn order wins.
  let t = state.turn;
  for (let i = 0; i < active.length; i++) {
    if (handScore(state.players[t].hand) === 31) {
      finishRound(state, 'blitz', t);
      return;
    }
    t = nextActive(state, t);
  }
}

function finishRound(state, reason, blitzWinner = null) {
  const active = activeIds(state);
  const hands = {};
  for (const id of active) {
    hands[id] = {
      cards: state.players[id].hand.slice(),
      score: handScore(state.players[id].hand),
    };
  }
  const losses = {};
  const prevLives = {};
  for (const id of active) {
    losses[id] = 0;
    prevLives[id] = state.players[id].lives;
  }

  if (reason === 'blitz') {
    for (const id of active) if (id !== blitzWinner) losses[id] = 1;
  } else {
    // Knock showdown. Ties at lowest all lose, except when the knocker
    // is among the lowest — then only the knocker loses (2 lives).
    const minScore = Math.min(...active.map((id) => hands[id].score));
    const lowest = active.filter((id) => hands[id].score === minScore);
    const knocker = state.knockBy;
    if (knocker && lowest.includes(knocker)) {
      // Knocker-lowest penalty. Classic rule = 2 (double); soft rule = 1
      // (knocker pays the same as anyone else, and tied non-knockers
      // also lose a life since the knocker's penalty is no longer the
      // full tab).
      const penalty = state.rules?.knockerPenalty ?? 2;
      losses[knocker] = penalty;
      if (penalty === 1) {
        for (const id of lowest) if (id !== knocker) losses[id] = 1;
      }
    } else {
      for (const id of lowest) losses[id] = 1;
    }
  }

  for (const id of active) {
    state.players[id].score = hands[id].score;
    state.players[id].lives = Math.max(0, state.players[id].lives - losses[id]);
    if (state.players[id].lives <= 0) state.players[id].eliminated = true;
  }

  const remaining = activeIds(state);
  if (remaining.length === 1) state.winner = remaining[0];
  // 0 remaining (theoretical, e.g. blitz against a field where everyone
  // was on last life) — no winner; the UI treats this as a rare draw.

  state.roundEnd = {
    reason,
    blitzWinner,
    knocker: state.knockBy,
    hands,
    losses,
    prevLives,
    order: active.slice(),
  };
  state.phase = 'roundEnd';
  state.pickupSource = null;
  state.pickupIndex = null;

  if (reason === 'blitz') {
    state.log.push(`${state.players[blitzWinner].name} blitzed with 31!`);
  } else {
    state.log.push(`${state.players[state.knockBy].name} knocked — showdown.`);
  }
}

export function applyAction(state, playerId, action) {
  if (state.winner) return { ok: false, error: 'Match is over.', state };
  if (!action) return { ok: false, error: 'No action.', state };

  if (action.type === 'undo') {
    const snap = state.undoSnapshot;
    if (!snap) return { ok: false, error: 'Nothing to undo.', state };
    if (snap.actor !== playerId) return { ok: false, error: 'You can only undo your own last action.', state };
    const next = structuredClone(snap.state);
    next.undoSnapshot = null;
    next.version = (state.version || 0) + 1;
    return { ok: true, state: next };
  }

  if (action.type === 'nextRound') {
    if (state.phase !== 'roundEnd') return { ok: false, error: 'Round still in progress.', state };
    if (state.winner) return { ok: false, error: 'Match is over.', state };
    const next = structuredClone(state);
    next.round = state.round + 1;
    next.dealer = nextActive(state, state.dealer) || state.dealer;
    dealRound(next);
    next.undoSnapshot = null;
    next.version = (next.version || 0) + 1;
    return { ok: true, state: next };
  }

  if (state.phase === 'roundEnd') return { ok: false, error: 'Round is over — advance to the next one.', state };
  if (!state.players[playerId] || state.players[playerId].eliminated) {
    return { ok: false, error: 'You are eliminated.', state };
  }
  if (playerId !== state.turn) return { ok: false, error: 'Not your turn.', state };

  const pre = structuredClone({ ...state, undoSnapshot: null });
  const next = structuredClone(state);
  let res;
  switch (action.type) {
    case 'knock': res = applyKnock(next, playerId); break;
    case 'drawDeck': res = applyDrawDeck(next, playerId); break;
    case 'drawDiscard': res = applyDrawDiscard(next, playerId); break;
    case 'discard': res = applyDiscard(next, playerId, action); break;
    default: return { ok: false, error: `Unknown action '${action.type}'.`, state };
  }
  if (!res.ok) return { ok: false, error: res.error, state };

  // Only keep an undo snapshot if the round didn't end — otherwise an
  // undo would roll back into a re-scorable pre-blitz / pre-lastturn
  // state, which is confusing and lets a player dodge a bad outcome.
  next.undoSnapshot = next.phase === 'roundEnd' ? null : { state: pre, actor: playerId };
  next.version = (next.version || 0) + 1;
  return { ok: true, state: next };
}

function applyKnock(state, playerId) {
  if (state.phase !== 'preDraw') return { ok: false, error: 'You can only knock before drawing.' };
  if (state.knockBy) return { ok: false, error: 'Someone has already knocked.' };
  state.knockBy = playerId;
  const active = activeIds(state);
  state.turnsRemainingAfterKnock = active.length - 1;
  state.lastAction = { type: 'knock', playerId };
  state.log.push(`${state.players[playerId].name} knocked.`);
  if (state.turnsRemainingAfterKnock <= 0) {
    // Degenerate: everyone else is already eliminated. Showdown now.
    finishRound(state, 'knock');
    return { ok: true };
  }
  state.turn = nextActive(state, playerId);
  return { ok: true };
}

function applyDrawDeck(state, playerId) {
  if (state.phase !== 'preDraw') return { ok: false, error: 'You already drew this turn.' };
  if (state.deck.length === 0) {
    // Reshuffle everything but the top of the discard back into the deck.
    if (state.discard.length <= 1) return { ok: false, error: 'No cards left to draw.' };
    const top = state.discard.pop();
    state.deck = shuffle(state.discard);
    state.discard = [top];
  }
  const card = state.deck.pop();
  state.players[playerId].hand.push(card);
  state.pickupSource = 'deck';
  state.pickupIndex = state.players[playerId].hand.length - 1;
  state.phase = 'postDraw';
  state.lastAction = { type: 'drawDeck', playerId };
  return { ok: true };
}

function applyDrawDiscard(state, playerId) {
  if (state.phase !== 'preDraw') return { ok: false, error: 'You already drew this turn.' };
  if (state.discard.length === 0) return { ok: false, error: 'Discard pile is empty.' };
  const card = state.discard.pop();
  state.players[playerId].hand.push(card);
  state.pickupSource = 'discard';
  state.pickupIndex = state.players[playerId].hand.length - 1;
  state.phase = 'postDraw';
  state.lastAction = { type: 'drawDiscard', playerId, card };
  return { ok: true };
}

function applyDiscard(state, playerId, action) {
  if (state.phase !== 'postDraw') return { ok: false, error: 'You need to draw first.' };
  const idx = action.cardIndex;
  const hand = state.players[playerId].hand;
  if (typeof idx !== 'number' || idx < 0 || idx >= hand.length) {
    return { ok: false, error: 'Invalid card.' };
  }
  if (state.pickupSource === 'discard' && idx === state.pickupIndex) {
    return { ok: false, error: "You can't discard the card you just picked up." };
  }
  const [card] = hand.splice(idx, 1);
  state.discard.push(card);
  state.phase = 'preDraw';
  state.pickupSource = null;
  state.pickupIndex = null;
  state.lastAction = { type: 'discard', playerId, card };

  // Blitz: check BEFORE the knock-countdown so a 31 on a knocker's
  // last turn still wins, even if that discard would have ended the
  // round on a knock.
  if (handScore(state.players[playerId].hand) === 31) {
    finishRound(state, 'blitz', playerId);
    return { ok: true };
  }

  if (state.knockBy) {
    state.turnsRemainingAfterKnock -= 1;
    if (state.turnsRemainingAfterKnock <= 0) {
      finishRound(state, 'knock');
      return { ok: true };
    }
  }

  state.turn = nextActive(state, playerId);
  return { ok: true };
}
