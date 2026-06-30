/* Downhill Daredevils — an isometric alpine sled race. Two sleds bomb DOWN a
 * seeded snowy slope toward a checkered finish banner; first to the bottom wins.
 *
 * Their PUBLIC PROMPT is a riding doctrine. Each turn the agent reads the run
 * (get_state), sees its legal lines (legal_moves: tuck:straight / carve:turn /
 * jump:shortcut), and commits one (make_move). TUCK is fastest but reckless —
 * trees, ice and a buried branch can wipe you out (knocked back). CARVE is the
 * clean, steady, controlled line. JUMP skips ahead but risks a bad landing.
 *
 * Champions: COMET (A, green) is the send-it bomber; CRUISE (B, violet) is the
 * clean carver. The hazard avalanche is the mountain's, not a racer's name.
 *
 * HIDDEN SEEDED TWIST: a churning AVALANCHE buries ONE branch on one leg, and an
 * ICE PATCH lurks on another — both seeded — so two identical doctrines don't
 * always resolve the same way. A crash costs time; first to progress>=GOAL wins.
 *
 * Faithful to the engine Game-trait model: turn-based, opaque move-strings, the
 * agent plays via get_state -> legal_moves -> make_move(mv, ply). The prompt
 * decides which legal line it picks each turn.
 */
(function () {
  const A = window.AW;
  const W = 780, H = 560;
  const GOAL = 100, LEGS = 8;

  // Three iso lanes across the slope: 0=left(carver's clean line) 1=center 2=right.
  const LANE_X = [W * 0.30, W * 0.50, W * 0.70];
  // The slope scrolls UPWARD as sleds descend: leg 0 near top (far), goal at bottom.
  const legY = (leg) => 120 + leg * ((H - 230) / LEGS);
  const wp = (leg, lane, seed) => {
    const r = A.rng(seed * 131 + leg * 17 + lane * 7);
    // perspective: lanes spread wider toward the bottom (closer to camera)
    const spread = 0.62 + (leg / LEGS) * 0.6;
    const cx = W * 0.5 + (LANE_X[lane] - W * 0.5) * spread;
    return { x: cx + (r() - 0.5) * 40, y: legY(leg) + (r() - 0.5) * 12 };
  };
  const FINISH = { x: W * 0.5, y: H - 86 };

  // ---- doctrine: parse the public prompt into a riding policy ---------------
  const KW = {
    bomb: ["fast", "reckless", "tuck", "send", "risk", "risky", "bomb", "straight", "aggressive", "charge", "full", "gas", "huck", "fearless", "attack", "speed"],
    carve: ["safe", "clean", "carve", "careful", "control", "controlled", "steady", "smooth", "patient", "cautious", "edge", "measured", "precise", "calm"],
  };
  function doctrine(prompt) {
    const p = (prompt || "").toLowerCase();
    let b = 0, c = 0;
    for (const k of KW.bomb) if (p.includes(k)) b++;
    for (const k of KW.carve) if (p.includes(k)) c++;
    if (b === 0 && c === 0) return { kind: "balanced", tag: "all-mountain", risk: 0.5 };
    if (b > c) return { kind: "bomber", tag: "send-it bomber", risk: 0.85 };
    if (c > b) return { kind: "carver", tag: "clean carver", risk: 0.18 };
    return { kind: "balanced", tag: "all-mountain", risk: 0.5 };
  }
  function highlight(prompt) {
    let h = prompt || "";
    h = h.replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
    for (const k of [...KW.bomb, ...KW.carve]) {
      h = h.replace(new RegExp("\\b(" + k + ")\\b", "ig"), "<b>$1</b>");
    }
    return h;
  }

  const DEF_A = "Send it. Tuck the fall line straight and fast — bomb every pitch, take the risk on the jumps. Reckless beats careful; speed wins.";
  const DEF_B = "Ride clean and controlled. Carve every turn, stay on edge, keep it safe and steady. Careful lines never crash — control wins the race.";

  // ---- the deterministic engine --------------------------------------------
  function build(seed, opts) {
    const rng = A.rng(seed);
    const prompts = { A: (opts.prompts && opts.prompts.A) || DEF_A, B: (opts.prompts && opts.prompts.B) || DEF_B };
    const doc = { A: doctrine(prompts.A), B: doctrine(prompts.B) };

    // HIDDEN SEEDED TWIST: the avalanche buries one branch on avLeg; an ice patch
    // lurks on iceLeg. avLane = which lane the snow buries (a TUCK there = wipeout).
    const avLeg = 1 + Math.floor(rng() * (LEGS - 2));
    const avLane = Math.floor(rng() * 3);
    let iceLeg = 1 + Math.floor(rng() * (LEGS - 2));
    if (iceLeg === avLeg) iceLeg = (iceLeg % (LEGS - 2)) + 1;
    const iceLane = Math.floor(rng() * 3);

    // Each leg offers three lines. The chosen MOVE (tuck/carve/jump) maps to a lane
    // + a base gain + a crash chance modulated by hazards on that leg.
    function legHazard(leg) {
      return { avalanche: leg === avLeg, ice: leg === iceLeg, avLane, iceLane };
    }
    function lines(leg) {
      const r = A.rng(seed * 977 + leg);
      const hz = legHazard(leg);
      // tuck = center fall line, fast; carve = side line, steady; jump = shortcut.
      return [
        { name: "tuck:straight", kind: "tuck", lane: 1, gain: 17 + r() * 5, crash: 0.10, hz },
        { name: "carve:turn", kind: "carve", lane: 0, gain: 11 + r() * 3, crash: 0.02, hz },
        { name: "jump:shortcut", kind: "jump", lane: 2, gain: 22 + r() * 6, crash: 0.18, hz },
      ];
    }
    function choose(d, opts3) {
      if (d.kind === "bomber") {
        // bomber prefers the biggest gain (jump, then tuck)
        return opts3.slice().sort((a, b) => b.gain - a.gain)[0];
      }
      if (d.kind === "carver") {
        // carver prefers the lowest crash line
        return opts3.slice().sort((a, b) => a.crash - b.crash)[0];
      }
      // balanced: best expected gain (gain * (1-crash))
      return opts3.slice().sort((a, b) => b.gain * (1 - b.crash) - a.gain * (1 - a.crash))[0];
    }

    const st = {
      A: { prog: 0, leg: 0, lane: 0, crashes: 0, lastCrash: false, done: false, lastWP: { x: W * 0.42, y: 96 } },
      B: { prog: 0, leg: 0, lane: 2, crashes: 0, lastCrash: false, done: false, lastWP: { x: W * 0.58, y: 96 } },
    };
    const beats = [];
    const oddsHist = [];
    let ply = 1, winner = undefined, winReason = "closer", finished = false;

    function snapOdds() {
      // Implied chance from the live run. Distance down the mountain dominates,
      // but a CRASH swings the number hard (a wipeout is a real momentum loss in
      // a sprint, not a footnote) — so a fast favourite is never pre-determined.
      const f = (me, op) => {
        const lead = (me.prog - op.prog) / 14;              // proximity to finish
        const wrecks = (op.crashes - me.crashes) * 1.25;    // each wipeout moves it a lot
        const fresh = ((op.lastCrash ? 1 : 0) - (me.lastCrash ? 1 : 0)) * 0.9; // a just-now crash reacts
        const finish = (me.done ? 6 : 0) - (op.done ? 6 : 0); // crossing the line is decisive
        return 1 / (1 + Math.exp(-(lead + wrecks + fresh + finish)));
      };
      let a = f(st.A, st.B), b = f(st.B, st.A);
      const s = a + b || 1; a /= s; b /= s;
      let A2 = a * 100;
      // a favourite is soft, never locked: clamp the live line until someone has
      // actually crossed the finish, so the market keeps room to swing back.
      if (!st.A.done && !st.B.done) A2 = A.clamp(A2, 4, 96);
      return { A: A2, B: 100 - A2 };
    }
    oddsHist.push(snapOdds());

    function nameOf(id) { return id === "A" ? "Comet" : "Cruise"; }
    function shortName(id) { return id === "A" ? "Comet" : "Cruise"; }

    for (let leg = 0; leg < LEGS && !finished; leg++) {
      for (const id of ["A", "B"]) {
        if (finished) break;
        const me = st[id];
        if (me.done) continue;
        const opts3 = lines(leg);
        const hz = legHazard(leg);
        const pick = choose(doc[id], opts3);

        // resolve crash: hazard-aware. A TUCK/JUMP into the buried (avalanche)
        // lane is a near-certain wipeout; ice raises crash chance for fast lines.
        const cr = A.rng(seed * 53 + leg * 9 + (id === "A" ? 1 : 2) + ply * 3)();
        let crashP = pick.crash;
        let cause = null;
        if (hz.avalanche && pick.lane === hz.avLane && pick.kind !== "carve") { crashP = 0.92; cause = "avalanche"; }
        else if (hz.avalanche && pick.lane === hz.avLane) { crashP = 0.45; cause = "avalanche"; }
        else if (hz.ice && pick.lane === hz.iceLane && pick.kind === "tuck") { crashP = Math.max(crashP, 0.55); cause = "ice"; }
        else if (hz.ice && pick.lane === hz.iceLane && pick.kind === "jump") { crashP = Math.max(crashP, 0.40); cause = "ice"; }

        const crashed = cr < crashP;
        me.lastCrash = crashed; // odds line reacts to the most-recent move
        let gained, result, ok = true;
        if (crashed) {
          me.crashes++;
          gained = -Math.min(me.prog, 7 + Math.floor(cr * 6)); // knocked back
          me.prog = Math.max(0, me.prog + gained);
          ok = false;
          const why = cause === "avalanche" ? "buried by the AVALANCHE" : cause === "ice" ? "lost an edge on ICE" : pick.kind === "jump" ? "cased the landing" : "caught a tree";
          result = "WIPEOUT · " + why + " · -" + Math.abs(gained) + " back";
        } else {
          gained = pick.gain;
          me.prog = Math.min(GOAL, me.prog + gained);
          result = "ok · +" + Math.round(gained) + " down · " + Math.max(0, GOAL - Math.round(me.prog)) + " to finish";
        }
        me.leg = leg + 1; me.lane = pick.lane;
        if (me.prog >= GOAL) { me.done = true; result = "FINISH · crossed the line!"; ok = true; }

        const thought = doc[id].kind === "bomber"
          ? "Point it straight and send — fastest line, eat the risk."
          : doc[id].kind === "carver" ? "Clean edge, keep it safe — let them crash."
          : "Best ground I can hold without binning it.";

        const fromWP = me.lastWP;
        const toWP = me.done ? { x: FINISH.x + (id === "A" ? -30 : 30), y: FINISH.y + 30 } : wp(leg, pick.lane, seed);
        me.lastWP = toWP;

        beats.push({
          ply: ply++, agent: id,
          thought,
          observe: {
            pitch: "leg" + (leg + 1) + "/" + LEGS,
            to_finish: Math.max(0, GOAL - Math.round(me.prog)),
            slope: hz.avalanche ? "AVALANCHE warning" : hz.ice ? "ice reported" : "groomed",
            crashes: me.crashes,
          },
          legal: opts3.map((o) => o.name),
          move: pick.name, ok, result,
          state: {
            A: { ...st.A }, B: { ...st.B }, mover: id,
            fromWP, toWP, pickKind: pick.kind, pickLane: pick.lane,
            crashed, cause, hz, leg,
          },
          events: [
            `${shortName(id)} ${pick.kind === "tuck" ? "tucks the fall line" : pick.kind === "carve" ? "carves a clean turn" : "hucks the shortcut"} — ${ok ? (me.done ? "and crosses the FINISH!" : "+" + Math.round(Math.abs(gained)) + " down the mountain") : (cause === "avalanche" ? "the AVALANCHE buries the branch — WIPEOUT!" : cause === "ice" ? "skids out on ICE — WIPEOUT!" : "tomahawks into the snow — WIPEOUT!")}`,
          ],
        });
        oddsHist.push(snapOdds());

        if (me.done) {
          winner = id; winReason = "finish"; finished = true;
        }
      }
    }

    if (winner === undefined) {
      if (st.A.prog === st.B.prog) {
        winner = st.A.crashes === st.B.crashes ? null : (st.A.crashes < st.B.crashes ? "A" : "B");
        winReason = winner == null ? "tie" : "cleaner";
      } else {
        winner = st.A.prog > st.B.prog ? "A" : "B";
        winReason = "closer";
      }
    }

    function finalLine() {
      if (winner == null) return "Photo finish — dead heat on the slope.";
      const loser = winner === "A" ? "B" : "A";
      if (winReason === "finish") return `${nameOf(winner)} bombs across the finish first — race over!`;
      if (winReason === "closer") return `Clock stops — ${nameOf(winner)} is furthest down the mountain.`;
      if (winReason === "cleaner") return `Tied on the slope — ${nameOf(winner)} stayed on their feet, ${nameOf(loser)} ate more snow.`;
      return `${nameOf(winner)} takes it.`;
    }

    beats.push({
      ply: ply++, agent: "ref", move: "resolve", legal: null,
      observe: { winner: winner == null ? "draw" : nameOf(winner), reason: winReason },
      result: winner == null ? "draw — dead heat" : nameOf(winner) + " wins · " + winReason,
      events: [finalLine()],
      state: { A: { ...st.A }, B: { ...st.B }, mover: null, final: true },
    });

    return {
      seed, beats, winner, winReason,
      names: { A: nameOf("A"), B: nameOf("B") },
      promptOf: (id) => highlight(prompts[id]),
      tagOf: (id) => doc[id].tag,
      oddsAt: (b) => oddsHist[Math.min(b, oddsHist.length - 1)] || { A: 50, B: 50 },
      _doc: doc, _avLeg: avLeg, _avLane: avLane, _iceLeg: iceLeg,
    };
  }

  // ====== RENDER =============================================================
  function sledPos(result, beat, beatT) {
    const out = { A: null, B: null };
    for (const id of ["A", "B"]) {
      let cur = null;
      for (let k = 0; k <= beat; k++) {
        const bt = result.beats[k];
        if (bt.agent === id) cur = bt;
      }
      if (!cur || !cur.state.fromWP) { out[id] = wp(0, id === "A" ? 0 : 2, result.seed); continue; }
      const from = cur.state.fromWP, to = cur.state.toWP;
      const active = result.beats[beat] && result.beats[beat].agent === id && result.beats[beat].state && !result.beats[beat].state.final;
      const tt = active ? A.easeOut(beatT) : 1;
      // crash: jolt back near the end of the beat
      let cx = A.lerp(from.x, to.x, tt), cy = A.lerp(from.y, to.y, tt);
      let crashing = false, jumping = false;
      if (active && cur.state.crashed && beatT > 0.62) { crashing = true; }
      if (active && cur.state.pickKind === "jump" && !cur.state.crashed) jumping = true;
      out[id] = {
        x: cx, y: cy, moving: active && beatT < 0.96,
        kind: cur.state.pickKind, crashing, jumping, beatT, crashed: cur.state.crashed,
      };
    }
    return out;
  }

  function draw(ctx, v) {
    const t = v.t, res = v.result, beat = v.beat, bt = res.beats[beat];
    const stt = bt && bt.state ? bt.state : { A: { prog: 0, crashes: 0 }, B: { prog: 0, crashes: 0 } };

    skyAlpine(ctx, t);
    farPeaks(ctx, res.seed, t);
    slope(ctx, res.seed, t);
    pisteLanes(ctx, res.seed, t);
    moguls(ctx, res.seed, t);
    pines(ctx, res.seed, t);
    hazards(ctx, res, t);
    finishBanner(ctx, t, res.winner != null && v.over);
    snowfall(ctx, t);

    const sleds = sledPos(res, beat, v.beatT);
    // dormant snow-shelf crack on the avalanche leg (always, as a tell)
    avalancheShelf(ctx, res, t);
    // the live SWEEP only fires on the beat that actually triggered the avalanche,
    // sweeping down onto the very sled/branch that set it off.
    const moverSled = bt && bt.state && !bt.state.final ? sleds[bt.agent] : null;
    avalancheSweep(ctx, res, bt, v, t, moverSled);

    const order = (stt.A.prog >= stt.B.prog) ? ["A", "B"] : ["B", "A"];
    for (const id of order) if (sleds[id]) {
      roosterTail(ctx, sleds[id], id, t);
    }
    for (const id of order) if (sleds[id]) {
      sled(ctx, sleds[id], id === "A" ? "#10b981" : "#8b5cf6", res.names[id], id, t);
    }

    progressTrack(ctx, res, stt, t);
    hud(ctx, res, stt, t);
    commentary(ctx, res, bt, v);

    if (v.over) finishOverlay(ctx, res, t);
    else {
      for (const id of ["A", "B"]) {
        if (sleds[id] && sleds[id].crashing && bt.agent === id) crashTumble(ctx, sleds[id], v.beatT, bt.state.cause);
      }
    }
    vignette(ctx);
  }

  // --- scene pieces ----------------------------------------------------------
  function skyAlpine(ctx, t) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#9fd0f0");
    g.addColorStop(0.32, "#cfe7f6");
    g.addColorStop(0.62, "#eef6fb");
    g.addColorStop(1, "#f7fbfe");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // soft sun
    A.glow(ctx, W * 0.78, 64, 120, "rgba(255,247,210,0.55)");
    ctx.fillStyle = "rgba(255,250,225,0.9)"; ctx.beginPath(); ctx.arc(W * 0.78, 64, 26, 0, 7); ctx.fill();
    // drifting clouds
    if (!A.reduced) {
      for (let i = 0; i < 4; i++) {
        const cx = ((i * 230 + t * 0.012) % (W + 200)) - 100;
        const cy = 40 + i * 26;
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        for (let j = 0; j < 4; j++) { ctx.beginPath(); ctx.ellipse(cx + j * 26, cy + (j % 2) * 6, 30, 14, 0, 0, 7); ctx.fill(); }
      }
    }
  }
  function farPeaks(ctx, seed, t) {
    const r = A.rng(seed * 7 + 11);
    const base = 150;
    // back range
    ctx.fillStyle = "#b9cfe2";
    ctx.beginPath(); ctx.moveTo(0, base);
    let x = 0;
    while (x < W) { const h = 60 + r() * 70; const w2 = 60 + r() * 50; ctx.lineTo(x + w2 / 2, base - h); x += w2; ctx.lineTo(x, base); }
    ctx.lineTo(W, base); ctx.closePath(); ctx.fill();
    // front range with snowcaps
    const r2 = A.rng(seed * 13 + 3);
    ctx.fillStyle = "#8fadc6";
    ctx.beginPath(); ctx.moveTo(0, base + 20); x = -30;
    const peaks = [];
    while (x < W + 30) { const h = 80 + r2() * 80; const w2 = 90 + r2() * 60; const px = x + w2 / 2; ctx.lineTo(px, base + 20 - h); peaks.push({ x: px, y: base + 20 - h }); x += w2; ctx.lineTo(x, base + 20); }
    ctx.lineTo(W, base + 20); ctx.closePath(); ctx.fill();
    // snow caps
    ctx.fillStyle = "#f4fafe";
    for (const p of peaks) {
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - 22, p.y + 30); ctx.lineTo(p.x - 8, p.y + 22); ctx.lineTo(p.x + 2, p.y + 30); ctx.lineTo(p.x + 14, p.y + 20); ctx.lineTo(p.x + 24, p.y + 32); ctx.closePath(); ctx.fill();
    }
  }
  function slopeOutline(seed) {
    // the iso slope is a downward-widening trapezoid (top narrow=far, bottom wide=near)
    const topY = 138, botY = H - 30;
    const topL = W * 0.30, topR = W * 0.70;
    const botL = W * 0.04, botR = W * 0.96;
    return { topY, botY, topL, topR, botL, botR };
  }
  function slope(ctx, seed, t) {
    const s = slopeOutline(seed);
    const g = ctx.createLinearGradient(0, s.topY, 0, s.botY);
    g.addColorStop(0, "#e9f3fb");
    g.addColorStop(0.5, "#f4f9fd");
    g.addColorStop(1, "#ffffff");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(s.topL, s.topY); ctx.lineTo(s.topR, s.topY);
    ctx.lineTo(s.botR, s.botY); ctx.lineTo(s.botL, s.botY); ctx.closePath();
    ctx.fill();
    // subtle blue shadow contour bands across the slope (depth)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(s.topL, s.topY); ctx.lineTo(s.topR, s.topY);
    ctx.lineTo(s.botR, s.botY); ctx.lineTo(s.botL, s.botY); ctx.closePath();
    ctx.clip();
    for (let i = 0; i < 9; i++) {
      const yy = s.topY + (i / 9) * (s.botY - s.topY);
      ctx.strokeStyle = "rgba(150,185,220,0.13)"; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(0, yy + Math.sin(t / 1400 + i) * 1.5); ctx.lineTo(W, yy + 8); ctx.stroke();
    }
    // side embankment shading
    ctx.fillStyle = "rgba(150,185,220,0.16)";
    ctx.beginPath(); ctx.moveTo(s.topL, s.topY); ctx.lineTo(s.botL, s.botY); ctx.lineTo(s.botL - 30, s.botY); ctx.lineTo(s.topL - 8, s.topY); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(s.topR, s.topY); ctx.lineTo(s.botR, s.botY); ctx.lineTo(s.botR + 30, s.botY); ctx.lineTo(s.topR + 8, s.topY); ctx.closePath(); ctx.fill();
    ctx.restore();
    // sparkle on snow
    if (!A.reduced) {
      for (let i = 0; i < 40; i++) {
        const fx = (i * 211 + 30) % W, fy = s.topY + ((i * 97) % (s.botY - s.topY));
        const tw = (Math.sin(t / 400 + i * 1.7) + 1) / 2;
        if (tw > 0.82) { ctx.fillStyle = `rgba(255,255,255,${tw})`; ctx.fillRect(fx, fy, 2, 2); }
      }
    }
  }
  function pisteLanes(ctx, seed, t) {
    // three carved piste lines from top to finish — the lanes the sleds use.
    const cols = ["#9ec4e6", "#a9cdef", "#9ec4e6"];
    for (let lane = 0; lane < 3; lane++) {
      ctx.beginPath();
      for (let leg = 0; leg <= LEGS; leg++) { const p = wp(leg, lane, seed); leg === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); }
      ctx.strokeStyle = "rgba(150,190,225,0.30)"; ctx.lineWidth = 26; ctx.lineCap = "round"; ctx.stroke();
      // groomed corduroy dashes
      ctx.setLineDash([6, 10]); ctx.lineDashOffset = (t / 40) % 16;
      ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
    }
    // gate flags at each leg edge (slalom poles)
    for (let leg = 1; leg < LEGS; leg++) {
      for (let lane = 0; lane < 3; lane += 2) {
        const p = wp(leg, lane, seed);
        const sway = A.reduced ? 0 : Math.sin(t / 500 + leg + lane) * 2;
        ctx.strokeStyle = "#1f2a44"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(p.x - 16, p.y); ctx.lineTo(p.x - 16 + sway, p.y - 18); ctx.stroke();
        ctx.fillStyle = (leg % 2 ? "#fb5d5d" : "#3aa0ff");
        ctx.beginPath(); ctx.moveTo(p.x - 16 + sway, p.y - 18); ctx.lineTo(p.x - 16 + sway + 11, p.y - 15); ctx.lineTo(p.x - 16 + sway, p.y - 11); ctx.closePath(); ctx.fill();
      }
    }
  }
  function moguls(ctx, seed, t) {
    const r = A.rng(seed * 41 + 17);
    for (let i = 0; i < 26; i++) {
      const leg = r() * LEGS, lane = r() * 2.2;
      const p = wp(leg, lane, seed);
      const rx = 12 + r() * 8, ry = 5 + r() * 3;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 6, rx, ry, 0, 0, 7); ctx.fill();
      ctx.fillStyle = "rgba(160,195,225,0.22)";
      ctx.beginPath(); ctx.ellipse(p.x + rx * 0.3, p.y + 9, rx * 0.7, ry * 0.7, 0, 0, 7); ctx.fill();
    }
  }
  function pine(ctx, x, y, sc) {
    // iso snowy pine
    ctx.fillStyle = "#3a2a18";
    ctx.fillRect(x - 2 * sc, y, 4 * sc, 8 * sc);
    for (let i = 0; i < 3; i++) {
      const ty = y - i * 11 * sc;
      const wdt = (20 - i * 5) * sc;
      ctx.fillStyle = i === 0 ? "#1f5a3a" : i === 1 ? "#246a44" : "#2c7a4f";
      ctx.beginPath(); ctx.moveTo(x, ty - 16 * sc); ctx.lineTo(x - wdt, ty); ctx.lineTo(x + wdt, ty); ctx.closePath(); ctx.fill();
      // snow on the branch
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.beginPath(); ctx.moveTo(x, ty - 16 * sc); ctx.lineTo(x - wdt * 0.55, ty - 4 * sc); ctx.lineTo(x + wdt * 0.55, ty - 4 * sc); ctx.closePath(); ctx.fill();
    }
  }
  function pines(ctx, seed, t) {
    // dense pine forest flanking the piste + scattered on-slope trees (hazards visual)
    const r = A.rng(seed * 71 + 5);
    const s = slopeOutline(seed);
    const trees = [];
    // flanks
    for (let i = 0; i < 26; i++) {
      const frac = i / 26;
      const yy = s.topY + frac * (s.botY - s.topY);
      const sc = 0.7 + frac * 1.0;
      const leftEdge = A.lerp(s.topL, s.botL, frac) - 14 - r() * 26;
      const rightEdge = A.lerp(s.topR, s.botR, frac) + 14 + r() * 26;
      trees.push({ x: leftEdge, y: yy, sc });
      trees.push({ x: rightEdge, y: yy, sc });
    }
    trees.sort((a, b) => a.y - b.y);
    for (const tr of trees) { A.shadow(ctx, tr.x, tr.y + 6 * tr.sc, 12 * tr.sc, 4 * tr.sc, 0.12); pine(ctx, tr.x, tr.y, tr.sc); }
  }
  function hazards(ctx, res, t) {
    // visualize ice patches (and the seeded ice leg) as glassy blue ovals on lanes.
    const seed = res.seed;
    const iceLeg = res._iceLeg;
    // generic scattered ice
    const r = A.rng(seed * 91 + 13);
    for (let i = 0; i < 5; i++) {
      const leg = 0.5 + r() * (LEGS - 1), lane = r() * 2;
      const p = wp(leg, lane, seed);
      iceOval(ctx, p.x, p.y, 16 + r() * 8, t, false);
    }
    // the seeded ICE leg — bigger, shimmering glass on its lanes
    const ip = wp(iceLeg + 0.4, 1, seed);
    iceOval(ctx, ip.x, ip.y, 26, t, true);
    const ip2 = wp(iceLeg + 0.4, 2, seed);
    iceOval(ctx, ip2.x, ip2.y, 20, t, true);
  }
  function iceOval(ctx, x, y, rad, t, big) {
    ctx.save();
    ctx.fillStyle = big ? "rgba(120,200,240,0.42)" : "rgba(140,205,235,0.3)";
    ctx.beginPath(); ctx.ellipse(x, y + 5, rad, rad * 0.5, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = "rgba(190,235,255,0.6)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(x, y + 5, rad, rad * 0.5, 0, 0, 7); ctx.stroke();
    // glint
    if (!A.reduced) {
      const gx = x + Math.sin(t / 600) * rad * 0.4;
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillRect(gx - 5, y + 2, 10, 2);
    }
    ctx.restore();
  }
  function avalancheShelf(ctx, res, t) {
    // a dormant, cracking snow shelf sitting on the buried lane — the seeded tell
    // that warns where the avalanche is primed, drawn every frame on the av leg.
    const p = wp(res._avLeg, res._avLane, res.seed);
    const breathe = A.reduced ? 0 : Math.sin(t / 900) * 1.5;
    ctx.fillStyle = "rgba(232,242,252,0.6)";
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 4, 32, 10, 0, 0, 7); ctx.fill();
    ctx.fillStyle = "rgba(180,205,230,0.35)";
    ctx.beginPath(); ctx.ellipse(p.x + 4, p.y + 7, 24, 6, 0, 0, 7); ctx.fill();
    // jagged stress crack across the shelf
    ctx.strokeStyle = "rgba(110,140,175,0.5)"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p.x - 28, p.y + breathe); ctx.lineTo(p.x - 9, p.y - 4 - breathe);
    ctx.lineTo(p.x + 9, p.y + 2 + breathe); ctx.lineTo(p.x + 30, p.y - 3 - breathe);
    ctx.stroke();
  }
  function avalancheSweep(ctx, res, bt, v, t, victim) {
    // The SWEEP fires only on the beat that actually triggers the avalanche
    // (cause === "avalanche") and pours a churning white wall DOWN the slope onto
    // the very sled that set it off — burying THAT branch, not some empty lane.
    if (!bt || !bt.state || bt.state.final) return;
    if (bt.state.cause !== "avalanche" || !victim) return;
    const phase = A.clamp((v.beatT - 0.12) / 0.6, 0, 1);     // wall descends over the beat
    const ramp = A.clamp(v.beatT / 0.18, 0, 1);              // quick fade-in
    // wall starts upslope (above the victim) and sweeps down onto it.
    const tx = victim.x, ty = victim.y;
    const cx = tx, cy = ty - 96 * (1 - phase);
    ctx.save();
    ctx.globalAlpha = ramp;
    // leading shock-glow on the snow at the victim
    A.glow(ctx, tx, ty - 2, 70 + phase * 30, "rgba(225,238,250,0.55)");
    // a churning wall front spanning the lane, leading edge at cy
    const rng = A.rng(res.seed * 311 + res._avLeg * 13 + (bt.agent === "A" ? 1 : 2));
    for (let i = 0; i < 34; i++) {
      const sx = (rng() - 0.5) * (64 + phase * 30);
      const sy = -40 + rng() * 56;                          // body of the wall above the front
      const rad = (12 + rng() * 24) * (0.55 + phase * 0.6);
      const px = cx + sx, py = cy + sy * (0.5 + 0.5 * phase);
      const shade = 244 - (rng() * 24 | 0);
      ctx.fillStyle = `rgba(${shade},${shade + 4},255,${0.5 + rng() * 0.4})`;
      ctx.beginPath(); ctx.arc(px, py, rad, 0, 7); ctx.fill();
    }
    // dense burial mound right on the victim once the wall lands
    if (phase > 0.45) {
      const bury = (phase - 0.45) / 0.55;
      ctx.fillStyle = `rgba(248,252,255,${0.55 + bury * 0.4})`;
      ctx.beginPath(); ctx.ellipse(tx, ty, 26 + bury * 16, 14 + bury * 8, 0, 0, 7); ctx.fill();
    }
    // flying snow chunks blasting off the impact
    if (!A.reduced) {
      for (let i = 0; i < 28; i++) {
        const a = (i / 28) * 7 + t / 160;
        const rr = 16 + (i % 7) * 11 * phase + Math.sin(t / 110 + i) * 6;
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fillRect(tx + Math.cos(a) * rr, ty + Math.sin(a) * rr * 0.55, 3, 3);
      }
    }
    // warning label rides above the wall, kept clear of the top HUD/odds chrome
    const lx = (tx < 286 && cy - 22 < 130) ? 300 : tx;     // dodge the DESCENT card
    const ly = Math.max(cy - 22, 138);
    A.label(ctx, lx, ly, "❄ AVALANCHE", 13, "#1f6fb0", "center");
    ctx.restore();
  }
  function finishBanner(ctx, t, won) {
    const x = FINISH.x, y = FINISH.y;
    // two posts
    ctx.fillStyle = "#2a3550"; ctx.fillRect(x - 96, y - 6, 7, 60); ctx.fillRect(x + 89, y - 6, 7, 60);
    // checkered banner arching across
    const bw = 192, bx = x - 96, by = y - 44;
    if (won) A.glow(ctx, x, y - 30, 120, "rgba(52,211,153,0.45)");
    ctx.fillStyle = "#0e1626"; A.rrect(ctx, bx, by, bw, 28, 4); ctx.fill();
    const cols = 16, rows = 3, cw = bw / cols;
    for (let cxx = 0; cxx < cols; cxx++) for (let ry = 0; ry < rows; ry++) {
      ctx.fillStyle = ((cxx + ry) % 2 === 0) ? "#f5f7fb" : "#10151f";
      ctx.fillRect(bx + cxx * cw, by + ry * (28 / rows), cw, 28 / rows);
    }
    A.label(ctx, x, by + 19, "FINISH", 15, won ? "#0c6b48" : "#b32a2a", "center");
    // little flags fluttering
    const fl = A.reduced ? 0 : Math.sin(t / 300) * 3;
    ctx.fillStyle = "#fb5d5d"; ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx - 14, by - 6 + fl); ctx.lineTo(bx, by - 12); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#3aa0ff"; ctx.beginPath(); ctx.moveTo(bx + bw, by); ctx.lineTo(bx + bw + 14, by - 6 - fl); ctx.lineTo(bx + bw, by - 12); ctx.closePath(); ctx.fill();
  }
  function snowfall(ctx, t) {
    if (A.reduced) return;
    for (let i = 0; i < 70; i++) {
      const x = (i * 113 + t * 0.04 + Math.sin(t / 700 + i) * 14) % W;
      const y = (i * 71 + t * 0.07) % H;
      const sz = 1 + (i % 3);
      ctx.fillStyle = `rgba(255,255,255,${0.4 + (i % 3) * 0.18})`;
      ctx.beginPath(); ctx.arc(x, y, sz, 0, 7); ctx.fill();
    }
  }
  function roosterTail(ctx, pc, id, t) {
    if (A.reduced || !pc.moving) return;
    const col = id === "A" ? "#a7f3d0" : "#ddd6fe";
    // powder spray streaming UP-slope behind the descending sled
    for (let i = 0; i < 16; i++) {
      const sp = i / 16;
      const px = pc.x + (Math.sin(t / 60 + i) * 10) * sp;
      const py = pc.y - 8 - sp * 34;
      const rad = 8 * (1 - sp) + 1;
      ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - sp)})`;
      ctx.beginPath(); ctx.arc(px, py, rad, 0, 7); ctx.fill();
    }
    ctx.fillStyle = col + "55";
    ctx.beginPath(); ctx.moveTo(pc.x - 6, pc.y - 4); ctx.lineTo(pc.x, pc.y - 34); ctx.lineTo(pc.x + 6, pc.y - 4); ctx.closePath(); ctx.fill();
  }
  function sled(ctx, pc, col, name, id, t) {
    ctx.save();
    let yo = 0;
    if (pc.jumping) { yo = -Math.sin(pc.beatT * Math.PI) * 26; } // airtime arc
    const x = pc.x, y = pc.y + yo;
    A.shadow(ctx, pc.x, pc.y + 12, 16 - (pc.jumping ? -yo * 0.2 : 0), 6, 0.28);
    // tumble rotation if crashing handled by crashTumble overlay; here draw upright sled
    ctx.translate(x, y);
    // motion smear
    if (pc.moving && !A.reduced) {
      const g = ctx.createLinearGradient(0, -22, 0, 6);
      g.addColorStop(0, col + "00"); g.addColorStop(1, col + "55");
      ctx.fillStyle = g; ctx.fillRect(-8, -22, 16, 26);
    }
    // sled base (runner) — iso-ish toboggan pointing down-slope
    ctx.fillStyle = "#15202e"; A.rrect(ctx, -13, 4, 26, 9, 4); ctx.fill();
    ctx.fillStyle = col; A.rrect(ctx, -12, -8, 24, 16, 6); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.22)"; A.rrect(ctx, -12, -8, 24, 5, 5); ctx.fill();
    // rider (tucked chibi)
    ctx.fillStyle = id === "A" ? "#0b3b2c" : "#3b2b5c";
    A.rrect(ctx, -7, -16, 14, 14, 5); ctx.fill(); // torso (tucked)
    ctx.fillStyle = "#f3c79a"; ctx.beginPath(); ctx.arc(0, -19, 6, 0, 7); ctx.fill(); // helmet base
    ctx.fillStyle = col; A.rrect(ctx, -6, -25, 12, 8, 4); ctx.fill(); // helmet
    ctx.fillStyle = "#0c1424"; ctx.fillRect(-5, -21, 10, 4); // goggles
    ctx.fillStyle = "rgba(120,220,255,0.7)"; ctx.fillRect(-5, -21, 10, 2);
    // runner skis
    ctx.strokeStyle = "#0c1424"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-12, 12); ctx.lineTo(-10, 14); ctx.moveTo(12, 12); ctx.lineTo(10, 14); ctx.stroke();
    A.label(ctx, 0, -1, id, 8, "rgba(255,255,255,0.85)", "center");
    ctx.restore();
    // name tag
    ctx.fillStyle = "rgba(8,16,30,0.9)"; const w = Math.max(54, name.length * 8);
    A.rrect(ctx, pc.x - w / 2, pc.y + 16, w, 15, 4); ctx.fill();
    A.label(ctx, pc.x, pc.y + 27, name.toUpperCase(), 9, id === "A" ? "#5eead4" : "#c4b5fd", "center");
  }
  function crashTumble(ctx, pc, beatT, cause) {
    const a = Math.sin(beatT * Math.PI);
    // snow burst
    for (let i = 0; i < 22; i++) {
      const ang = (i / 22) * 7;
      const rr = 8 + a * 36 + (i % 4) * 6;
      ctx.fillStyle = `rgba(255,255,255,${0.8 * a})`;
      ctx.beginPath(); ctx.arc(pc.x + Math.cos(ang) * rr, pc.y - 4 + Math.sin(ang) * rr * 0.7, 3 + (i % 2), 0, 7); ctx.fill();
    }
    // tumbling sled glyphs
    ctx.save(); ctx.translate(pc.x, pc.y - 6); ctx.rotate(beatT * 8);
    ctx.fillStyle = "#15202e"; A.rrect(ctx, -10, -5, 20, 9, 4); ctx.fill();
    ctx.restore();
    const label = cause === "avalanche" ? "BURIED!" : cause === "ice" ? "SKIDS OUT!" : "WIPEOUT!";
    ctx.save(); ctx.globalAlpha = 0.4 + a * 0.6;
    A.label(ctx, pc.x, pc.y - 32, label, 15, "#e8513a", "center");
    ctx.restore();
  }
  function progressTrack(ctx, res, stt, t) {
    // vertical descent track on the right edge — markers slide DOWN as sleds descend
    const tx = W - 26, top = 150, bot = H - 70;
    ctx.fillStyle = "rgba(12,22,38,0.55)"; A.rrect(ctx, tx - 8, top - 10, 18, bot - top + 20, 8); ctx.fill();
    // gradient fill (snow at top, finish at bottom)
    const g = ctx.createLinearGradient(0, top, 0, bot);
    g.addColorStop(0, "#dff0fb"); g.addColorStop(1, "#34d399");
    ctx.fillStyle = g; A.rrect(ctx, tx - 4, top, 8, bot - top, 4); ctx.fill();
    A.label(ctx, tx, top - 16, "TOP", 7, "#dff0fb", "center");
    A.label(ctx, tx, bot + 16, "FIN", 7, "#34d399", "center");
    for (const id of ["A", "B"]) {
      const s = stt[id] || { prog: 0 };
      const yy = A.lerp(top, bot, A.clamp(s.prog / GOAL, 0, 1));
      const col = id === "A" ? "#10b981" : "#8b5cf6";
      ctx.fillStyle = col; ctx.beginPath();
      const off = id === "A" ? -1 : 1;
      ctx.arc(tx + off * 5, yy, 5, 0, 7); ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke();
      A.label(ctx, tx + off * 14, yy + 3, id, 8, col, "center");
    }
  }
  function hud(ctx, res, stt, t) {
    // Per-racer DESCENT progress — NOT win-odds (those live in the top-center pill
    // + panel). Labelled "to finish" so a viewer never confuses it with the market.
    const rows = [["A", res.names.A, "#10b981", "#5eead4"], ["B", res.names.B, "#8b5cf6", "#c4b5fd"]];
    ctx.fillStyle = "rgba(10,22,38,0.82)"; A.rrect(ctx, 12, 44, 262, 76, 10); ctx.fill();
    ctx.strokeStyle = "rgba(120,200,240,0.5)"; ctx.lineWidth = 1; A.rrect(ctx, 12.5, 44.5, 261, 75, 10); ctx.stroke();
    A.label(ctx, 24, 62, "⛷ DESCENT", 10, "#9fd0f0", "left");
    A.label(ctx, 262, 62, "to finish", 8, "#6f8aa6", "right");
    rows.forEach(([id, nm, col, soft], i) => {
      const y = 78 + i * 20; const s = stt[id] || { prog: 0, crashes: 0, done: false };
      A.label(ctx, 24, y + 4, nm.toUpperCase(), 10, soft, "left");
      // bar fills as the sled descends; the readout is distance LEFT (not a %).
      bar(ctx, 116, y - 3, 92, 8, s.prog / GOAL, col, "#0a1322");
      const left = Math.max(0, GOAL - Math.round(s.prog));
      A.label(ctx, 214, y + 4, s.done ? "FIN" : left + " left", 9, s.done ? "#34d399" : soft, "left");
      // crash pips (wipeouts taken)
      for (let k = 0; k < (s.crashes || 0); k++) { ctx.fillStyle = "#e8513a"; ctx.fillRect(264, y - 6 + k * 5, 4, 4); }
    });
  }
  function bar(ctx, x, y, w, h, frac, col, bg) {
    ctx.fillStyle = bg; A.rrect(ctx, x, y, w, h, h / 2); ctx.fill();
    ctx.fillStyle = col; A.rrect(ctx, x, y, Math.max(2, w * A.clamp(frac, 0, 1)), h, h / 2); ctx.fill();
  }
  function commentary(ctx, res, bt, v) {
    const h = 44; const y = H - h;
    ctx.fillStyle = "rgba(8,18,32,0.92)"; ctx.fillRect(0, y, W, h);
    ctx.strokeStyle = "rgba(120,200,240,0.5)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(W, y + .5); ctx.stroke();
    A.label(ctx, 16, y + 18, "🎙 SLOPESIDE", 10, "#5eead4", "left");
    let line = "Two sleds drop in. Read each doctrine — who BOMBS the fall line, who CARVES it clean? Watch for the buried branch.";
    if (bt && bt.events && bt.events[0]) line = bt.events[0];
    if (v.over && res.beats.length) line = res.beats[res.beats.length - 1].events[0];
    A.wrap(ctx, line, 120, y + 18, W - 140, 14, 12, "#dbe9fb", "ui-monospace,monospace");
  }
  function finishOverlay(ctx, res, t) {
    ctx.fillStyle = "rgba(8,20,34,0.5)"; ctx.fillRect(0, 0, W, H);
    const draw = res.winner == null;
    const col = draw ? "#9aa2b6" : res.winner === "A" ? "#34d399" : "#a855f7";
    A.glow(ctx, W / 2, H / 2 - 14, 230, (draw ? "rgba(154,162,182," : res.winner === "A" ? "rgba(52,211,153," : "rgba(168,85,247,") + "0.2)");
    const loser = res.winner === "A" ? "B" : "A";
    const title = draw ? "DEAD HEAT" : res.winReason === "finish" ? "FINISH!" : res.winReason === "cleaner" ? "CLEANEST RUN" : "FURTHEST DOWN";
    const sub = draw ? "Photo finish on the slope"
      : res.winReason === "finish" ? res.names[res.winner] + " crosses the line first"
      : res.winReason === "cleaner" ? res.names[res.winner] + " stayed up; " + res.names[loser] + " ate more snow"
      : res.names[res.winner] + " is furthest down the mountain";
    // banner plate behind the title for legibility over the snow
    ctx.fillStyle = "rgba(8,20,34,0.6)"; A.rrect(ctx, W / 2 - 260, H / 2 - 58, 520, 96, 14); ctx.fill();
    A.label(ctx, W / 2, H / 2 - 16, title, draw ? 40 : 36, col, "center", "ui-monospace,monospace");
    A.label(ctx, W / 2, H / 2 + 18, sub, 16, "#eaf3fb", "center");
    // powder-burst celebration
    if (!draw && !A.reduced) for (let i = 0; i < 60; i++) {
      const a = (i / 60) * 7 + t / 500; const r = 50 + (i % 6) * 30 + Math.sin(t / 280 + i) * 12;
      ctx.fillStyle = i % 3 === 0 ? col : "#ffffff";
      const px = W / 2 + Math.cos(a) * r, py = H / 2 - 14 + Math.sin(a) * r * 0.6;
      ctx.beginPath(); ctx.arc(px, py, 2 + (i % 3), 0, 7); ctx.fill();
    }
  }
  function vignette(ctx) {
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.34, W / 2, H / 2, H * 0.85);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(20,40,60,0.32)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  window.DOWNHILL = {
    id: "downhill", name: "Downhill Daredevils", W, H,
    tag: "Two sleds bomb down a seeded alpine slope to the checkered finish. TUCK the fall line for raw speed but risk trees, ice and a buried branch; CARVE clean and steady; JUMP the shortcut and pray the landing. First down wins.",
    champions: [{ id: "A", name: "Comet", color: "#10b981" }, { id: "B", name: "Cruise", color: "#8b5cf6" }],
    prompts: { A: DEF_A, B: DEF_B },
    mcp: {
      kickoff: "You are a downhill sled racer in a refereed run, played entirely through your tools. Each turn: get_state, legal_moves, then make_move with a line and the current ply. Tuck for speed, carve for safety, or jump the shortcut — first sled to the finish wins. Beware the seeded avalanche and ice.",
      tools: [
        { name: "get_state", args: "", ret: "{pitch, to_finish, slope, crashes}", desc: "Read the run: pitch you're on, distance to the finish, slope report (avalanche/ice/groomed), your crash count." },
        { name: "legal_moves", args: "", ret: "[line, …], ply", desc: "The lines you can take from here: tuck:straight, carve:turn, jump:shortcut." },
        { name: "make_move", args: "line, expected_ply", desc: "Commit a line. Tuck is fastest but reckless; carve is safe and steady; jump skips ahead but risks a bad landing.", ret: "new state | error" },
        { name: "resign", args: "", ret: "forfeit", desc: "Pull off the course." },
      ],
      vocab: "tuck:straight · carve:turn · jump:shortcut",
    },
    build, draw,
  };
})();
