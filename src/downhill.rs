//! Downhill Daredevils — a turn-based alpine sled race, refereed on the shared
//! `aiwars-minigame` library (tier 1: `Minigame` + `TurnBasedGame`).
//!
//! Two sleds bomb DOWN a seeded snowy slope toward a checkered finish. On each of
//! its turns an agent picks a LINE from its legal moves:
//!
//! - `tuck:straight` — the fall line: fast but reckless (trees/ice/avalanche can wipe you
//!   out → crash, lose ground).
//! - `carve:turn` — the clean, steady, controlled line (safe, low crash).
//! - `jump:shortcut` — skips ahead the most, but risks a bad landing.
//!
//! A WIPEOUT knocks the sled back down the mountain. Reach the finish
//! (`progress ≥ GOAL`) to win. A HIDDEN SEEDED TWIST buries one branch under an
//! AVALANCHE on one leg and lurks an ICE PATCH on another, so two identical
//! doctrines don't always resolve the same way. At the leg cap, the sled furthest
//! down the mountain wins (cleaner run breaks a progress tie; a true tie is a draw).
//!
//! This is the engine-side rules ONLY — the agent's PUBLIC PROMPT (its doctrine)
//! is what chooses which legal line it plays each turn, via `make_move`. Same
//! seed ⇒ identical line options (deterministic / replayable).
//!
//! Downhill is **perfect information**: there is nothing a sled knows that the
//! spectator does not — the avalanche/ice legs are reported on the slope report both
//! see — so [`Minigame::observe`] ignores its `viewer` argument and returns the one
//! public projection to everyone.

use serde_json::{json, Value};

use aiwars_minigame::{AgentId, MatchError, Minigame, Outcome, TurnBasedGame};

const GOAL: u32 = 100;
const LEGS: u32 = 8;
/// Exactly two sleds run a course.
const PLAYERS: usize = 2;

/// A line option available at a given leg.
struct Line {
    name: &'static str,
    lane: u8,
    gain: u32,
    /// Base crash chance, in basis points (0..10000) for integer determinism.
    crash_bp: u32,
    kind: Kind,
}
#[derive(PartialEq, Clone, Copy)]
enum Kind {
    Tuck,
    Carve,
    Jump,
}

/// Deterministic per-leg PRNG seed mix (mulberry32-ish), matching the getaway
/// referee's idiom so the web demo and the referee agree on a seed's layout.
fn rng_u32(mut a: u32) -> u32 {
    a = a.wrapping_add(0x6d2b79f5);
    let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
    t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
    t ^ (t >> 14)
}
/// A 0..1 float from a (seed, leg, salt) tuple.
fn frac(seed: u64, leg: u32, salt: u32) -> f64 {
    let mixed = (seed as u32)
        .wrapping_mul(977)
        .wrapping_add(leg.wrapping_mul(131))
        .wrapping_add(salt.wrapping_mul(7));
    (rng_u32(mixed) as f64) / (u32::MAX as f64)
}

/// Per-sled state.
#[derive(Clone)]
struct Sled {
    prog: u32,
    leg: u32,
    lane: u8,
    crashes: u32,
    last_crash: bool,
    done: bool,
}
impl Sled {
    fn new(lane: u8) -> Self {
        Self {
            prog: 0,
            leg: 0,
            lane,
            crashes: 0,
            last_crash: false,
            done: false,
        }
    }
}

/// The two-player Downhill game.
pub struct Downhill {
    /// The sleds by IDENTITY, in seat order. The library bridges an auth-resolved seat to
    /// its `AgentId` before calling us, so the game never handles seat indices from outside.
    players: Vec<AgentId>,
    sleds: [Sled; PLAYERS],
    to_move: usize,
    ply: u32,
    seed: u64,
    /// HIDDEN SEEDED TWIST: the avalanche buries one branch on `av_leg`/`av_lane`;
    /// an ice patch lurks on `ice_leg`/`ice_lane`.
    av_leg: u32,
    av_lane: u8,
    ice_leg: u32,
    ice_lane: u8,
    resigned_by: Option<usize>,
    /// Cached terminal result once resolved (so it's stable after the last move).
    winner_idx: Option<usize>,
    win_reason: &'static str,
    resolved: bool,
}

impl Downhill {
    /// The three line options for the current leg (seed-deterministic).
    fn lines(&self, leg: u32) -> [Line; 3] {
        let r = |salt: u32| frac(self.seed, leg, salt);
        [
            Line {
                name: "tuck:straight",
                lane: 1,
                gain: 17 + (r(1) * 5.0) as u32,
                crash_bp: 1000,
                kind: Kind::Tuck,
            },
            Line {
                name: "carve:turn",
                lane: 0,
                gain: 11 + (r(2) * 3.0) as u32,
                crash_bp: 200,
                kind: Kind::Carve,
            },
            Line {
                name: "jump:shortcut",
                lane: 2,
                gain: 22 + (r(3) * 6.0) as u32,
                crash_bp: 1800,
                kind: Kind::Jump,
            },
        ]
    }

    /// Hazard-aware crash chance (in basis points) + cause for a chosen line on
    /// a leg. Mirrors the POC's hazard resolution.
    fn crash_for(&self, leg: u32, line: &Line) -> (u32, Option<&'static str>) {
        let avalanche = leg == self.av_leg;
        let ice = leg == self.ice_leg;
        let mut crash_bp = line.crash_bp;
        let mut cause: Option<&'static str> = None;
        if avalanche && line.lane == self.av_lane && line.kind != Kind::Carve {
            crash_bp = 9200;
            cause = Some("avalanche");
        } else if avalanche && line.lane == self.av_lane {
            crash_bp = 4500;
            cause = Some("avalanche");
        } else if ice && line.lane == self.ice_lane && line.kind == Kind::Tuck {
            crash_bp = crash_bp.max(5500);
            cause = Some("ice");
        } else if ice && line.lane == self.ice_lane && line.kind == Kind::Jump {
            crash_bp = crash_bp.max(4000);
            cause = Some("ice");
        }
        (crash_bp, cause)
    }

    /// The seat holding `agent`, or `None` for an id that never sat down.
    fn seat_of(&self, agent: &AgentId) -> Option<usize> {
        self.players.iter().position(|p| p == agent)
    }

    /// The current leader's seat by progress (None if tied).
    fn leader(&self) -> Option<usize> {
        let (a, b) = (self.sleds[0].prog, self.sleds[1].prog);
        if a == b {
            None
        } else if a > b {
            Some(0)
        } else {
            Some(1)
        }
    }

    /// The standing order the leg cap settles by, and the ONLY thing a wall-clock timeout may
    /// be resolved on: furthest down the mountain, and — exactly as the cap does — a CLEANER
    /// run (fewer crashes) breaks a progress tie. `None` ⇒ level on both, which draws.
    ///
    /// Deliberately not [`Self::leader`]: that one is the view's "who is ahead" badge, raw
    /// road position only. A timeout settled on it would draw races the cap would decide.
    fn standing(&self) -> Option<usize> {
        let (a, b) = (&self.sleds[0], &self.sleds[1]);
        if a.prog != b.prog {
            return Some(if a.prog > b.prog { 0 } else { 1 });
        }
        if a.crashes != b.crashes {
            return Some(if a.crashes < b.crashes { 0 } else { 1 });
        }
        None
    }

    /// Advance `to_move` to the next sled still in the race (skipping finished).
    fn advance_turn(&mut self) {
        let other = 1 - self.to_move;
        if !self.sleds[other].done {
            self.to_move = other;
        }
        // else: keep to_move on the still-running sled to take its remaining turns.
    }

    /// Resolve the match if a terminal condition is met (idempotent).
    fn try_resolve(&mut self) {
        if self.resolved {
            return;
        }
        if let Some(r) = self.resigned_by {
            self.winner_idx = Some(1 - r);
            self.win_reason = "resign";
            self.resolved = true;
            return;
        }
        let (s0, s1) = (&self.sleds[0], &self.sleds[1]);
        // Crossing the finish wins immediately.
        let f0 = s0.done && s0.prog >= GOAL;
        let f1 = s1.done && s1.prog >= GOAL;
        if f0 && !f1 {
            self.winner_idx = Some(0);
            self.win_reason = "finish";
            self.resolved = true;
            return;
        }
        if f1 && !f0 {
            self.winner_idx = Some(1);
            self.win_reason = "finish";
            self.resolved = true;
            return;
        }
        // No finisher yet: keep running until both sleds have run every leg.
        let cap = s0.leg >= LEGS && s1.leg >= LEGS;
        if cap {
            // Furthest down wins; a progress tie goes to the cleaner run, else it is a draw —
            // read off the ONE standing order, which `timeout_leader` reports mid-run.
            let level = s0.prog == s1.prog;
            self.winner_idx = self.standing();
            self.win_reason = match self.winner_idx {
                None => "draw",
                Some(_) if level => "cleaner",
                Some(_) => "closer",
            };
            self.resolved = true;
        }
    }

    fn status_str(&self) -> &'static str {
        if self.resigned_by.is_some() {
            "resigned"
        } else if self.resolved {
            self.win_reason
        } else {
            "playing"
        }
    }
}

impl Minigame for Downhill {
    fn new(agents: &[AgentId], settings: &Value) -> Result<Self, MatchError> {
        if agents.len() != PLAYERS {
            return Err(MatchError::WrongPlayerCount {
                want: 2..=2,
                got: agents.len(),
            });
        }
        // Optional fixed seed for reproducible matches; default from settings or 1.
        let seed = settings.get("seed").and_then(|v| v.as_u64()).unwrap_or(1);
        // Hidden twist: the avalanche leg/lane and a distinct ice leg/lane.
        let av_leg = 1 + (frac(seed, 0, 99) * (LEGS as f64 - 2.0)) as u32;
        let av_lane = (frac(seed, 0, 100) * 3.0) as u8 % 3;
        let mut ice_leg = 1 + (frac(seed, 0, 101) * (LEGS as f64 - 2.0)) as u32;
        if ice_leg == av_leg {
            ice_leg = (ice_leg % (LEGS - 2)) + 1;
        }
        let ice_lane = (frac(seed, 0, 102) * 3.0) as u8 % 3;
        Ok(Self {
            players: agents.to_vec(),
            sleds: [Sled::new(0), Sled::new(2)],
            to_move: 0,
            ply: 0,
            seed,
            av_leg,
            av_lane,
            ice_leg,
            ice_lane,
            resigned_by: None,
            winner_idx: None,
            win_reason: "playing",
            resolved: false,
        })
    }

    fn name(&self) -> &'static str {
        "downhill"
    }

    fn instructions(&self) -> String {
        "AIWars Downhill Daredevils. Two sleds bomb DOWN a seeded alpine slope toward a \
         checkered finish; the first to the bottom (progress 100) wins. Read the state each \
         turn: `sleds` (yours carries your handle) has `progress`, `to_finish`, `leg`, `lane`, \
         `crashes`, `last_crash` and the `slope` report for the leg you are about to ride \
         (\"groomed\", \"ice reported\" or \"AVALANCHE warning\"), and `moves` lists your EXACT \
         legal lines. Ride one with make_move, mv = one of: \"tuck:straight\" — the fall line, \
         fastest but reckless, and trees/ice/a buried branch can wipe you out and knock you back \
         UP the mountain; \"carve:turn\" — the clean, steady, controlled line that almost never \
         crashes; \"jump:shortcut\" — the biggest ground gained, at the worst odds of a bad \
         landing. Pass expected_ply = the ply you saw. A hidden seeded twist buries one lane \
         under an AVALANCHE on one leg and lurks an ICE PATCH on another, so the slope report \
         is worth reading before you commit. If neither sled reaches the finish within 8 legs, \
         the sled furthest down the mountain wins (a cleaner run breaks a progress tie; a true \
         tie is a draw). resign pulls off the course and awards the run to your rival. Your seat \
         is your bearer token; you cannot act as your rival."
            .into()
    }

    /// Downhill is PERFECT INFORMATION — a sled knows nothing a spectator doesn't — so
    /// `viewer` is deliberately ignored and everyone gets the same projection. (The library
    /// injects the `"game"` key, so it is not set here.)
    fn observe(&self, _viewer: Option<&AgentId>) -> Value {
        let h = |i: usize| self.players[i].0.clone();
        let leading = self
            .leader()
            .map(h)
            .map(Value::String)
            .unwrap_or(Value::Null);
        let winner = self
            .winner_idx
            .filter(|_| self.resolved)
            .map(h)
            .map(Value::String)
            .unwrap_or(Value::Null);
        // Slope report for the leg each sled is about to ride (avalanche/ice/groomed).
        let slope_for = |i: usize| -> &'static str {
            let leg = self.sleds[i].leg;
            if leg == self.av_leg {
                "AVALANCHE warning"
            } else if leg == self.ice_leg {
                "ice reported"
            } else {
                "groomed"
            }
        };
        let sled_json = |i: usize| {
            let s = &self.sleds[i];
            json!({
                "handle": h(i),
                "progress": s.prog,
                "to_finish": GOAL.saturating_sub(s.prog),
                "leg": s.leg,
                "lane": s.lane,
                "crashes": s.crashes,
                "last_crash": s.last_crash,
                "done": s.done,
                "finished": s.done && s.prog >= GOAL,
                "slope": slope_for(i),
            })
        };
        json!({
            "goal": GOAL,
            "legs": LEGS,
            "seed": self.seed,
            "to_move": h(self.to_move),
            "to_move_idx": self.to_move,
            "leader": leading,
            "ply": self.ply,
            "status": self.status_str(),
            "winner": winner,
            "win_reason": if self.resolved { self.win_reason } else { "" },
            "moves": self.legal_moves(),
            "sleds": [sled_json(0), sled_json(1)],
        })
    }

    fn outcome(&self) -> Option<Outcome> {
        if !self.resolved {
            return None;
        }
        Some(match self.winner_idx {
            Some(i) => Outcome::Win(self.players[i].clone()),
            None => Outcome::Draw,
        })
    }

    /// The wall-clock timeout tiebreak: whoever the leg cap would crown right now — furthest
    /// down the mountain, with a CLEANER run breaking a progress tie. Level on both ⇒ `None`
    /// ⇒ a timeout draws.
    fn timeout_leader(&self) -> Option<AgentId> {
        self.standing().map(|i| self.players[i].clone())
    }
}

impl TurnBasedGame for Downhill {
    fn turn_agent(&self) -> AgentId {
        self.players[self.to_move].clone()
    }

    fn ply(&self) -> u32 {
        self.ply
    }

    fn legal_moves(&self) -> Vec<String> {
        if self.resolved {
            return Vec::new();
        }
        let leg = self.sleds[self.to_move].leg;
        self.lines(leg).iter().map(|l| l.name.to_string()).collect()
    }

    fn apply(&mut self, agent: &AgentId, mv: &str) -> Result<(), MatchError> {
        if self.resolved {
            return Err(MatchError::GameOver);
        }
        let seat = self
            .seat_of(agent)
            .ok_or_else(|| MatchError::Rejected("not a sled in this race".into()))?;
        // Defensive: `TurnBasedMatch` already polices turn order (`TurnError::NotYourTurn`)
        // and the ply, but keep the game honest if it is ever driven directly.
        if self.to_move != seat {
            return Err(MatchError::Rejected("not your turn".into()));
        }
        let leg = self.sleds[seat].leg;
        let lines = self.lines(leg);
        let idx = lines
            .iter()
            .position(|l| l.name == mv)
            .ok_or_else(|| MatchError::Rejected(format!("'{mv}' is not a line here")))?;

        // --- committed, mutating path (validation has passed) ---
        // Copy out the chosen line's fields before borrowing `self.sleds` mutably.
        let lane = lines[idx].lane;
        let gain = lines[idx].gain;
        let (crash_bp, _cause) = self.crash_for(leg, &lines[idx]);

        // Resolve the crash deterministically from (seed, leg, agent, ply).
        let roll = frac(self.seed, leg, 53 + (seat as u32 + 1) * 9 + self.ply * 3);
        let crashed = (roll * 10000.0) < crash_bp as f64;

        let s = &mut self.sleds[seat];
        s.last_crash = crashed;
        if crashed {
            s.crashes += 1;
            // knocked back down the mountain (bounded by current progress).
            let back = (7 + (roll * 6.0) as u32).min(s.prog);
            s.prog = s.prog.saturating_sub(back);
        } else {
            s.prog = (s.prog + gain).min(GOAL);
        }
        s.lane = lane;
        s.leg += 1;
        if s.prog >= GOAL {
            s.done = true;
        } else if s.leg >= LEGS {
            // ran out of legs without finishing.
            s.done = true;
        }

        self.ply += 1;
        self.advance_turn();
        self.try_resolve();
        Ok(())
    }

    fn resign(&mut self, agent: &AgentId) {
        if self.resolved {
            return;
        }
        if let Some(seat) = self.seat_of(agent) {
            self.resigned_by = Some(seat);
            self.try_resolve();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiwars_minigame::{RefereeMatch, TurnBasedMatch, TurnError};
    use serde_json::json;

    fn sleds() -> Vec<AgentId> {
        vec![AgentId("comet".into()), AgentId("cruise".into())]
    }

    /// A started two-seat match on a fixed seed.
    fn started(seed: u64) -> TurnBasedMatch {
        let mut m = TurnBasedMatch::new::<Downhill>(sleds(), &json!({ "seed": seed })).unwrap();
        m.start();
        m
    }

    /// Drive a whole run the way a client does: read `to_move_idx`/`ply`, play the first legal
    /// line. It must resolve within the leg cap.
    fn play_out(m: &mut TurnBasedMatch) {
        let mut guard = 0;
        while !m.is_resolved() && guard < 64 {
            let seat = m.state_json()["to_move_idx"].as_u64().unwrap() as usize;
            let ply = m.state_json()["ply"].as_u64().unwrap() as u32;
            let mv = m.turn_info(seat)["moves"][0].as_str().unwrap().to_string();
            m.make_move(seat, &mv, ply)
                .unwrap_or_else(|e| panic!("seat {seat} playing {mv} at ply {ply}: {e}"));
            guard += 1;
        }
    }

    #[test]
    fn rejects_wrong_player_count() {
        for n in [1usize, 3] {
            let ids: Vec<AgentId> = (0..n).map(|i| AgentId(format!("p{i}"))).collect();
            match Downhill::new(&ids, &json!({})) {
                Err(MatchError::WrongPlayerCount { want, got }) => {
                    assert_eq!(want, 2..=2);
                    assert_eq!(got, n);
                }
                Err(e) => panic!("expected WrongPlayerCount for {n} players, got {e}"),
                Ok(_) => panic!("expected WrongPlayerCount for {n} players, got a built game"),
            }
        }
    }

    #[test]
    fn first_move_advances_ply_and_passes_turn() {
        let mut m = started(7);
        assert_eq!(m.state_json()["ply"], 0);
        assert_eq!(m.state_json()["to_move_idx"], 0);
        assert_eq!(
            m.turn_info(0)["moves"].as_array().unwrap().len(),
            3,
            "three lines at each leg"
        );
        let st = m.make_move(0, "carve:turn", 0).unwrap();
        assert_eq!(st["ply"], 1);
        assert_eq!(st["to_move_idx"], 1, "turn passes to the rival");
        // carve is the safe line (2% base, no hazard on leg 0) → progress made.
        assert!(st["sleds"][0]["progress"].as_u64().unwrap() > 0);
        assert_eq!(st["sleds"][0]["leg"], 1);
    }

    /// The library injects the `game` key the spectator SPA dispatches on — the game itself
    /// must not (and no longer does) set it.
    #[test]
    fn public_state_carries_the_library_injected_game_key() {
        let m = started(7);
        assert_eq!(m.state_json()["game"], "downhill");
        assert!(
            !Downhill::new(&sleds(), &json!({}))
                .unwrap()
                .observe(None)
                .as_object()
                .unwrap()
                .contains_key("game"),
            "the game must not set `game` itself — the library owns that key"
        );
    }

    /// The turn-order policing this port handed to the library: a move by the WRONG agent is
    /// refused with `TurnError::NotYourTurn`, and nothing changes.
    #[test]
    fn move_by_the_wrong_agent_is_refused() {
        let mut m = started(7);
        let before = m.state_json();
        assert_eq!(
            m.make_move(1, "tuck:straight", 0).unwrap_err(),
            TurnError::NotYourTurn
        );
        assert_eq!(
            m.state_json(),
            before,
            "no state change on an out-of-turn move"
        );
    }

    /// The game's OWN defensive check, driven directly (no match wrapper): an illegal mover is
    /// `Rejected` now that `MatchError::NotYourTurn` is gone.
    #[test]
    fn game_driven_directly_also_refuses_the_wrong_agent() {
        let mut g = Downhill::new(&sleds(), &json!({ "seed": 7 })).unwrap();
        assert!(matches!(
            g.apply(&AgentId("cruise".into()), "tuck:straight"),
            Err(MatchError::Rejected(_))
        ));
        assert!(matches!(
            g.apply(&AgentId("nobody".into()), "tuck:straight"),
            Err(MatchError::Rejected(_))
        ));
        assert_eq!(g.ply(), 0);
    }

    #[test]
    fn illegal_line_rejected_without_change() {
        let mut m = started(7);
        let before = m.state_json();
        match m.make_move(0, "skate:flat", 0).unwrap_err() {
            TurnError::Core(MatchError::Rejected(msg)) => assert!(msg.contains("skate:flat")),
            other => panic!("expected Rejected, got {other:?}"),
        }
        assert_eq!(m.state_json(), before, "no state change on a rejected move");
    }

    #[test]
    fn stale_ply_rejected() {
        let mut m = started(7);
        assert_eq!(
            m.make_move(0, "tuck:straight", 9).unwrap_err(),
            TurnError::StalePly
        );
    }

    /// Both sleds always take the first legal line. The seed is fixed, so the run is fixed:
    /// assert the EXACT result. (`outcome` is only ever "Winner" or "Draw", so asserting that
    /// disjunction proves nothing — it holds with the whole cap rule inverted.)
    #[test]
    fn a_full_run_is_settled_by_who_is_furthest_down() {
        let mut m = started(7);
        play_out(&mut m);
        assert!(m.is_resolved(), "match must resolve within the leg cap");
        let result = m.result().expect("resolved match has a result");
        assert_eq!(result.outcome, "Winner");
        assert_eq!(result.winner.as_deref(), Some("cruise"));
        let st = m.state_json();
        assert_eq!(st["win_reason"], "closer");
        assert!(
            st["sleds"][1]["progress"].as_u64() > st["sleds"][0]["progress"].as_u64(),
            "the winner is the sled further down the mountain"
        );
        assert!(st["moves"].as_array().unwrap().is_empty());
    }

    /// Crossing the finish WINS immediately — the game's primary terminal path, which the
    /// scripted run above (settled at the leg cap) never reaches. Without this the whole
    /// finish rule could be deleted with every test still green.
    #[test]
    fn crossing_the_finish_wins_the_run_outright() {
        let mut g = Downhill::new(&sleds(), &json!({ "seed": 7 })).unwrap();
        // One clean line from the bottom of the mountain takes seat 0 over the line.
        g.sleds[0].prog = GOAL - 1;
        g.apply(&AgentId("comet".into()), "carve:turn").unwrap();
        assert_eq!(g.sleds[0].prog, GOAL, "progress is capped at the finish");
        assert!(g.sleds[0].done, "and the sled is out of the race");
        assert_eq!(
            g.win_reason, "finish",
            "the finish ends it, not the leg cap"
        );
        assert_eq!(g.outcome(), Some(Outcome::Win(AgentId("comet".into()))));
    }

    /// The cap's OTHER rule, which no full run above reaches: level on progress, the CLEANER
    /// run (fewer crashes) takes it — and a wall-clock timeout settles the same way, so a
    /// timeout can never draw a race the cap would decide.
    #[test]
    fn a_progress_tie_goes_to_the_cleaner_run() {
        let mut g = Downhill::new(&sleds(), &json!({ "seed": 7 })).unwrap();
        g.sleds[0].prog = 60;
        g.sleds[0].crashes = 3;
        g.sleds[0].leg = LEGS;
        g.sleds[1].prog = 60;
        g.sleds[1].crashes = 1;
        g.sleds[1].leg = LEGS;
        assert_eq!(
            g.timeout_leader(),
            Some(AgentId("cruise".into())),
            "level on the mountain, the cleaner run leads"
        );
        g.try_resolve();
        assert_eq!(g.win_reason, "cleaner");
        assert_eq!(g.outcome(), Some(Outcome::Win(AgentId("cruise".into()))));

        // Level on BOTH is the genuine tie: a draw, and nobody leads a timeout.
        let mut g = Downhill::new(&sleds(), &json!({ "seed": 7 })).unwrap();
        g.sleds[0].prog = 60;
        g.sleds[1].prog = 60;
        g.sleds[0].leg = LEGS;
        g.sleds[1].leg = LEGS;
        assert_eq!(g.timeout_leader(), None);
        g.try_resolve();
        assert_eq!(g.win_reason, "draw");
        assert_eq!(g.outcome(), Some(Outcome::Draw));
    }

    #[test]
    fn resign_awards_opponent() {
        let mut m = started(3);
        let st = m.resign(0);
        assert_eq!(st["status"], "resigned");
        assert!(m.is_resolved());
        let result = m.result().unwrap();
        assert_eq!(result.outcome, "Winner");
        assert_eq!(result.winner.as_deref(), Some("cruise"));
    }

    #[test]
    fn outcome_names_the_winner_by_identity() {
        let mut g = Downhill::new(&sleds(), &json!({ "seed": 3 })).unwrap();
        assert_eq!(g.outcome(), None);
        g.resign(&AgentId("comet".into()));
        assert_eq!(g.outcome(), Some(Outcome::Win(AgentId("cruise".into()))));
    }

    #[test]
    fn timeout_leader_is_whoever_is_furthest_down_the_mountain() {
        let mut g = Downhill::new(&sleds(), &json!({ "seed": 7 })).unwrap();
        assert_eq!(g.timeout_leader(), None, "dead level at the start");
        g.apply(&AgentId("comet".into()), "carve:turn").unwrap();
        assert_eq!(g.timeout_leader(), Some(AgentId("comet".into())));
    }

    #[test]
    fn same_seed_same_lines() {
        let a = started(42);
        let b = started(42);
        assert_eq!(a.state_json()["moves"], b.state_json()["moves"]);
    }

    #[test]
    fn same_seed_same_full_game() {
        // Determinism across a whole game, not just the opening line set.
        let play = |seed: u64| -> Value {
            let mut m = started(seed);
            play_out(&mut m);
            m.state_json()
        };
        assert_eq!(play(42), play(42), "same seed ⇒ identical final state");
    }

    /// The whole point of the port: the seat payload a HUMAN's browser reads carries its turn
    /// info (`your_turn` + `moves`) alongside the private projection.
    #[test]
    fn seat_state_carries_turn_info_for_a_human_console() {
        let m = started(7);
        let s = m.seat_state(0);
        assert_eq!(s["you"]["handle"], "comet");
        assert_eq!(s["turn"]["your_turn"], true);
        assert_eq!(s["turn"]["moves"].as_array().unwrap().len(), 3);
        assert_eq!(s["state"]["to_move"], "comet");
        assert_eq!(m.seat_state(1)["turn"]["your_turn"], false);
    }

    /// The shipped game.toml must parse and its hold must validate — green CI implies a
    /// bootable manifest (a typo in `[settings]` would otherwise crashloop every pod).
    #[test]
    fn game_toml_is_loadable() {
        let settings = aiwars_minigame::settings::manifest_settings_at("game.toml").unwrap();
        aiwars_minigame::settings::validate_hold(&settings).unwrap();
    }
}
