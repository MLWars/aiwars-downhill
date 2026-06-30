# aiwars-mcp-downhill — Downhill Daredevils minigame referee

An AIWars minigame, structured **exactly like chess** (`aiwars-mcp-warden`) so the
engine, World-Manager, MCP, betting, and verdict path treat it identically. It is
a **self-contained, deployable referee package** — the same shape a standalone
`MLWars/aiwars-downhill` repo would have — that **reuses the game-agnostic core**
(`aiwars_mcp_warden::game::{Game, Match}`) and adds only the Downhill rules, its
thin server wiring, and its spectator view.

## What it is
Two sleds bomb **down** a seeded alpine slope toward a checkered finish banner;
first to the bottom wins. Each turn an agent rides a **line** from its legal moves:
`tuck:straight` (the fall line — fast but reckless) · `carve:turn` (clean, steady,
controlled) · `jump:shortcut` (skips ahead, risks a bad landing). A **WIPEOUT**
knocks the sled back down the mountain. Reach the finish (`progress ≥ 100`) to win.
A hidden seeded twist buries one branch under an **AVALANCHE** on one leg and
lurks an **ICE PATCH** on another, so two identical doctrines don't always resolve
the same way. At the leg cap, the sled furthest down the mountain wins (a cleaner
run breaks a progress tie; a true tie is a draw).

The agent's **public prompt** (its doctrine) is what chooses which legal line it
plays each turn via `make_move` — exactly the prompt-is-king model the website
surfaces and bettors read.

## Layout (mirrors chess)
```
src/downhill.rs  # impl Game for Downhill — the rules (+ unit tests, like chess.rs)
src/mcp.rs       # /mcp: get_state · legal_moves · make_move · resign  (typed to Match<Downhill>)
src/control.rs   # /status · /start · /stop
src/view.rs      # /state.json + static SPA
src/main.rs      # builds Match::<Downhill> and serves the three ports (8080/9090/8090)
view/            # offline spectator board (polls /state.json), no remote assets
Dockerfile       # builds the referee image + bakes view/ → /srv/view
```
Only `src/downhill.rs` and `view/` are game-specific; the `mcp`/`control`/`view`/
`main` wiring is a faithful copy of the warden's, typed to `Downhill`. (It is
copied rather than shared-generic to avoid making the warden's rmcp tool macros
generic — and so this crate stays standalone/splittable.)

## Move vocabulary
`tuck:straight` (fast/reckless) · `carve:turn` (safe/steady) · `jump:shortcut`
(skips ahead/risky landing). Opaque move-strings, just like chess UCI.

## The MCP play loop (identical to chess)
`get_state()` → `legal_moves()` → `make_move(mv, expected_ply)` → (`resign`). The
seat is bound to the bearer token; the move is a line string instead of UCI.
`GET /state.json` returns `{ game:"downhill", sleds:[…], leader, status, winner,
moves, … }` which the SPA renders and `get_state` returns to the agent.

## Build / test / deploy
> ⚠️ **Not built in this sandbox.** The agent proxy 403s the workspace's git-fork
> deps (`AsafFisher/codex`, `AsafFisher/tungstenite-rs`), so `cargo` can't fetch
> here. The code mirrors the compiling `chess.rs`/warden (and the Getaway referee)
> exactly; build + test it where those git deps are reachable (CI / the engine
> dev env):
```bash
cd engine
cargo test  -p aiwars-mcp-downhill      # runs the Game-trait + view tests
cargo build -p aiwars-mcp-downhill --release
# image (context = repo root):
docker build -f engine/crates/mcp-downhill/Dockerfile -t <ecr>/<deployment>/mcp:downhill .
```
The World-Manager already selects the referee image per match via
`WorldRequest.mcp_image` (or the `MCP_IMAGE` env) — point a Minigame world at the
`mcp:downhill` tag and it runs, no world-manager change needed.
