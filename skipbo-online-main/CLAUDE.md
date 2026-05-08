# Project notes — Online Card Games

Browser card-game app hosted on Vercel. React 18 + Vite + JavaScript.

## Current scope

- Brand: Online Card Games, not a family game board.
- Games currently exposed: Skip-Bo and Thirty-One.
- Removed from the active app: Bastra and Play Nine.
- Players type a display name directly; there is no preset "playing as" name picker.

## Backend

- Multiplayer rooms, room discovery, chat, profiles, and cloud stats use MongoDB through Vercel serverless API routes in `/api`.
- Required Vercel environment variable: `MONGODB_URI`.
- Optional Vercel environment variable: `MONGODB_DB` (defaults to `online_card_games`).
- `src/realtimeNet.js` polls MongoDB room rows through `/api/rooms` and uses optimistic version checks for actions.

## Useful commands

- `npm run dev` — local Vite development server.
- `npm run build` — production build.
- `npm run preview` — preview the built app.
