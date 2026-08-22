# aiwars-mcp-downhill — Downhill Daredevils minigame referee

An AIWars minigame built on the shared **`aiwars-minigame`** library (tier 1:
turn-based), exactly like `MLWars/aiwars-poker`. The library owns everything that
isn't the rules — the env-driven bootstrap, the control REST API, the spectator
view server, the bearer-gated MCP gamepad, the scripted demo bot, and the
**Seat API** that lets a HUMAN occupy a seat and play. This repo supplies only the
Downhill rules (`src/downhill.rs`) and its spectator SPA (`view/`).

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

Downhill is **perfect information**: the slope report names the avalanche and ice
legs to everyone, so `Minigame::observe` ignores its `viewer` argument and sled and
spectator alike read the same projection.

## Layout
```
src/downhill.rs  # impl Minigame + TurnBasedGame for Downhill — the rules (+ unit tests)
src/lib.rs       # re-exports Downhill
src/main.rs      # fn main() { aiwars_minigame::run::run_turn_based::<Downhill>() }
view/            # offline spectator board (polls /state.json), no remote assets
game.toml        # the manifest: bin/name/category + [demo] enabled (the human-play gate)
Dockerfile       # generic referee image — builds game.toml's `bin`, bakes view/ → /srv/view
```

## Move vocabulary
`tuck:straight` (fast/reckless) · `carve:turn` (safe/steady) · `jump:shortcut`
(skips ahead/risky landing). Opaque move-strings, just like chess UCI.

## The two consoles
Both are library code, both authenticate the same way (`sha256(bearer)` → seat)
and both drive the same validation path:

- **Champions (MCP, port 9090)** — `get_state()` → `legal_moves()` →
  `make_move(mv, expected_ply)` → (`resign`).
- **Humans (Seat API, on the view port 8090)** — `GET /seat/schema`,
  `GET /seat/state[?wait_ms&since_ply]`, `POST /seat/move`, `POST /seat/resign`.
  Served only because `game.toml` declares `[demo] enabled = true`; the referee
  reads that from the `/game.toml` baked into its image at boot.

`GET /state.json` (anonymous) returns `{ game:"downhill", sleds:[…], leader, status,
winner, moves, … }` — the SPA renders it. The `game` key is injected by the
library, not by the game.

## Build / test
```bash
cargo build --locked
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```
`aiwars-minigame` is a git dep on the PRIVATE `AsafFisher/AIWars` repo; CI and the
Dockerfile authenticate with the `AIWARS_DEP_TOKEN` secret (a `git insteadOf`
rewrite). Locally, configure the same rewrite. **`Cargo.lock` is committed and
load-bearing** — an unlocked resolve floats `rmcp-macros` past the `rmcp` the
library pins and the build fails with `E0425`.

### Run the referee locally
```bash
export AIWARS_MATCH='{"settings":{"seed":7},"agents":[
  {"handle":"comet","token_hash":"<sha256 of the seat token>","kind":"human"},
  {"handle":"cruise","token_hash":"<sha256 of the seat token>","kind":"bot"}]}'
cargo run --release            # control 8080 · MCP 9090 · view 8090
curl -X POST localhost:8080/start
curl -H "Authorization: Bearer <seat token>" localhost:8090/seat/state
```

## Deploy
The World-Manager selects the referee image per match via
`WorldRequest.mcp_image` (or the `MCP_IMAGE` env) — point a Minigame world at the
`mcp:downhill` tag and it runs, no world-manager change needed. The site reads
`[demo] enabled` from an **OCI label on the published image**, so a change here
only reaches players once the image is rebuilt and republished.
