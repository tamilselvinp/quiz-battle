# QUIZ BATTLE — Netlify-ready multiplayer game

A private-room multiplayer quiz using the existing React/Vite/Tailwind interface and a standard Netlify Function. No always-on backend, Socket.IO server, external database, API key, or manual database provisioning is required.

## Drag-and-drop publishing

1. Sign in to Netlify in your browser.
2. Download and extract `netlify-ready-game.zip`.
3. Drag the extracted **project folder** (the folder containing `netlify.toml`, `package.json`, `package-lock.json`, `src/`, and `netlify/`) onto the logged-in Netlify Drop page.
4. Netlify detects the project, installs dependencies, runs `npm run build`, publishes `dist/`, and packages the function from `netlify/functions/`.
5. Open the deployed site URL in two separate browser sessions. Player 1 creates a room; Player 2 joins with the room code.

Do not drag only the `dist/` folder: that would publish the frontend without the game function. A manual static-only upload cannot run server functions. Netlify's logged-in project Drop/build flow is required for this full-stack project.

## Architecture

- Frontend: React 19, Vite 8, Tailwind CSS 4.
- Backend: `netlify/functions/game.ts`, invoked directly at `/.netlify/functions/game`.
- Storage: Netlify Blobs site-wide store `quiz-battle-state`, opened with `consistency: 'strong'`. Netlify injects the site credentials at runtime; no token, API key, database setup, or user environment variable is required.
- Concurrency: room state mutations use ETag conditional writes (`onlyIfMatch`) and new room creation uses `onlyIfNew`. A conflict causes a fresh read and bounded retry.
- Transport: HTTP POST polling (not Socket.IO). A standard Netlify Function is request/response based and cannot hold a persistent WebSocket connection. The UI polls about once per second; player presence writes are throttled to once every two seconds; missed heartbeats are detected after four seconds, followed by a 30-second reconnect window.

## Gameplay

- Individual Mode, private six-character rooms, 2–20 players.
- Ten questions across three rounds (4 + 3 + 3).
- Each question lasts 20 seconds.
- Correct answer: 500 base points + 25 points per remaining whole second.
- Remaining whole seconds use `max(0, ceil((deadlineAt - serverReceivedAt) / 1000))` for both countdown and scoring.
- The server never sends `correctIndex` or the correct answer before the question closes. Scores are also applied only at question close, so the leaderboard cannot leak correctness early.
- Duplicate and late answers are rejected.
- Host migration is server-authoritative. A player is considered disconnected after missed polling heartbeats; the earliest-joined connected player becomes host. Host-generation checks reject commands from the previous host. Reconnection within 30 seconds restores the same room without pausing or extending the question deadline.
- Room creation, joining, and invalid room-code attempts are rate-limited per client IP.
- Completed matches are persisted as individual Blobs records and exposed through the history action.
- Host-created quizzes are validated server-side: 3–80 character title, exactly ten questions, 8–240 character question text, exactly four unique non-empty options of up to 100 characters, valid correct-answer index, and optional explanation up to 500 characters.

## Important operational notes

- Blobs are strongly consistent, but they are a key/value store rather than a relational database. This implementation stores one room per key and a separate record per completed match.
- The Netlify Function does not run timers in the background. The absolute server deadline is persisted; a player poll advances the question to reveal/next-question/finished state. If all players close their browsers, the room stops progressing until a player returns.
- The room state and answer keys are private to the function; client responses contain question text/options only until reveal.
- Netlify Blobs is provisioned automatically for deployed Functions. Local testing uses an in-memory fake store; it does not connect to production Blobs.
- No Netlify deployment has been performed from this environment. A real deployed two-browser smoke test is still required after the folder is dropped into your Netlify account.

## Development

Node.js 20.19+ is recommended for Vite 8. Install dependencies using your package manager, then run `npm run dev`. The UI calls the same `/.netlify/functions/game` path; use Netlify's local development environment to emulate Functions and Blobs. `npm test` runs the game-engine tests against a deterministic in-memory Blobs-compatible store.

## Build verification status for this archive

The game engine tests and the TypeScript function-entry smoke test were executed in the preparation environment. The npm registry could not be reached from that environment (`EAI_AGAIN registry.npmjs.org`), so Vite/React/Tailwind/Blobs packages could not be installed here. As a result, a Vite production build and Netlify's actual esbuild function bundle could not be executed locally. The included lockfile records the exact top-level versions, but its transitive package graph could not be materialized offline. Netlify's build environment must be able to reach npm and resolve/install the dependencies; treat the first deploy as a build verification step, not as an already-verified production artifact.
