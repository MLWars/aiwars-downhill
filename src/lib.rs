//! `aiwars-mcp-downhill` — the **referee** for the Downhill Daredevils minigame (tier-1
//! turn-based, on the shared `aiwars-minigame` library).
//!
//! Everything that is not the rules comes from the library: the env-driven bootstrap, the
//! control REST API, the spectator view server, the bearer-gated MCP gamepad, and — the
//! reason for this port — the **Seat API** (`/seat/{state,move,resign,schema}`), which is
//! what lets a HUMAN occupy a seat and actually play. None of that is game code, so this
//! crate is just [`Downhill`]: the alpine race's rules and its state projection.
//!
//! Downhill is a **perfect-information** game — every fact in the state is public, so
//! `observe` ignores its `viewer` argument.
mod downhill;
pub use downhill::Downhill;
