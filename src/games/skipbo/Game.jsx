import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Card, EmptySlot, Stockpile, DiscardPile, Deck } from './Card.jsx';
import { Chat } from '../../Chat.jsx';
import { canPlayToBuild, SKIPBO } from './engine.js';

// Build pile top: a wild card's "value" equals its position in the
// pile (pile length), so when a wild is on top we overlay a small
// badge with that number. Works correctly no matter how many wilds
// are stacked — the top-most wild always shows its effective value.
function BuildPileTop({ bp, onClick, className }) {
  const top = bp[bp.length - 1];
  if (top !== SKIPBO) {
    return <Card key={`bp-${bp.length}`} card={top} onClick={onClick} className={className} />;
  }
  return (
    <div className="wild-value-wrap" onClick={onClick}>
      <Card key={`bp-${bp.length}`} card={top} className={className} />
      <span className="wild-value-badge">{bp.length}</span>
    </div>
  );
}

// Curated, visually-distinct hue palette. The order is re-shuffled
// once per game (using state.seed) so opponents get fresh colors each
// time, but every client derives the same mapping from the same seed.
// Entries are spaced 45° apart around the color wheel so no two hues
// can read as "the same color" — important because the palette size
// equals MAX_PLAYERS, so every seat always gets a distinct hue.
const PLAYER_HUES = [20, 65, 110, 155, 200, 245, 290, 335];

// Mulberry32 PRNG — fast, deterministic, and good enough for a quick
// Fisher-Yates shuffle. Same seed → same sequence on every client.
function seededShuffle(seed, arr) {
  let s = (seed | 0) || 1;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Directive-flight animations for OPPONENT moves only. When a CPU or
// remote player performs an action, we animate a "ghost" card flying
// from the source (opponent stock / mini-hand / discard pile) to the
// destination (build pile or their own discard pile) so the move is
// easy to follow. Self moves already have clear tap → land feedback
// (and their normal .fly-in animation at the build pile) so no flight
// is spawned for them.
//
// Flight is rendered at the target card's own dimensions so it can
// hand off to the real card at its resting place with no size jump.
// We measure the actual .sb-card inside each target wrapper rather
// than the wrapper itself (the wrapper for an opponent discard pile
// spans the whole vertical cascade, which would make the flight way
// too tall).
const FLIGHT_MS = 800;

// Absolute-positioned "ghost" card that tweens from the source rect to
// the target rect via CSS transition. Size is fixed so it reads as a
// small card in motion regardless of what element we measured on each
// end. Purely decorative — the actual state change still flows through
// React normally.
function FlyingCard({ card, from, to, duration, targetKind }) {
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    const f1 = requestAnimationFrame(() => {
      const f2 = requestAnimationFrame(() => setLanded(true));
      return () => cancelAnimationFrame(f2);
    });
    return () => cancelAnimationFrame(f1);
  }, []);
  if (!from || !to) return null;
  // Flight sized to match the target card's actual dimensions so the
  // final landed frame IS the resting card. Start position centers
  // that target-sized ghost on the source.
  const w = to.width;
  const h = to.height;
  const startX = from.left + from.width / 2 - w / 2;
  const startY = from.top + from.height / 2 - h / 2;
  const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
  const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
  const style = {
    position: 'fixed',
    left: startX,
    top: startY,
    width: w,
    height: h,
    pointerEvents: 'none',
    zIndex: 500,
    transition: `transform ${duration}ms cubic-bezier(0.33, 0, 0.2, 1)`,
    transform: landed ? `translate(${dx}px, ${dy}px)` : 'translate(0, 0)',
    willChange: 'transform',
  };
  // Give the flight wrapper a scope class so the inner card inherits
  // the destination's text sizes / border weight. We can't reuse
  // `.opponent` for this — that class also paints a green-gradient
  // panel background + border + padding, which showed up around the
  // flight card as a "container". `.sb-flight-opponent` applies only
  // the card-scale cascade (via our own CSS block) without any panel
  // styling.
  const scopeClass = targetKind === 'oppDiscard' ? 'sb-flight-opponent' : '';
  return (
    <div style={style} className={`sb-flight-wrap ${scopeClass}`} aria-hidden="true">
      <Card card={card} />
    </div>
  );
}

// selection: { from: 'hand'|'stock'|'discard', index?: number }
export function Game({ state, myId, onAction, onRequestUndo, onVoteUndo, chatMessages, onSendChat, onLeave, error, hideChat }) {
  const [selection, setSelection] = useState(null);
  const [showChat, setShowChat] = useState(false);
  const [expandedDiscard, setExpandedDiscard] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  // Tick once a second while a vote is active so the countdown updates.
  useEffect(() => {
    if (!state.undoVote) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [state.undoVote]);

  const me = state.players[myId];
  const isMyTurn = state.turn === myId && !state.winner;

  // Opponent-action flight overlay. Self moves already have clear
  // tap → land feedback so no flight is needed; but opponent moves
  // just pop numbers onto build piles with no visible motion, which
  // is hard to track. When state.version advances and the previous
  // turn was NOT me, diff the state to find source (opp stock /
  // opp mini-hand / opp discard pile) and target (build pile OR
  // opp discard pile), then fly a ghost card between them.
  const [flights, setFlights] = useState([]);
  const oppStockRefs = useRef({});    // [playerId] → el
  const oppHandRefs = useRef({});     // [playerId] → el
  const oppDiscardRefs = useRef({});  // [`${playerId}:${i}`] → el
  const buildPileRefs = useRef({});
  const prevStateRef = useRef(state);

  // useLayoutEffect (not useEffect) so the flights array is updated
  // synchronously after DOM mutations but BEFORE the browser paints.
  // That means the target-hiding logic applies in the same paint as
  // the state update — the new card never flashes at the destination
  // before the flight starts.
  useLayoutEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (!prev || prev.version === state.version) return;
    // Only animate actions made by non-self players. Self actions
    // already have clear tap → card-lands feedback.
    const actor = prev.turn; // turn BEFORE the action was applied
    if (!actor || actor === myId) return;
    const prevP = prev.players[actor];
    const curP = state.players[actor];
    if (!prevP || !curP) return;

    // Find source: did the actor's stock, a discard pile, or hand
    // shrink? (Or, for plays from hand: hand count also drops.)
    let source = null;
    let card = null;
    if (curP.stock.length < prevP.stock.length) {
      source = { kind: 'stock', key: actor };
      card = prevP.stock[prevP.stock.length - 1];
    } else if (curP.hand.length < prevP.hand.length) {
      source = { kind: 'hand', key: actor };
      // We don't know which hand index the opponent played — just use
      // the mini-hand as the visual source. Card is inferred from
      // destination diff below.
    } else {
      // Check discard piles
      for (let i = 0; i < prevP.discards.length; i += 1) {
        if (curP.discards[i].length < prevP.discards[i].length) {
          source = { kind: 'discard', key: `${actor}:${i}` };
          card = prevP.discards[i][prevP.discards[i].length - 1];
          break;
        }
      }
    }
    if (!source) return;

    // Find destination: a build pile or one of actor's discard piles.
    let target = null;
    for (let i = 0; i < state.buildPiles.length; i += 1) {
      if (state.buildPiles[i].length > prev.buildPiles[i].length) {
        target = { kind: 'build', key: i };
        if (card == null) card = state.buildPiles[i][state.buildPiles[i].length - 1];
        break;
      }
    }
    if (!target) {
      for (let i = 0; i < curP.discards.length; i += 1) {
        if (curP.discards[i].length > prevP.discards[i].length) {
          target = { kind: 'oppDiscard', key: `${actor}:${i}` };
          if (card == null) card = curP.discards[i][curP.discards[i].length - 1];
          break;
        }
      }
    }
    if (!target || card == null) return;

    // Resolve rects via the appropriate refs. For discard piles the
    // wrapper spans a tall cascade (card × stack-height), so we pick
    // the top-most visible .sb-card inside instead — that's the single
    // card-sized slot where a new card actually lands.
    const get = (el) => (el && el.getBoundingClientRect ? el.getBoundingClientRect() : null);
    const resolveSrc = () => {
      if (source.kind === 'stock') {
        const wrap = oppStockRefs.current[source.key];
        const card = wrap?.querySelector('.sb-card');
        return rectAtAnchor(wrap, card, 'top');
      }
      if (source.kind === 'hand') return get(oppHandRefs.current[source.key]);
      if (source.kind === 'discard') {
        const wrap = oppDiscardRefs.current[source.key];
        const card = wrap?.querySelector('.sb-card:last-of-type');
        return rectAtAnchor(wrap, card, 'bottom');
      }
      return null;
    };
    // Target positioning helper:
    //   - If there's a card element to measure, use its ACTUAL rendered
    //     rect (getBoundingClientRect). This is the truth — whatever
    //     size and position the target card has, the flight will land
    //     on it.
    //   - If the target slot is empty (build pile, empty discard),
    //     derive a card-sized rect from the wrapper's position + CSS
    //     --card-w/h so the flight still lands at a plausible slot.
    const rectAtAnchor = (wrap, cardEl, anchor /* 'top' | 'bottom' */) => {
      if (!wrap) return null;
      if (cardEl) {
        const r = cardEl.getBoundingClientRect();
        return {
          left: r.left, top: r.top, width: r.width, height: r.height,
          right: 0, bottom: 0, x: 0, y: 0,
        };
      }
      const w = wrap.getBoundingClientRect();
      const cs = getComputedStyle(wrap);
      const cardW = parseFloat(cs.getPropertyValue('--card-w')) || w.width;
      const cardH = parseFloat(cs.getPropertyValue('--card-h')) || w.height;
      return {
        left: w.left + w.width / 2 - cardW / 2,
        top: anchor === 'bottom' ? w.bottom - cardH : w.top,
        width: cardW, height: cardH,
        right: 0, bottom: 0, x: 0, y: 0,
      };
    };
    const resolveTgt = () => {
      if (target.kind === 'build') {
        const wrap = buildPileRefs.current[target.key];
        const card = wrap?.querySelector('.sb-card');
        return rectAtAnchor(wrap, card, 'top');
      }
      if (target.kind === 'oppDiscard') {
        // We're occluding opp discards now, so the DOM currently shows
        // the cascade MINUS the new top. Measure the last rendered
        // card (the previous top) and add one cascade offset (3px in
        // compact / opponent mode) to get where the new card will
        // land. If there's no prior card (empty pile), anchor at the
        // wrapper's top.
        const wrap = oppDiscardRefs.current[target.key];
        const last = wrap?.querySelector('.sb-card:last-of-type');
        const cs = wrap ? getComputedStyle(wrap) : null;
        const cardW = cs ? parseFloat(cs.getPropertyValue('--card-w')) : 0;
        const cardH = cs ? parseFloat(cs.getPropertyValue('--card-h')) : 0;
        if (last) {
          const r = last.getBoundingClientRect();
          const CASCADE_OFFSET = 3; // compact mode
          return {
            left: r.left, top: r.top + CASCADE_OFFSET,
            width: cardW || r.width, height: cardH || r.height,
            right: 0, bottom: 0, x: 0, y: 0,
          };
        }
        // Empty pile — anchor at wrapper top, card-sized.
        return rectAtAnchor(wrap, null, 'top');
      }
      return null;
    };
    const sRect = resolveSrc();
    const tRect = resolveTgt();
    if (!sRect || !tRect) return;

    const id = `flight-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setFlights((f) => [...f, { id, card, sourceRect: sRect, targetRect: tRect, target }]);
    // IMPORTANT: do NOT return a cleanup that clears this timer. The
    // cleanup runs every time `state.version` changes (next action),
    // which would cancel the in-flight removal — leaving the flight
    // in the `flights` array forever, which keeps the build pile (or
    // opp discard) visually peeled for the rest of the game. Per-
    // flight timers are independent; let each one fire on its own.
    setTimeout(() => {
      setFlights((f) => f.filter((x) => x.id !== id));
    }, FLIGHT_MS + 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.version]);
  // Opponents stay in fixed turn order — scroll-into-view snaps to the
  // active player so you can track whose turn it is without reordering
  // the pane (which was visually disorienting mid-game).
  const opponents = state.playerOrder
    .filter((id) => id !== myId)
    .map((id) => state.players[id]);

  // Pulse the deck briefly whenever the deck count decreases (a card was drawn).
  const [drawPulse, setDrawPulse] = useState(false);
  const prevDeckRef = useRef(state.deck.length);
  useEffect(() => {
    if (state.deck.length < prevDeckRef.current) {
      setDrawPulse(true);
      const t = setTimeout(() => setDrawPulse(false), 360);
      prevDeckRef.current = state.deck.length;
      return () => clearTimeout(t);
    }
    prevDeckRef.current = state.deck.length;
  }, [state.deck.length]);

  // Flash a banner each time the turn changes so the next player is
  // obviously signaled. Keyed so it remounts and re-animates on every
  // hand-off. We defer the banner firing until any in-flight card
  // animations for the PREVIOUS turn have landed — otherwise the
  // banner appears over the top of the prior player's still-moving
  // discard flight, which reads as a cut. If there are no flights in
  // progress (e.g. at game start), the banner fires immediately.
  const [turnAnnounceKey, setTurnAnnounceKey] = useState(0);
  // Initialize to a sentinel so the FIRST render of the Game component
  // (game start) also fires the banner for whoever goes first.
  const lastTurnRef = useRef(null);
  const pendingTurnRef = useRef(false);
  useEffect(() => {
    if (lastTurnRef.current !== state.turn) {
      lastTurnRef.current = state.turn;
      pendingTurnRef.current = true;
    }
    // Fire if no flights are pending.
    if (pendingTurnRef.current && flights.length === 0) {
      pendingTurnRef.current = false;
      setTurnAnnounceKey((k) => k + 1);
    }
  }, [state.turn, flights.length]);

  // Completed-pile animation: when a build pile transitions from
  // non-empty to empty, briefly render the top card (retrieved from
  // completedPiles) with a celebratory scale+glow+fly-off, so the
  // completion is visible instead of vanishing instantly.
  //
  // Important: the clearing timers are deliberately NOT cancelled in
  // the effect cleanup. When the effect re-runs for a later state
  // update (which happens every subsequent move), cleaning up would
  // cancel the in-flight timer for the previous completion, leaving
  // its entry in `completingPiles` forever — the pile-complete card
  // animation ends at opacity:0, which then *hides the build-pile
  // slot entirely* (no EmptySlot renders because `completing` is
  // truthy). An uncleaned timer on unmount is harmless here (React
  // just warns).
  const [completingPiles, setCompletingPiles] = useState([]);
  const prevBuildPilesRef = useRef(state.buildPiles);
  useEffect(() => {
    const prev = prevBuildPilesRef.current;
    const toAnimate = [];
    for (let i = 0; i < state.buildPiles.length; i++) {
      if ((prev[i]?.length || 0) > 0 && state.buildPiles[i].length === 0) {
        const topCard = state.completedPiles[state.completedPiles.length - 1];
        toAnimate.push({ pileIdx: i, card: topCard, key: `${Date.now()}-${i}` });
      }
    }
    prevBuildPilesRef.current = state.buildPiles;
    if (toAnimate.length) {
      setCompletingPiles((cur) => [...cur, ...toAnimate]);
      toAnimate.forEach((a) => {
        setTimeout(() => {
          setCompletingPiles((cur) => cur.filter((x) => x.key !== a.key));
        }, 1300);
      });
    }
  }, [state.buildPiles, state.completedPiles]);

  // Track the hand length BEFORE the most recent state change so we
  // can deal-animate only the newly-added cards. If the hand goes from
  // 4 → 5, only index 4 should fly in; the pre-existing 4 cards stay
  // put. handPrevLen is the snapshot used during THIS render; it
  // updates to the current length on each render cycle.
  const handPrevLenRef = useRef(me?.hand.length ?? 0);
  const handPrevLen = handPrevLenRef.current;
  useEffect(() => {
    handPrevLenRef.current = me?.hand.length ?? 0;
  });

  const clearSel = () => setSelection(null);

  const cardAt = (sel) => {
    if (!sel || !me) return null;
    if (sel.from === 'hand') return me.hand[sel.index];
    if (sel.from === 'stock') return me.stock[me.stock.length - 1];
    if (sel.from === 'discard') {
      const d = me.discards[sel.index];
      return d[d.length - 1];
    }
    return null;
  };

  // Drag-and-drop: pointer-based so it works on mouse + touch. Tap-to-
  // select still works — a short press with no movement falls through
  // to the click behavior.
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  dragRef.current = drag;
  const draggedCard = drag ? cardAt(drag.source) : null;
  const effectiveSelectedCard = draggedCard ?? cardAt(selection);

  const selectIfMine = (sel) => {
    if (!isMyTurn) return;
    setSelection((prev) =>
      prev && prev.from === sel.from && prev.index === sel.index ? null : sel
    );
  };

  // Drag activation threshold. Touch fingers regularly jitter 4-10px on
  // a tap even when the user thinks they held still — previously at 8px
  // that jitter would flip the gesture into "drag mode" and any pointer-
  // up not over a drop target would silently cancel the tap. We raise
  // the threshold and also fall back to tap behavior when a drag ends
  // off-target, so a tap never gets silently eaten.
  const DRAG_ACTIVATE_PX = 14;

  // Helper: run the "this was a tap" behavior for the given source.
  // Factored out so both the no-movement path AND the drag-released-
  // off-target path can use it.
  function handleTap(source) {
    if (source.from === 'discard') {
      // If a hand card is selected, drop it. If this pile is already
      // the current selection, toggle it off. Otherwise select this
      // pile (so the next tap on a build pile plays its top card) and
      // expand it so the player can see what's underneath.
      if (selection?.from === 'hand') {
        onAction({ type: 'discard', handIndex: selection.index, discardPile: source.index });
        clearSel();
        setExpandedDiscard(null);
      } else if (selection?.from === 'discard' && selection.index === source.index) {
        clearSel();
        setExpandedDiscard(null);
      } else if (isMyTurn) {
        setSelection({ from: 'discard', index: source.index });
        setExpandedDiscard(source.index);
      } else {
        setExpandedDiscard((cur) => (cur === source.index ? null : source.index));
      }
    } else {
      selectIfMine(source);
    }
  }

  function startDrag(source, e) {
    if (!isMyTurn || state.winner) return;
    const card = e.currentTarget;
    try { card.setPointerCapture(e.pointerId); } catch {}
    setDrag({
      source,
      pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      x: e.clientX, y: e.clientY,
      active: false,
      overTarget: null,
    });

    const onMove = (ev) => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== d.pointerId) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      const active = d.active || Math.hypot(dx, dy) > DRAG_ACTIVATE_PX;
      let overTarget = null;
      if (active) {
        const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-drop]');
        overTarget = el?.dataset.drop || null;
      }
      setDrag({ ...d, x: ev.clientX, y: ev.clientY, active, overTarget });
    };
    const onUp = (ev) => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== d.pointerId) return;
      card.removeEventListener('pointermove', onMove);
      card.removeEventListener('pointerup', onUp);
      card.removeEventListener('pointercancel', onUp);
      setDrag(null);
      if (d.active && d.overTarget) {
        commitDrop(d.source, d.overTarget);
      } else {
        // Either the gesture never passed the drag threshold (a clean
        // tap) or it became a drag but was released off any drop target.
        // In both cases, fall through to tap behavior so the gesture
        // isn't silently eaten.
        handleTap(d.source);
      }
    };
    card.addEventListener('pointermove', onMove);
    card.addEventListener('pointerup', onUp);
    card.addEventListener('pointercancel', onUp);
  }

  function commitDrop(source, target) {
    const [kind, idxStr] = target.split(':');
    const idx = Number(idxStr);
    if (kind === 'build') {
      onAction({ type: 'play', from: source.from, index: source.index, buildPile: idx });
    } else if (kind === 'discard' && source.from === 'hand') {
      onAction({ type: 'discard', handIndex: source.index, discardPile: idx });
    }
    clearSel();
  }

  const onBuildPile = (bpIdx) => {
    if (!isMyTurn || !selection) return;
    onAction({ type: 'play', from: selection.from, index: selection.index, buildPile: bpIdx });
    clearSel();
  };

  // Targets currently occluded — render them in their PRE-action
  // appearance (empty / previous top) while a flight is in progress so
  // the card never pops in at the destination before the flight
  // arrives. We occlude in TWO phases:
  //   1. Existing flights in state.flights (mid-animation).
  //   2. Any build pile / opp discard whose content grew vs the PREV
  //      state in this same render. This handles the very first render
  //      of a new state — the flight isn't created until useLayoutEffect
  //      runs AFTER commit, so without this pre-occlusion the new top
  //      would flash for one frame before the flight overlaid it.
  const hiddenBuildTargets = new Set();
  const hiddenOppDiscardTargets = new Set();
  for (const f of flights) {
    if (f.target?.kind === 'build') hiddenBuildTargets.add(f.target.key);
    else if (f.target?.kind === 'oppDiscard') hiddenOppDiscardTargets.add(f.target.key);
  }
  // Opponent discards that just grew via an opponent action. We now
  // OCCLUDE them the same way we occlude build piles — render the
  // pre-action cascade so the new card doesn't pop in at the bottom
  // before the flight arrives. The occlusion is added synchronously
  // during this render (via state diff), one frame before the flight
  // is registered in useLayoutEffect.
  const prevStateSnapshot = prevStateRef.current;
  if (prevStateSnapshot && prevStateSnapshot.version !== state.version && prevStateSnapshot.turn && prevStateSnapshot.turn !== myId) {
    // Build pile: occlude so the card doesn't pop in at the destination.
    for (let i = 0; i < state.buildPiles.length; i += 1) {
      const prevLen = prevStateSnapshot.buildPiles?.[i]?.length || 0;
      if (state.buildPiles[i].length > prevLen) hiddenBuildTargets.add(i);
    }
    // Opp discards: occlude the just-grown ones too.
    for (const opId of state.playerOrder) {
      if (opId === myId) continue;
      const prevOp = prevStateSnapshot.players?.[opId];
      const curOp = state.players?.[opId];
      if (!prevOp || !curOp) continue;
      for (let i = 0; i < curOp.discards.length; i += 1) {
        const prevLen = prevOp.discards?.[i]?.length || 0;
        if (curOp.discards[i].length > prevLen) hiddenOppDiscardTargets.add(`${opId}:${i}`);
      }
    }
  }

  // Track which build piles were most recently UPDATED by an opponent
  // action (vs a self action). Opponent-placed tops should never play
  // `.fly-in` because the flight animation already provided their
  // motion; applying fly-in afterward (or on a later unrelated re-
  // render) would double-animate. Self-placed tops keep `.fly-in` so
  // the player's own plays still have the normal pop-in feel. The set
  // is cleared for a pile when it completes (length 12 → 0) or when
  // the player places a new top on it.
  const buildPileOpponentPlacedRef = useRef(new Set());
  if (prevStateSnapshot && prevStateSnapshot.version !== state.version) {
    const isSelfActor = prevStateSnapshot.turn === myId;
    for (let i = 0; i < state.buildPiles.length; i += 1) {
      const prevLen = prevStateSnapshot.buildPiles?.[i]?.length || 0;
      const curLen = state.buildPiles[i].length;
      if (curLen > prevLen) {
        // Pile grew
        if (isSelfActor) buildPileOpponentPlacedRef.current.delete(i);
        else buildPileOpponentPlacedRef.current.add(i);
      } else if (curLen === 0 && prevLen > 0) {
        // Pile completed and reset
        buildPileOpponentPlacedRef.current.delete(i);
      }
    }
  }

  const undoVote = state.undoVote;
  const isUndoVoter = undoVote && undoVote.voters.includes(myId) && myId !== undoVote.requester;
  const myVote = isUndoVoter ? undoVote.votes[myId] : undefined;
  const secondsLeft = undoVote ? Math.max(0, Math.ceil((undoVote.deadlineAt - now) / 1000)) : 0;
  const requesterName = undoVote ? state.players[undoVote.requester]?.name || 'Someone' : '';
  const yesCount = undoVote ? Object.values(undoVote.votes).filter((v) => v === true).length : 0;
  const noCount = undoVote ? Object.values(undoVote.votes).filter((v) => v === false).length : 0;

  const shuffledPalette = useMemo(() => seededShuffle(state.seed || 0, PLAYER_HUES), [state.seed]);
  const hueFor = (id) => {
    const idx = state.playerOrder.indexOf(id);
    if (idx < 0) return 153;
    return shuffledPalette[idx % shuffledPalette.length];
  };
  const activeHue = hueFor(state.turn);
  const activePlayerName = state.turn === myId ? 'Your' : `${state.players[state.turn]?.name || 'Player'}'s`;

  return (
    <div className="board">
      {!state.winner && turnAnnounceKey > 0 && (
        <div
          key={turnAnnounceKey}
          className="turn-announcement"
          style={{ '--player-hue': activeHue }}
        >
          {activePlayerName} turn
        </div>
      )}
      {undoVote && (
        <div className="undo-banner">
          <div className="undo-banner-row">
            <strong>{requesterName}</strong> wants to undo their last move.
            <span className="undo-banner-meta">
              {yesCount}/{undoVote.required} yes · {noCount} no · {secondsLeft}s
            </span>
          </div>
          {isUndoVoter && typeof myVote !== 'boolean' && onVoteUndo && (
            <div className="undo-banner-actions">
              <button onClick={() => onVoteUndo(true)}>Allow</button>
              <button className="secondary" onClick={() => onVoteUndo(false)}>Deny</button>
            </div>
          )}
          {isUndoVoter && typeof myVote === 'boolean' && (
            <div className="undo-banner-meta">You voted {myVote ? 'allow' : 'deny'}.</div>
          )}
          {myId === undoVote.requester && (
            <div className="undo-banner-meta">Waiting for the others…</div>
          )}
        </div>
      )}
      <div className="top-bar">
        <div>
          Room <span className="room-code">{state.roomCode || ''}</span>
        </div>
        <div>Set aside: {state.completedPiles.length}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {state.undoAvailable && state.lastActor === myId && !state.undoVote && !state.winner && onRequestUndo && (
            <button
              className="secondary"
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={onRequestUndo}
              title="Ask other players to let you take back your last action."
            >
              Undo
            </button>
          )}
          {!hideChat && (
            <button className="secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setShowChat((v) => !v)}>
              {showChat ? 'Hide chat' : 'Chat'}
            </button>
          )}
          <button className="secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={onLeave}>Leave</button>
        </div>
      </div>

      <div className="opponents">
        {opponents.map((op) => {
          const hue = hueFor(op.id);
          return (
          <div
            key={op.id}
            className={`opponent ${op.id === state.turn ? 'active' : ''}`}
            style={{ '--player-hue': hue }}
            ref={op.id === state.turn ? (el) => el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }) : null}
          >
            <div className="opp-header">
              <span className="opp-name">{op.name}</span>
              <span ref={(el) => { oppHandRefs.current[op.id] = el; }}>
                <MiniHand count={op.hand.length} />
              </span>
            </div>
            <div className="opp-body">
              <div ref={(el) => { oppStockRefs.current[op.id] = el; }}>
                <Stockpile
                  topCard={op.stock[op.stock.length - 1]}
                  count={op.stock.length}
                />
              </div>
              <div className="discard-row opp-discards">
                {op.discards.map((d, i) => {
                  const key = `${op.id}:${i}`;
                  const occluded = hiddenOppDiscardTargets.has(key);
                  // Render the pre-action cascade while a flight is in
                  // motion toward this pile so the new card doesn't
                  // appear at the bottom before the flight lands.
                  const displayD = occluded ? d.slice(0, -1) : d;
                  return (
                    <div
                      key={i}
                      ref={(el) => { oppDiscardRefs.current[key] = el; }}
                      className={occluded ? 'opp-flight-target' : ''}
                    >
                      <DiscardPile cards={displayD} compact />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          );
        })}
      </div>

      {!state.winner && (
        isMyTurn
          ? <div className="turn-banner">Your turn</div>
          : <div className="turn-banner waiting">{state.players[state.turn]?.name || 'Someone'}'s turn</div>
      )}

      <div className="build-area">
        <div className="build-label">Build piles</div>
        <div className="build-piles">
          <Deck count={state.deck.length} drawPulse={drawPulse} />
          {state.buildPiles.map((bp, i) => {
            const next = bp.length + 1;
            const playable = effectiveSelectedCard != null && canPlayToBuild(effectiveSelectedCard, bp);
            const dragOver = drag?.active && drag.overTarget === `build:${i}`;
            const completing = completingPiles.find((c) => c.pileIdx === i);
            const occluded = hiddenBuildTargets.has(i);
            // While a flight is heading to this pile, render the
            // pre-action state (the previous top, or empty) so the card
            // doesn't visibly pop in at the destination before the
            // flight animates on top of it.
            const displayBp = occluded ? bp.slice(0, -1) : bp;
            // Apply .fly-in (the normal pop-in on a new top) ONLY when
            // the current top was placed by the player themselves. For
            // opponent-placed tops, the flight overlay already provided
            // the motion; adding fly-in would re-animate on every
            // subsequent render.
            const skipFlyIn = buildPileOpponentPlacedRef.current.has(i);
            const topAnimClass = skipFlyIn ? '' : 'fly-in';
            return (
              <div
                key={i}
                className="build-pile"
                data-drop={`build:${i}`}
                ref={(el) => { buildPileRefs.current[i] = el; }}
              >
                {completing ? (
                  <Card key={completing.key} card={completing.card} className="pile-complete" />
                ) : displayBp.length > 0
                  ? <BuildPileTop
                      bp={displayBp}
                      onClick={() => onBuildPile(i)}
                      className={`${topAnimClass} ${playable ? 'target' : ''} ${dragOver ? 'drop-hover' : ''}`}
                    />
                  : <EmptySlot onClick={() => onBuildPile(i)} className={`${playable ? 'target' : ''} ${dragOver ? 'drop-hover' : ''}`} label={(selection || drag?.active) ? 'Play 1' : ''} />
                }
              </div>
            );
          })}
        </div>
      </div>

      <div className="my-area">
        <div className="my-stock-wrap">
          <div className="my-section-label">Your stock</div>
          <div
            onPointerDown={(e) => me.stock.length > 0 && startDrag({ from: 'stock' }, e)}
            style={{ touchAction: 'none' }}
          >
            <Stockpile
              topCard={me.stock[me.stock.length - 1]}
              count={me.stock.length}
              selected={selection?.from === 'stock'}
              label=""
            />
          </div>
        </div>

        <div className="hand-wrap">
          <div className="my-section-label">Your hand ({me.hand.length})</div>
          <div className="hand">
            {me.hand.length === 0 && <span style={{ color: 'var(--muted)' }}>Empty</span>}
            {me.hand.map((c, i) => {
              const isDragging = drag?.active && drag.source.from === 'hand' && drag.source.index === i;
              // Only apply the deal animation to cards that weren't in
              // the hand on the previous render. i >= handPrevLen means
              // this slot is newly-added. Previously-held cards stay
              // put with no re-animation.
              const isNew = i >= handPrevLen;
              const newIdx = i - handPrevLen;
              return (
                <div
                  key={i}
                  onPointerDown={(e) => startDrag({ from: 'hand', index: i }, e)}
                  style={{ touchAction: 'none' }}
                >
                  <Card
                    card={c}
                    selected={selection?.from === 'hand' && selection.index === i}
                    className={`${isNew ? 'dealing' : ''} ${isDragging ? 'card-dragging' : ''}`}
                    style={isNew ? { animationDelay: `${newIdx * 150}ms` } : undefined}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="my-discards-wrap">
        <div className="my-section-label">Your discard piles</div>
        <div className="discard-row">
          {me.discards.map((d, i) => {
            const isSelected = selection?.from === 'discard' && selection.index === i;
            const targetable = selection?.from === 'hand' || (drag?.active && drag.source.from === 'hand');
            const dragOver = drag?.active && drag.overTarget === `discard:${i}`;
            const isExpanded = expandedDiscard === i;
            const onEmptyClick = () => {
              if (selection?.from === 'hand') {
                onAction({ type: 'discard', handIndex: selection.index, discardPile: i });
                clearSel();
              }
            };
            return (
              <div
                key={i}
                data-drop={`discard:${i}`}
                onPointerDown={(e) => d.length > 0 && startDrag({ from: 'discard', index: i }, e)}
                onClick={d.length === 0 ? onEmptyClick : undefined}
                style={{ touchAction: 'none' }}
                className={dragOver ? 'drop-hover-wrap' : ''}
              >
                <DiscardPile
                  cards={d}
                  selected={isSelected}
                  targetable={targetable}
                  expanded={isExpanded}
                />
              </div>
            );
          })}
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {selection && (
        <div className="actions">
          <button className="secondary" onClick={clearSel}>Deselect</button>
        </div>
      )}

      {showChat && !hideChat && <Chat messages={chatMessages} onSend={onSendChat} compact />}

      <div className="log">
        {state.log.slice(-8).map((line, i) => <div key={i}>{line}</div>)}
      </div>

      {flights.map((f) => (
        <FlyingCard key={f.id} card={f.card} from={f.sourceRect} to={f.targetRect} duration={FLIGHT_MS} targetKind={f.target?.kind} />
      ))}

      {state.winner && (
        <div className="winner-overlay">
          <h2>{state.winner === myId ? '🎉 You won!' : `${state.players[state.winner].name} wins`}</h2>
          <button onClick={onLeave}>Back to lobby</button>
        </div>
      )}

      {drag?.active && draggedCard !== undefined && (
        <div
          className="drag-ghost"
          style={{ left: drag.x, top: drag.y }}
        >
          <Card card={draggedCard} />
        </div>
      )}
    </div>
  );
}

function MiniHand({ count }) {
  const MAX_VISIBLE = 6;
  const visible = Math.min(count, MAX_VISIBLE);
  const offset = 7;
  const cardWidth = 18;
  const fanWidth = visible > 0 ? cardWidth + (visible - 1) * offset : cardWidth;
  return (
    <div className="mini-hand">
      <div className="mini-hand-fan" style={{ width: fanWidth }}>
        {count === 0 ? (
          <div className="mini-hand-empty" />
        ) : (
          Array.from({ length: visible }).map((_, i) => (
            <div key={i} className="mini-hand-card" style={{ left: i * offset, zIndex: i }} />
          ))
        )}
      </div>
      <span className="mini-hand-count">{count}</span>
    </div>
  );
}
