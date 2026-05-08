import { createGame, applyAction, MAX_PLAYERS, MIN_PLAYERS, DEFAULT_RULES } from './engine.js';
import { cpuPlan } from './bot.js';
import { Game } from './Game.jsx';
import { Lobby } from './Lobby.jsx';

export const thirtyoneGame = {
  id: 'thirtyone',
  name: 'Thirty-One',
  createGame,
  applyAction,
  cpuPlan,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  defaultRules: { ...DEFAULT_RULES },
  // Scat turns are a single draw + single discard. Keep pacing snappy
  // during normal play, but once someone knocks we bump every delay so
  // the user can actually watch each final turn unfold instead of the
  // round ending in a blur. The knock banner (2s hold) also wants
  // breathing room before CPU actions resume.
  botActionDelay: (action, state) => {
    const bump = state?.knockBy ? 700 : 0;
    if (!action) return 1000 + bump;
    if (action.type === 'knock') return 900 + Math.random() * 500;
    if (action.type === 'drawDeck' || action.type === 'drawDiscard') return 700 + Math.random() * 400 + bump;
    return 900 + Math.random() * 500 + bump;
  },
  botBetweenTurns: 300,
  Game,
  Lobby,
};
