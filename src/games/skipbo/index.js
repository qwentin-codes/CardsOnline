// Game descriptor for Skip-Bo. The shared infrastructure (net.js,
// App.jsx) treats this as the full contract for running a game —
// everything engine-specific routes through here.

import { createGame, applyAction, MAX_PLAYERS, MIN_PLAYERS, requiredDecks } from './engine.js';
import { cpuPlan } from './bot.js';
import { Game } from './Game.jsx';
import { Lobby } from './Lobby.jsx';

export const skipboGame = {
  id: 'skipbo',
  name: 'Skip-Bo',
  createGame,
  applyAction,
  cpuPlan,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  defaultRules: { stockSize: 30, handSize: 5, maxDiscardDepth: null },
  // CPU pacing — discards feel slower because they end a turn and the
  // next player deserves a beat to register the change.
  botActionDelay: (action) => (action.type === 'discard' ? 1400 : 1100),
  botBetweenTurns: 700,
  // React components that render the in-game board and the pre-game
  // lobby. Both are passed the standard shared props.
  Game,
  Lobby,
  // Utility for Lobby's stock-size warning and practice-setup UI.
  requiredDecks,
};
