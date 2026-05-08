import { useMemo, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { PlayingCard } from './Card.jsx';
import { Chat } from '../../Chat.jsx';
import { handScore, bestSuit, cardValue, cardLabel } from './engine.js';
import { useHueFor, useTurnAnnounceKey, TurnBanner } from '../turnBanner.jsx';

// Opponent flight animation: when a CPU (or remote player) acts, we
// render a "ghost" card traveling from the source (deck / discard /
// their hand area) to the destination (their hand / discard pile) so
// the move is visible. Self actions already have clear tap feedback,
// no flight needed.
const FLIGHT_MS = 800;
// Absolute-positioned flight overlay. Tweens from `from` rect to `to`
// rect via CSS transition. Card is rendered face-down for drawDeck
// (opponent hand receives a face-down card) or face-up for
// drawDiscard / discard (card value is visible).
function T31Flight({ card, faceDown, from, to, duration }) {
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    const f1 = requestAnimationFrame(() => {
      const f2 = requestAnimationFrame(() => setLanded(true));
      return () => cancelAnimationFrame(f2);
    });
    return () => cancelAnimationFrame(f1);
  }, []);
  if (!from || !to) return null;
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
  return (
    <div style={style} className="t31-flight-wrap" aria-hidden="true">
      <PlayingCard card={card} faceDown={faceDown} />
    </div>
  );
}

// After a round ends, opponent hands flip face-up on the board (a
// "dramatic reveal" before the scorecard opens). We hold the board
// in this reveal state for a beat so the user can read the hands,
// then show the "Show scoring →" prompt.
const BOARD_REVEAL_HOLD_MS = 2400;

// Card-movement animation timings. Kept short so gameplay doesn't drag
// but long enough that each action reads as a distinct event.
const DISCARD_POP_MS = 520;
const PICKUP_ANIM_MS = 380;
const OPPONENT_FLASH_MS = 700;
const DEAL_STAGGER_MS = 90;

// Track discard-top transitions so we can pop the landing card when a
// new one arrives. Returns a "pop key" that changes each time the top
// card flips; consumers use it to retrigger CSS animations.
function useDiscardPop(topCard) {
  const [popKey, setPopKey] = useState(0);
  const prev = useRef(null);
  useEffect(() => {
    const key = topCard ? `${topCard.rank}-${topCard.suit}` : null;
    if (prev.current !== null && key !== prev.current) {
      setPopKey((k) => k + 1);
    }
    prev.current = key;
  }, [topCard?.rank, topCard?.suit]);
  return popKey;
}

// Full-screen announcement banner for the two big events of Thirty-One:
// a knock (final lap starting) and a blitz (31 revealed — round over).
// Celebration pattern — fires once per event,
// holds for a couple seconds, then fades out. The banner is
// intentionally hard to miss so a fast CPU-to-CPU knock / blitz
// doesn't blow past the player.
function useBigEvent(state, myId) {
  const [event, setEvent] = useState(null); // { kind: 'knock'|'blitz', playerId, key }
  const prevKnockRef = useRef(state.knockBy);
  const prevBlitzRef = useRef(state.roundEnd?.reason === 'blitz' ? state.roundEnd.blitzWinner : null);

  useEffect(() => {
    const knocker = state.knockBy || null;
    if (knocker && knocker !== prevKnockRef.current) {
      setEvent({ kind: 'knock', playerId: knocker, key: `knock-${state.round}-${knocker}` });
      const t = setTimeout(() => setEvent((e) => (e?.kind === 'knock' ? null : e)), 2000);
      prevKnockRef.current = knocker;
      return () => clearTimeout(t);
    }
    if (!knocker) prevKnockRef.current = null;
  }, [state.knockBy, state.round]);

  useEffect(() => {
    const blitzer = state.roundEnd?.reason === 'blitz' ? state.roundEnd.blitzWinner : null;
    if (blitzer && blitzer !== prevBlitzRef.current) {
      setEvent({ kind: 'blitz', playerId: blitzer, key: `blitz-${state.round}-${blitzer}` });
      const t = setTimeout(() => setEvent((e) => (e?.kind === 'blitz' ? null : e)), 2400);
      prevBlitzRef.current = blitzer;
      return () => clearTimeout(t);
    }
    if (!blitzer) prevBlitzRef.current = null;
  }, [state.roundEnd, state.round]);

  return event;
}

// Flash-highlight the opponent who just drew or discarded, so the
// user can track whose turn just resolved. Returns the playerId who
// should be flashed right now (or null).
function useOpponentFlash(lastAction) {
  const [flashId, setFlashId] = useState(null);
  const prevKey = useRef(null);
  useEffect(() => {
    if (!lastAction) return;
    const key = `${lastAction.type}-${lastAction.playerId}-${lastAction.card?.rank ?? ''}-${lastAction.card?.suit ?? ''}`;
    if (key === prevKey.current) return;
    prevKey.current = key;
    if (lastAction.type !== 'discard' && lastAction.type !== 'drawDeck' && lastAction.type !== 'drawDiscard') return;
    setFlashId(lastAction.playerId);
    const t = setTimeout(() => setFlashId(null), OPPONENT_FLASH_MS);
    return () => clearTimeout(t);
  }, [lastAction?.type, lastAction?.playerId, lastAction?.card?.rank, lastAction?.card?.suit]);
  return flashId;
}

const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_CLASS = { S: 'suit-spade', H: 'suit-heart', D: 'suit-diamond', C: 'suit-club' };

export function Game({
  state, myId, onAction, onLeave,
  chatMessages = [], onSendChat, peerStatus, hideChat,
}) {
  const me = state.players[myId];
  const myTurn = state.turn === myId && !me?.eliminated && state.phase !== 'roundEnd';
  const canKnock = myTurn && state.phase === 'preDraw' && !state.knockBy;
  const canDraw = myTurn && state.phase === 'preDraw';
  const canDiscard = myTurn && state.phase === 'postDraw';
  const canUndo = !!state.undoSnapshot && state.undoSnapshot.actor === myId && state.phase !== 'roundEnd';

  const opponents = useMemo(
    () => state.playerOrder.filter((id) => id !== myId).map((id) => state.players[id]),
    [state.playerOrder, state.players, myId],
  );

  const discardTop = state.discard[state.discard.length - 1] || null;
  const discardPopKey = useDiscardPop(discardTop);
  const flashId = useOpponentFlash(state.lastAction);
  const bigEvent = useBigEvent(state, myId);

  // Opponent-flight overlay. Refs attach to source/target elements so
  // we can measure real positions when a flight is created. flights is
  // an array of active overlays. pendingOcclusion tracks which pile
  // top(s) should render their pre-action card during flight so the
  // state change doesn't visually pop in before the flight lands.
  const [flights, setFlights] = useState([]);
  const deckRef = useRef(null);
  const discardRef = useRef(null);
  const oppHandRefs = useRef({});
  const prevLastActionRef = useRef(state.lastAction);

  const hueFor = useHueFor(state);
  const turnAnnounceKey = useTurnAnnounceKey(state.turn, flights.length);

  const prevVersionRef = useRef(state.version || 0);
  useLayoutEffect(() => {
    const curVersion = state.version || 0;
    if (prevVersionRef.current === curVersion) return;
    prevVersionRef.current = curVersion;
    const la = state.lastAction;
    if (!la) return;
    if (la.playerId === myId) return; // self actions: no flight
    if (la.type !== 'drawDeck' && la.type !== 'drawDiscard' && la.type !== 'discard') return;

    const getRect = (el) => (el && el.getBoundingClientRect ? el.getBoundingClientRect() : null);
    const handEl = oppHandRefs.current[la.playerId];
    const deckEl = deckRef.current;
    const discardEl = discardRef.current;

    let fromEl, toEl, card, faceDown = false, occludeDiscardPile = false;
    if (la.type === 'drawDeck') {
      fromEl = deckEl;
      toEl = handEl;
      card = null; // unknown to other players
      faceDown = true;
    } else if (la.type === 'drawDiscard') {
      fromEl = discardEl;
      toEl = handEl;
      card = la.card;
      faceDown = false;
      occludeDiscardPile = true; // hide the "took this card" from discard pre-state
    } else if (la.type === 'discard') {
      fromEl = handEl;
      toEl = discardEl;
      card = la.card;
      faceDown = false;
      occludeDiscardPile = true; // hide the newly-placed discard until flight lands
    }
    const fromRect = getRect(fromEl);
    const toRect = getRect(toEl);
    if (!fromRect || !toRect) return;

    const id = `t31-flight-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setFlights((fs) => [...fs, { id, card, faceDown, fromRect, toRect, occludeDiscardPile, actionType: la.type }]);
    // Don't return a cleanup that cancels this timer — the cleanup
    // would fire on every subsequent action, leaving the flight (and
    // its discard occlusion) stuck in state forever.
    setTimeout(() => {
      setFlights((fs) => fs.filter((f) => f.id !== id));
    }, FLIGHT_MS + 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.lastAction?.stamp]);

  // Whether the discard pile should render its PRE-action top while a
  // flight involving it is in progress. If the in-flight action was
  // drawDiscard, the pre-top is the card being taken (top of state's
  // discard + 1). If it was discard, the pre-top is the OLD top (the
  // one before the newly-placed card).
  const activeDiscardFlight = flights.find((f) => f.occludeDiscardPile);
  let displayDiscardTop = discardTop;
  if (activeDiscardFlight) {
    if (activeDiscardFlight.actionType === 'drawDiscard') {
      // Pre-state: the card that was just taken is still on top.
      displayDiscardTop = activeDiscardFlight.card;
    } else if (activeDiscardFlight.actionType === 'discard') {
      // Pre-state: previous top (current length - 2).
      displayDiscardTop = state.discard[state.discard.length - 2] || null;
    }
  }

  // Two-step reveal gate: when a round ends, opponent hands flip face-
  // up ON the board (a "table reveal") and stay that way for ~2.4s
  // so the user can read each hand. After the hold, a Continue button
  // appears — clicking it opens the detailed scorecard overlay. Resets
  // each time the round advances.
  const [revealOpen, setRevealOpen] = useState(false);
  const [promptReady, setPromptReady] = useState(false);
  const roundEnded = state.phase === 'roundEnd' || !!state.winner;
  useEffect(() => {
    if (!roundEnded) {
      setRevealOpen(false);
      setPromptReady(false);
      return;
    }
    setRevealOpen(false);
    setPromptReady(false);
    const t = setTimeout(() => setPromptReady(true), BOARD_REVEAL_HOLD_MS);
    return () => clearTimeout(t);
  }, [roundEnded, state.round]);

  const showTableReveal = roundEnded;
  // Show the "YOUR LAST TURN" flair when someone else knocked and it's
  // now your turn (and you're not already the knocker). This is your
  // one shot before showdown.
  const isMyLastTurn = state.knockBy && state.knockBy !== myId && myTurn;

  return (
    <div className={`board thirtyone ${isMyLastTurn ? 't31-last-turn' : ''}`}>
      <TurnBanner
        announceKey={turnAnnounceKey}
        hue={hueFor(state.turn)}
        name={state.players[state.turn]?.name}
        isMe={state.turn === myId}
        hidden={!!state.winner || state.phase === 'roundEnd' || !!bigEvent}
      />
      {bigEvent && (
        <BigEventBanner event={bigEvent} state={state} myId={myId} />
      )}

      {isMyLastTurn && (
        <div className="t31-last-turn-banner">YOUR LAST TURN</div>
      )}

      <div className="t31-topbar">
        <div className="t31-round">Round {state.round}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="secondary" onClick={onLeave} style={{ padding: '4px 10px', fontSize: 12 }}>Leave</button>
        </div>
      </div>

      {state.knockBy && state.phase !== 'roundEnd' && !isMyLastTurn && (
        <div className="t31-knock-banner">
          {state.knockBy === myId ? 'You knocked' : `${state.players[state.knockBy].name} knocked`}
          {' — '}
          {state.turnsRemainingAfterKnock > 0
            ? `${state.turnsRemainingAfterKnock} turn${state.turnsRemainingAfterKnock === 1 ? '' : 's'} left`
            : 'showdown'}
        </div>
      )}

      <OpponentsRow
        opponents={opponents}
        state={state}
        flashId={flashId}
        showTableReveal={showTableReveal}
        oppHandRefs={oppHandRefs}
      />

      <Piles
        state={state}
        canDraw={canDraw}
        onDrawDeck={() => onAction({ type: 'drawDeck' })}
        onDrawDiscard={() => onAction({ type: 'drawDiscard' })}
        discardTop={displayDiscardTop}
        discardPopKey={discardPopKey}
        deckRef={deckRef}
        discardRef={discardRef}
      />

      {me && !me.eliminated && (
        <MyHand
          player={me}
          state={state}
          canDiscard={canDiscard}
          onDiscard={(i) => onAction({ type: 'discard', cardIndex: i })}
        />
      )}

      {me && !me.eliminated && (
        <ScorePanel hand={me.hand} phase={state.phase} lives={me.lives} />
      )}

      <div className="t31-actions">
        {roundEnded && promptReady && !revealOpen ? (
          <button
            onClick={() => setRevealOpen(true)}
            className="t31-knock-btn"
            style={{ padding: '10px 22px', fontSize: 15 }}
          >
            Continue →
          </button>
        ) : (
          <>
            <button
              disabled={!canKnock}
              onClick={() => onAction({ type: 'knock' })}
              className={canKnock ? 't31-knock-btn' : 'secondary'}
              style={{ padding: '10px 18px', fontSize: 15 }}
            >
              Knock
            </button>
            <button
              disabled={!canUndo}
              onClick={() => onAction({ type: 'undo' })}
              className="secondary"
              style={{ padding: '10px 18px', fontSize: 15 }}
            >
              Undo
            </button>
          </>
        )}
      </div>

      {me?.eliminated && (
        <div style={{ textAlign: 'center', color: 'var(--muted)', padding: 8 }}>
          You're out. Watching the rest of the match.
        </div>
      )}

      {state.phase === 'roundEnd' && revealOpen && !state.winner && (
        <RoundReveal state={state} myId={myId} onNext={() => onAction({ type: 'nextRound' })} />
      )}

      {state.winner && revealOpen && (
        <MatchOverOverlay state={state} myId={myId} onLeave={onLeave} />
      )}

      {!hideChat && <Chat messages={chatMessages} onSend={onSendChat} />}

      {flights.map((f) => (
        <T31Flight
          key={f.id}
          card={f.card}
          faceDown={f.faceDown}
          from={f.fromRect}
          to={f.toRect}
          duration={FLIGHT_MS}
        />
      ))}
    </div>
  );
}

// ───────────────────────── Opponents ─────────────────────────

function OpponentsRow({ opponents, state, flashId, showTableReveal, oppHandRefs }) {
  return (
    <div className={`t31-opponents ${showTableReveal ? 'revealing' : ''}`}>
      {opponents.map((p) => (
        <OpponentCard
          key={p.id}
          player={p}
          isTurn={state.turn === p.id && state.phase !== 'roundEnd'}
          isKnocker={state.knockBy === p.id}
          flash={flashId === p.id ? state.lastAction : null}
          showReveal={showTableReveal}
          score={showTableReveal ? handScore(p.hand) : null}
          handRef={(el) => { if (oppHandRefs) oppHandRefs.current[p.id] = el; }}
        />
      ))}
    </div>
  );
}

function OpponentCard({ player, isTurn, isKnocker, flash, showReveal, score, handRef }) {
  const eliminated = player.eliminated;
  const flashing = !!flash && !showReveal;
  const flashLabel = flash?.type === 'discard'
    ? 'discarded'
    : flash?.type === 'drawDeck'
      ? 'drew'
      : flash?.type === 'drawDiscard'
        ? 'took discard'
        : '';
  const best = showReveal ? bestSuit(player.hand) : null;
  return (
    <div className={`t31-opponent ${isTurn ? 'active' : ''} ${eliminated ? 'eliminated' : ''} ${flashing ? 'flashing' : ''} ${showReveal ? 'revealing' : ''}`}>
      <div className="t31-opponent-name">
        {player.isCpu && <span style={{ opacity: 0.7, marginRight: 4 }}>🤖</span>}
        {player.name}
        {isKnocker && <span className="t31-opponent-knock"> ✊</span>}
      </div>
      <div className="t31-opponent-cards" ref={handRef}>
        {!eliminated && player.hand.map((card, i) => {
          if (showReveal) {
            return (
              <div
                key={`${player.id}-rev-${i}`}
                className="t31-opp-reveal-wrap"
                style={{ animationDelay: `${i * 160}ms` }}
              >
                <PlayingCard card={card} className="t31-opp-reveal-card" />
                <div className="t31-opp-reveal-back" style={{ animationDelay: `${i * 160}ms` }} />
              </div>
            );
          }
          return <div key={i} className="pc face-down t31-mini-card" />;
        })}
      </div>
      {showReveal && score != null ? (
        <div className="t31-opp-reveal-score">
          {score}
          {best?.threeOfKind && <span className="t31-score-tag">3-of-a-kind</span>}
          {!best?.threeOfKind && best?.suit && (
            <span className={`t31-score-suit ${SUIT_CLASS[best.suit]}`}>{SUIT_SYMBOL[best.suit]}</span>
          )}
        </div>
      ) : (
        <Lives lives={player.lives} />
      )}
      {flashing && flashLabel && (
        <div className="t31-opponent-flash-label" key={flash.type}>{flashLabel}</div>
      )}
    </div>
  );
}

function Lives({ lives }) {
  // Visual: filled dots for current lives, hollow dots for lost.
  const total = 3;
  const dots = [];
  for (let i = 0; i < total; i += 1) {
    dots.push(
      <span key={i} className={`t31-life-dot ${i < lives ? 'on' : 'off'}`} />,
    );
  }
  return <div className="t31-lives">{dots}</div>;
}

// ───────────────────────── Piles ─────────────────────────

function Piles({ state, canDraw, onDrawDeck, onDrawDiscard, discardTop, discardPopKey, deckRef, discardRef }) {
  const deckCount = state.deck.length;
  return (
    <div className="t31-piles">
      <div className="t31-pile-col">
        <div className="t31-pile-label">Deck</div>
        <div
          ref={deckRef}
          className={`pc t31-deck-pile ${canDraw && deckCount > 0 ? 'clickable' : 'disabled'}`}
          onClick={canDraw && deckCount > 0 ? onDrawDeck : undefined}
        />
        <div className="t31-deck-count">{deckCount}</div>
      </div>
      <div className="t31-pile-col">
        <div className="t31-pile-label">Discard</div>
        <div ref={discardRef} style={{ display: 'inline-block' }}>
          {discardTop ? (
            <PlayingCard
              key={discardPopKey}
              card={discardTop}
              onClick={canDraw ? onDrawDiscard : undefined}
              highlight={canDraw}
              className="t31-discard-pop"
            />
          ) : (
            <div className="pc empty" />
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── My hand ─────────────────────────

function MyHand({ player, state, canDiscard, onDiscard }) {
  const pickupIdx = state.pickupIndex;
  const fromDiscard = state.pickupSource === 'discard';
  // Deal animation: retrigger whenever state.round changes (new hand).
  // Each card uses an index-based delay so they appear one by one. The
  // key includes the round so React remounts the card, replaying the
  // CSS animation. During postDraw we don't re-trigger — a draw isn't
  // a deal.
  const dealTrigger = `${state.round}-${state.phase === 'roundEnd' ? 'end' : 'live'}`;
  return (
    <div className="t31-hand">
      {player.hand.map((card, i) => {
        const isPickup = i === pickupIdx;
        const forbidden = canDiscard && fromDiscard && i === pickupIdx;
        const clickable = canDiscard && !forbidden;
        // Cards 0..2 are dealt cards; card 3 is the pickup. Animate
        // differently: dealt cards slide in from the deck with a
        // stagger, pickup flies in sharply from the deck/discard.
        let animClass = '';
        let inlineStyle = undefined;
        if (isPickup && state.phase === 'postDraw') {
          animClass = fromDiscard ? 't31-pickup-from-discard' : 't31-pickup-from-deck';
        } else {
          animClass = 't31-deal-in';
          inlineStyle = { animationDelay: `${i * DEAL_STAGGER_MS}ms` };
        }
        const classes = [animClass];
        if (clickable) classes.push('playable');
        return (
          <PlayingCard
            key={`${dealTrigger}-${i}`}
            card={card}
            onClick={clickable ? () => onDiscard(i) : undefined}
            highlight={isPickup && canDiscard && !forbidden}
            dim={forbidden}
            className={classes.join(' ')}
            style={inlineStyle}
          />
        );
      })}
    </div>
  );
}

// ───────────────────────── Score panel ─────────────────────────

function ScorePanel({ hand, phase, lives }) {
  const score = handScore(hand);
  const best = bestSuit(hand);
  // 4-card intermediate (postDraw): show the peek score but label it.
  const label = phase === 'postDraw' ? 'Best 3-card score' : 'Your score';
  return (
    <div className="t31-score-panel">
      <div className="t31-score-label">{label}</div>
      <div className="t31-score-value">
        {score}
        {best?.threeOfKind && <span className="t31-score-tag">3-of-a-kind</span>}
        {!best?.threeOfKind && best?.suit && (
          <span className={`t31-score-suit ${SUIT_CLASS[best.suit]}`}>{SUIT_SYMBOL[best.suit]}</span>
        )}
      </div>
      {typeof lives === 'number' && (
        <>
          <div className="t31-score-label">Lives</div>
          <Lives lives={lives} />
        </>
      )}
    </div>
  );
}

// ───────────────────────── Big-event banner ─────────────────────────

function BigEventBanner({ event, state, myId }) {
  const name = state.players[event.playerId]?.name || 'Someone';
  const isMe = event.playerId === myId;
  if (event.kind === 'knock') {
    return (
      <div key={event.key} className="t31-celebrate t31-celebrate-knock" role="status">
        <div className="t31-celebrate-label">KNOCK!</div>
        <div className="t31-celebrate-name">{isMe ? 'YOU' : name}</div>
        <div className="t31-celebrate-sub">one more turn each</div>
      </div>
    );
  }
  // blitz
  return (
    <div key={event.key} className="t31-celebrate t31-celebrate-blitz" role="status">
      <div className="t31-celebrate-label">31!</div>
      <div className="t31-celebrate-name">{isMe ? 'YOU BLITZED' : `${name} BLITZED`}</div>
      <div className="t31-celebrate-sub">everyone else loses a life</div>
    </div>
  );
}

// ───────────────────────── Round reveal ─────────────────────────

function RoundReveal({ state, myId, onNext }) {
  const rend = state.roundEnd;
  if (!rend) return null;
  const headline = rend.reason === 'blitz'
    ? (rend.blitzWinner === myId
      ? 'You blitzed with 31!'
      : `${state.players[rend.blitzWinner].name} blitzed with 31!`)
    : (rend.knocker === myId
      ? 'You knocked — showdown'
      : `${state.players[rend.knocker].name} knocked — showdown`);

  return (
    <div className="t31-overlay" role="dialog" aria-modal="true">
      <div className="t31-overlay-inner">
        <div className="t31-overlay-headline">{headline}</div>
        <div className="t31-reveal-rows">
          {rend.order.map((id) => (
            <RevealRow
              key={id}
              player={state.players[id]}
              hand={rend.hands[id].cards}
              score={rend.hands[id].score}
              prevLives={rend.prevLives[id]}
              lossN={rend.losses[id]}
              isMe={id === myId}
              isKnocker={id === rend.knocker}
              isBlitzer={id === rend.blitzWinner}
            />
          ))}
        </div>
        {!state.winner && (
          <button onClick={onNext} style={{ marginTop: 12 }}>Next round →</button>
        )}
      </div>
    </div>
  );
}

function RevealRow({ player, hand, score, prevLives, lossN, isMe, isKnocker, isBlitzer }) {
  const best = bestSuit(hand);
  // Cards flip face-up one at a time for effect. For the player, we
  // don't bother hiding-then-flipping since they know their own hand,
  // but the stagger still plays. For opponents the cards briefly
  // appear face-down then flip — we achieve this with a CSS animation
  // that starts with a back-face overlay that fades out.
  return (
    <div className={`t31-reveal-row ${isBlitzer ? 'is-blitzer' : ''} ${isKnocker ? 'is-knocker' : ''}`}>
      <div className="t31-reveal-left">
        <div className="t31-reveal-name">
          {player.name}{isMe && <span style={{ color: 'var(--muted)', marginLeft: 4 }}>(you)</span>}
          {isKnocker && <span className="t31-reveal-tag">knock</span>}
          {isBlitzer && <span className="t31-reveal-tag blitz">31!</span>}
        </div>
        <div className="t31-reveal-cards">
          {hand.map((c, i) => (
            <div
              key={i}
              className={`t31-reveal-card-wrap ${isMe ? 'own' : 'opp'}`}
              style={{ animationDelay: `${i * 140}ms` }}
            >
              <PlayingCard card={c} className="t31-mini-reveal" />
              {!isMe && <div className="t31-reveal-back" />}
            </div>
          ))}
        </div>
      </div>
      <div className="t31-reveal-right">
        <div className="t31-reveal-score">
          {score}
          {best?.threeOfKind && <span className="t31-score-tag">3-of-a-kind</span>}
          {!best?.threeOfKind && best?.suit && (
            <span className={`t31-score-suit ${SUIT_CLASS[best.suit]}`}>{SUIT_SYMBOL[best.suit]}</span>
          )}
        </div>
        <LifeChange prev={prevLives} loss={lossN} />
      </div>
    </div>
  );
}

function LifeChange({ prev, loss }) {
  const now = Math.max(0, prev - loss);
  // Render three dots with "lost-this-round" styling for the dots that
  // are about to blink out.
  const total = 3;
  const dots = [];
  for (let i = 0; i < total; i += 1) {
    let cls;
    if (i < now) cls = 'on';
    else if (i < prev) cls = 'losing';
    else cls = 'off';
    dots.push(<span key={i} className={`t31-life-dot ${cls}`} />);
  }
  return (
    <div className="t31-lifechange">
      <div className="t31-lives">{dots}</div>
      {loss > 0 && <div className="t31-loss">−{loss}</div>}
      {loss === 0 && <div className="t31-loss safe">safe</div>}
    </div>
  );
}

// ───────────────────────── Match over ─────────────────────────

function MatchOverOverlay({ state, myId, onLeave }) {
  const winner = state.players[state.winner];
  const youWon = state.winner === myId;
  return (
    <div className="t31-overlay" role="dialog" aria-modal="true">
      <div className="t31-overlay-inner">
        <div className="t31-overlay-headline" style={{ fontSize: 22 }}>
          {youWon ? '🏆 You won the match!' : `${winner.name} won the match`}
        </div>
        <div style={{ color: 'var(--muted)', marginTop: 8, textAlign: 'center' }}>
          Everyone else is out of lives.
        </div>
        <button onClick={onLeave} style={{ marginTop: 16 }}>Back to home</button>
      </div>
    </div>
  );
}
