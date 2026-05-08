// Skip-Bo game engine — pure functions, host-authoritative.

export const SKIPBO = 'S';
export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 2;

export const DEFAULT_RULES = {
  // null = auto: 30 for 2-4, 20 for 5-6, 15 for 7-8
  stockSize: null,
  handSize: 5,
  // null = unlimited depth per discard pile
  maxDiscardDepth: null,
  // number of build piles in the middle
  buildPileCount: 4,
  // number of personal discard piles per player
  discardPileCount: 4,
};

export function autoStockSize(playerCount) {
  if (playerCount <= 4) return 30;
  if (playerCount <= 6) return 20;
  return 15;
}

export function resolveRules(rules, playerCount) {
  const R = { ...DEFAULT_RULES, ...(rules || {}) };
  if (R.stockSize == null) R.stockSize = autoStockSize(playerCount);
  return R;
}

export const CARDS_PER_DECK = 162;
export const MIN_DRAW_BUFFER = 20;

export function buildDeck(count = 1) {
  const deck = [];
  for (let d = 0; d < count; d++) {
    for (let n = 1; n <= 12; n++) {
      for (let i = 0; i < 12; i++) deck.push(n);
    }
    for (let i = 0; i < 18; i++) deck.push(SKIPBO);
  }
  return deck;
}

// Smallest number of decks that leaves at least MIN_DRAW_BUFFER cards
// in the draw pile after dealing stockpiles and the opening hand.
export function requiredDecks(playerCount, stockSize, handSize) {
  const needed = stockSize * playerCount + handSize + MIN_DRAW_BUFFER;
  return Math.max(1, Math.ceil(needed / CARDS_PER_DECK));
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createGame(playerIds, names, rules) {
  const R = resolveRules(rules, playerIds.length);
  const deckCount = requiredDecks(playerIds.length, R.stockSize, R.handSize);
  const deck = shuffle(buildDeck(deckCount));
  const players = {};
  for (const id of playerIds) {
    const discards = [];
    for (let i = 0; i < R.discardPileCount; i++) discards.push([]);
    players[id] = {
      id,
      name: names[id] || id,
      stock: deck.splice(0, R.stockSize),
      hand: [],
      discards,
    };
  }
  // Pick a random starter so the room creator doesn't always get
  // the first move. Only that player's hand is dealt up front —
  // everyone else draws when their turn comes around.
  const starterIdx = Math.floor(Math.random() * playerIds.length);
  const starterId = playerIds[starterIdx];
  players[starterId].hand = deck.splice(0, R.handSize);

  const buildPiles = [];
  for (let i = 0; i < R.buildPileCount; i++) buildPiles.push([]);

  return {
    rules: R,
    deckCount,
    startedAt: Date.now(),
    turnNumber: 1,
    // Unique per-game value so clients can derive presentation choices
    // (like player colors) that vary game-to-game yet agree across
    // clients for a given game. Not used by engine logic itself.
    seed: Math.floor(Math.random() * 0x7fffffff),
    players,
    playerOrder: [...playerIds],
    turn: starterId,
    deck,
    buildPiles,
    completedPiles: [],
    log: [
      `Game started with ${playerIds.length} players${deckCount > 1 ? ` (${deckCount} decks combined)` : ''}.`,
    ],
    winner: null,
    version: 0,
  };
}

export function canPlayToBuild(card, buildPile) {
  const next = buildPile.length + 1;
  if (next > 12) return false;
  if (card === SKIPBO) return true;
  return card === next;
}

function drawHand(state) {
  const p = state.players[state.turn];
  const handSize = state.rules.handSize;
  while (p.hand.length < handSize) {
    if (state.deck.length === 0) {
      if (state.completedPiles.length === 0) break;
      state.deck = shuffle(state.completedPiles);
      state.completedPiles = [];
      state.log.push('Reshuffled completed build piles into the deck.');
    }
    p.hand.push(state.deck.shift());
  }
}

function advanceTurn(state) {
  const idx = state.playerOrder.indexOf(state.turn);
  state.turn = state.playerOrder[(idx + 1) % state.playerOrder.length];
  state.turnNumber = (state.turnNumber || 1) + 1;
  drawHand(state);
}

export function applyAction(state, playerId, action) {
  if (state.winner) return { ok: false, error: 'Game is over', state };
  if (playerId !== state.turn) return { ok: false, error: "Not your turn", state };

  const next = structuredClone(state);
  const p = next.players[next.turn];

  if (action.type === 'play') {
    const bp = next.buildPiles[action.buildPile];
    if (!bp) return { ok: false, error: 'Bad build pile', state };

    let card;
    if (action.from === 'hand') card = p.hand[action.index];
    else if (action.from === 'stock') card = p.stock[p.stock.length - 1];
    else if (action.from === 'discard') {
      const pile = p.discards[action.index];
      card = pile[pile.length - 1];
    } else return { ok: false, error: 'Bad source', state };

    if (card === undefined) return { ok: false, error: 'No card there', state };
    if (!canPlayToBuild(card, bp)) return { ok: false, error: 'Card does not match build pile', state };

    bp.push(card);
    if (action.from === 'hand') p.hand.splice(action.index, 1);
    else if (action.from === 'stock') p.stock.pop();
    else if (action.from === 'discard') p.discards[action.index].pop();

    next.log.push(`${p.name} played ${card === SKIPBO ? 'Skip-Bo' : card} → pile ${action.buildPile + 1}.`);

    if (bp.length === 12) {
      next.completedPiles.push(...bp);
      next.buildPiles[action.buildPile] = [];
      next.log.push(`Pile ${action.buildPile + 1} completed.`);
    }

    if (p.stock.length === 0) {
      next.winner = p.id;
      next.log.push(`🎉 ${p.name} wins!`);
    } else if (p.hand.length === 0) {
      drawHand(next);
      next.log.push(`${p.name} emptied their hand — drew fresh cards.`);
    }

    next.version += 1;
    return { ok: true, state: next };
  }

  if (action.type === 'discard') {
    const card = p.hand[action.handIndex];
    if (card === undefined) return { ok: false, error: 'No card', state };
    if (action.discardPile < 0 || action.discardPile >= next.rules.discardPileCount)
      return { ok: false, error: 'Bad discard pile', state };

    const target = p.discards[action.discardPile];
    if (next.rules.maxDiscardDepth != null && target.length >= next.rules.maxDiscardDepth) {
      return { ok: false, error: `Discard pile is at max depth (${next.rules.maxDiscardDepth})`, state };
    }

    p.hand.splice(action.handIndex, 1);
    target.push(card);
    next.log.push(`${p.name} discarded ${card === SKIPBO ? 'Skip-Bo' : card} → pile ${action.discardPile + 1}.`);

    advanceTurn(next);
    next.version += 1;
    return { ok: true, state: next };
  }

  return { ok: false, error: 'Unknown action', state };
}
