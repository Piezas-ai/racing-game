# 🏁 Vancouver Road Simulator

*by Jasper, Skyler, Dad and Fable*

A Mario Kart-style online racing game for up to **10 players** (plus up to
**20 AI robot racers**). Create a game, share a 5-digit code, and race 3 laps
on a procedurally generated track full of lucky blocks, spikes, snapping traps,
oil slicks, rockets — and a jump scare you can fire at your opponents.

The game is a [Piezas](https://api.piezas.ai)-backed sample app: the frontend
is Vite + React rendering on a `<canvas>`, the server is a small Node process
(Express + WebSocket), and **all durable data lives in Piezas** — accounts and
sessions in the Users service, player stats/wallets/pets and race history in
Entity Records. There is no local database.

## Quick start

```bash
npm install
npx piezas init --key <your-api-key>   # writes .env with PIEZAS_API_KEY
npm run dev
```

Then open **http://localhost:5173**, register a racer (username + password —
no email needed), and hit **Create Game**. Share the 5-digit code (or the
`/game/<code>` URL) with friends on the same network/internet, or open a
second browser tab and join your own code to try multiplayer solo.

`npm run dev` runs two processes:

- **server** — the game server on `:8787` (API + WebSocket), restarts on change
- **client** — Vite dev server on `:5173`, proxying `/api` and `/ws` to `:8787`

## Environment variables

All configuration lives in `.env` at the project root (server-side only —
nothing here is ever shipped to the browser):

| Variable | Required | What it is |
|---|---|---|
| `PIEZAS_API_KEY` | yes | Your Piezas API key (`sk_live_...` / `sk_test_...`). Written by `npx piezas init --key <key>`, or download the `.env` from the Piezas dashboard and drop it in the project root. |
| `PIEZAS_API_URL` | no | Piezas gateway base URL. Defaults to `https://api.piezas.ai`. |

The server refuses to boot without `PIEZAS_API_KEY`. Never expose it in client
code or prefix it with `VITE_`. There is no `SESSION_SECRET` — sessions are
platform tokens issued and verified by the Piezas Users service.

On first boot the server sets everything up idempotently: the per-app auth
policy in the Users service, and the `player` / `race` entity schemas.

## What this game is

- **Racing**: 3 laps, up to 10 humans per race, deterministic tracks generated
  from a shared seed so every client renders the identical course.
- **Difficulty levels 1–5**: level 1 is a giant circle with wide lanes;
  level 5 is a narrow, twisty gauntlet crawling with hazards.
- **Biomes**: 🌴 jungle (muddy shoulders), ❄️ snow (drifty ice), 🏜️ desert,
  🌋 volcano (lava is *very* punishing).
- **AI robots**: the host can add 0–20 bots (easy / medium / hard / surprise
  mix). Beating a pack of robots earns real points and a W even in an
  otherwise solo race.
- **Persistent progression**: wins, losses, best lap, points, ammo, armor,
  cars, colors and pets are saved to your account and survive restarts.
- **Camera**: Mario Kart-style pseudo-3D chase camera over a 2D simulation.
- All sound effects are generated with WebAudio — no binary assets. The jump
  scare is cartoon-spooky, not gore.

## How to play

### Getting into a race

1. **Register / sign in** — username (3–16 letters/numbers/underscores) and a
   password (6+ chars). No email required.
2. **Create Game** — pick a difficulty level and biome; you get a 5-digit code
   and a shareable `/game/<code>` URL. Waiting rooms last 30 minutes.
3. **Join** — friends open the URL or type the code in the lobby. The host can
   dial in AI robots, then hits **Start** for a 3-2-1-GO countdown.

### Controls

| Key | Action |
|---|---|
| ↑ / W | Accelerate |
| ↓ / S | Brake / reverse |
| ← → / A D | Steer |
| Space | Use held item (from lucky blocks) |
| F | Fire a bullet |
| B | Drop a road block |
| T | Place a turret |
| X | BOOM (once per race, first come first served) |
| H | Hypnotize (once per race per player) |

On iPad/phone: drag the on-screen pad (up = gas, down = brake, sideways =
steer) and tap the item/fire/block/turret/boom/hypno buttons. Steering and
throttle are fully analog.

### Items (from lucky blocks — hold one at a time, Space to use)

👻 Jump Scare (everyone else gets a fullscreen scare + scrambled steering) ·
👻👻 Double Jump Scare · 💨 Boost · 🛢️ Oil Slick · ⚡ Lightning (shrinks and
slows everyone else) · 🪩 DJ (disco-balls a random racer, 25% slower) ·
🚀 Rocket (homes in, spins out on impact) · 🪄 Steal · ⚔️ Sword (ram to slice) ·
🛡️ Shield (4 s bubble that blocks nearly everything)

### Economy & shop

Racing earns points ⭐ by placement (more at higher levels, +5 per landed hit).
Spend them in the lobby shop:

- **Ammo**: bullets 5 ⭐, road blocks 8 ⭐ (new players start with 30 bullets +
  10 blocks), bullet/block armor 15 ⭐ each — armor absorbs one hit of its type.
- **Big-ticket**: 🗼 Turret 300 ⭐, 💥 BOOM 400 ⭐ (sends everyone back to the
  start line), 🌀 Hypnotize 2000 ⭐ (everyone mirrors your driving for 6 s).
- **Pets** (buy once, equip one — it rides along beside your kart):
  🐶 Zoomie the Pup 500 ⭐ (+5% speed/accel), 🐢 Tank the Turtle 500 ⭐
  (recovers 35% faster from hits), 🐱 Magnet Cat 350 ⭐ (grabs lucky blocks
  from farther away).

### Garage

Pick a character color and a car class, shown to everyone on track:
🏎️ Blaze (+8% top speed) · 🚜 Boulder (recovers from hits 40% faster) ·
🏁 Drift King (sharper steering, grips on ice) · 🐞 Lucky Bug (starts every
race holding an item). Pet abilities stack multiplicatively with the car's.

## Project layout

```
client/          Vite + React frontend (canvas renderer, lobby, garage, shop)
server/          Express + ws game server
  index.ts       HTTP + WebSocket entry point
  auth.ts        register/login/logout via the Piezas Users service
  session.ts     platform session-token verification (60 s cache)
  piezas.ts      SDK init, entity schemas, stats/wallet/race persistence
  rooms.ts       in-memory race rooms + message relay (ephemeral)
shared/          code that runs on both client and server (track generation,
                 economy) — tracks are deterministic from the seed
deploy/          production bundle output (server.js + public/)
SPEC.md          the full product spec — the source of truth for game rules
piezas.manifest.json   deployment/ownership manifest
```

Design notes worth knowing: physics runs on each client and hits are decided
by the victim's own client (no anti-cheat — a documented non-goal); the server
enforces ammo, points, BOOM/hypno limits, and banks results at race end. The
host's client simulates the robots, so if the host quits mid-race the bots
freeze.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev servers (client `:5173` + game server `:8787`) |
| `npm run build` | Build client + bundle server into `deploy/` |
| `npm start` | Run the production bundle (`deploy/server.js`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npx piezas doctor` | Validate the Piezas setup (must pass before deploy) |

## Deployment

The app deploys to Piezas hosting as `racing-game-7725`
(https://racing-game-7725.apps.piezas.ai):

```bash
npm run build
npx piezas doctor
npx piezas deploy --dir deploy
```

`PIEZAS_API_KEY` is provisioned automatically in the hosted environment; no
other env vars are required (`deploy.requiredEnv` is empty).
