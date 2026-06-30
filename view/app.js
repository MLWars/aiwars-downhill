/* Downhill Daredevils spectator board. Polls ./state.json and renders two sleds
 * bombing a snowy slope toward the finish, with crash counts, live odds, and the
 * winner overlay. Read-only, offline, procedural — mirrors the chess board's
 * app.js. Dispatches on data.game === "downhill". */
(function () {
  const W = 780, H = 560, GOAL = 100;
  const cv = document.getElementById("c"), ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const statusEl = document.getElementById("status");
  const LANE_X = [W * 0.30, W * 0.5, W * 0.70];
  const top = 96, bot = H - 84;
  const lerp = (a, b, t) => a + (b - a) * t;
  let data = null, shown = [0, 0];

  async function tick() {
    try {
      const r = await fetch("./state.json", { cache: "no-store" });
      data = await r.json();
      if (data.game !== "downhill") { statusEl.innerHTML = `<span class="off">unsupported game: ${data.game || "?"}</span>`; data = null; return; }
      const s = data.sleds;
      statusEl.textContent = data.winner
        ? `Final — ${data.winner} wins (${data.win_reason}).`
        : `Live · ${s[0].handle} ${s[0].progress}% (${s[0].crashes} crashes) vs ${s[1].handle} ${s[1].progress}% · leader ${data.leader || "—"}`;
    } catch (e) { statusEl.innerHTML = `<span class="off">waiting for referee…</span>`; }
  }
  setInterval(tick, 1000); tick();

  function sky() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#9fc7e8"); g.addColorStop(0.4, "#cfe2f0"); g.addColorStop(1, "#eef5fb");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // distant peaks
    ctx.fillStyle = "#b9cfe0";
    for (const [x, w, h] of [[60, 220, 120], [300, 260, 160], [560, 240, 130]]) {
      ctx.beginPath(); ctx.moveTo(x, 150); ctx.lineTo(x + w / 2, 150 - h); ctx.lineTo(x + w, 150); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.moveTo(x + w / 2 - 18, 150 - h + 26); ctx.lineTo(x + w / 2, 150 - h); ctx.lineTo(x + w / 2 + 18, 150 - h + 26); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#b9cfe0";
    }
    ctx.fillStyle = "#fff46b"; ctx.beginPath(); ctx.arc(660, 70, 26, 0, 7); ctx.fill();
  }
  function piste(t) {
    // the snowy run
    ctx.fillStyle = "#f3f8fc"; ctx.beginPath(); ctx.moveTo(W * 0.16, top); ctx.lineTo(W * 0.84, top); ctx.lineTo(W * 0.96, bot); ctx.lineTo(W * 0.04, bot); ctx.closePath(); ctx.fill();
    // lane guides
    ctx.strokeStyle = "#dbe8f2"; ctx.lineWidth = 2; ctx.setLineDash([8, 12]); ctx.lineDashOffset = -(t / 24) % 20;
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(LANE_X[i], top); ctx.lineTo(LANE_X[i] + (LANE_X[i] - W / 2) * 0.12, bot); ctx.stroke(); }
    ctx.setLineDash([]);
    // trees down both sides
    for (let i = 0; i < 9; i++) {
      const ty = top + 30 + i * ((bot - top) / 9);
      const f = (ty - top) / (bot - top);
      tree(W * 0.16 - f * 60 + 6, ty, 0.6 + f * 0.7); tree(W * 0.84 + f * 60 - 6, ty, 0.6 + f * 0.7);
    }
    // finish banner
    ctx.fillStyle = "#101521"; ctx.fillRect(W * 0.05, bot, W * 0.9, 16);
    for (let x = 0; x < W * 0.9; x += 16) { ctx.fillStyle = (x / 16) % 2 ? "#fff" : "#101521"; ctx.fillRect(W * 0.05 + x, bot, 16, 8); }
    label(W / 2, bot + 13, "FINISH", 11, "#ff4d5e", "center");
  }
  function tree(x, y, s) {
    ctx.fillStyle = "#3a2a18"; ctx.fillRect(x - 2 * s, y, 4 * s, 8 * s);
    ctx.fillStyle = "#2f6b46"; for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.moveTo(x - 12 * s + k * 2, y - k * 9 * s); ctx.lineTo(x, y - (k * 9 + 16) * s); ctx.lineTo(x + 12 * s - k * 2, y - k * 9 * s); ctx.closePath(); ctx.fill(); }
    ctx.fillStyle = "#eaf4fb"; ctx.beginPath(); ctx.moveTo(x - 4 * s, y - 28 * s); ctx.lineTo(x, y - 34 * s); ctx.lineTo(x + 4 * s, y - 28 * s); ctx.closePath(); ctx.fill();
  }
  function sled(x, y, col, name, id, crashed, t) {
    // rooster-tail
    ctx.fillStyle = "rgba(255,255,255,.7)"; for (let i = 0; i < 6; i++) ctx.fillRect(x - 10 + Math.sin(t / 90 + i) * 4, y - i * 5 - 6, 3, 3);
    ctx.fillStyle = "rgba(0,0,0,.18)"; ctx.beginPath(); ctx.ellipse(x, y + 12, 14, 4, 0, 0, 7); ctx.fill();
    // rider
    ctx.fillStyle = col; rrect(x - 8, y - 16, 16, 18, 5); ctx.fill();
    ctx.fillStyle = "#f3c79a"; ctx.beginPath(); ctx.arc(x, y - 18, 5, 0, 7); ctx.fill();
    ctx.fillStyle = "#0c1424"; rrect(x - 5, y - 22, 10, 5, 2); ctx.fill();
    // sled
    ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x - 12, y + 8); ctx.lineTo(x + 12, y + 8); ctx.lineTo(x + 16, y + 4); ctx.stroke();
    if (crashed) { label(x, y - 30, "WIPEOUT!", 12, "#ff3b53", "center"); for (let i = 0; i < 8; i++) { ctx.fillStyle = "#fff"; ctx.fillRect(x + Math.cos(i) * 16, y + Math.sin(i) * 12, 3, 3); } }
    ctx.fillStyle = "rgba(8,16,30,.9)"; const w = Math.max(46, name.length * 8); rrect(x - w / 2, y + 16, w, 15, 4); ctx.fill();
    label(x, y + 27, name.toUpperCase(), 9, id === "A" ? "#5eead4" : "#c4b5fd", "center");
  }
  function oddsA() {
    if (!data) return 0.5; const s = data.sleds;
    const lead = (s[0].progress - s[1].progress) / 24, risk = (s[1].crashes - s[0].crashes) * 0.5;
    const f = (x) => 1 / (1 + Math.exp(-x)); const a = f(lead + risk), b = f(-lead - risk); return a / (a + b);
  }
  function hud() {
    if (!data) return; const s = data.sleds, rows = [[s[0], "#10b981", "#5eead4"], [s[1], "#8b5cf6", "#c4b5fd"]];
    ctx.fillStyle = "rgba(8,14,26,.8)"; rrect(12, 44, 230, 60, 10); ctx.fill();
    rows.forEach(([d, col, soft], i) => { const y = 62 + i * 26;
      label(24, y + 4, d.handle.toUpperCase().slice(0, 12), 10, soft, "left");
      bar(110, y - 4, 86, 7, d.progress / GOAL, col);
      label(204, y + 2, d.finished ? "DOWN" : d.progress + "% · " + d.crashes + "✗", 9, soft, "left");
    });
    const a = oddsA(), pa = Math.round(a * 100), bw = 248, x = (W - bw) / 2;
    ctx.fillStyle = "rgba(7,11,20,.82)"; rrect(x, 7, bw, 30, 9); ctx.fill();
    label(W / 2, 19, "◷ LIVE ODDS", 8, "#7C8AA0", "center");
    label(x + 12, 19, data.sleds[0].handle.toUpperCase() + " " + pa + "%", 9, "#5eead4", "left");
    label(x + bw - 12, 19, (100 - pa) + "% " + data.sleds[1].handle.toUpperCase(), 9, "#c4b5fd", "right");
    const aw = Math.max(2, (bw - 24) * a); ctx.fillStyle = "#10b981"; rrect(x + 12, 25, aw, 7, 3); ctx.fill();
    ctx.fillStyle = "#8b5cf6"; rrect(x + 12 + aw, 25, bw - 24 - aw, 7, 3); ctx.fill();
  }
  function finish() {
    if (!data || (!data.winner && !["draw", "doublecrash"].includes(data.status))) return;
    ctx.fillStyle = "rgba(3,6,12,.5)"; ctx.fillRect(0, 0, W, H);
    const draw = !data.winner, col = draw ? "#9aa2b6" : data.winner === data.sleds[0].handle ? "#34d399" : "#a855f7";
    label(W / 2, H / 2 - 6, draw ? "PHOTO FINISH" : "FINISH!", 34, col, "center");
    label(W / 2, H / 2 + 24, draw ? "Dead heat" : data.winner + " wins the run", 16, "#e9ecf5", "center");
  }
  function frame(t) {
    sky(); piste(t);
    if (data) {
      const s = data.sleds;
      for (let i = 0; i < 2; i++) shown[i] += (s[i].progress - shown[i]) * 0.12;
      const pos = [0, 1].map(i => ({ x: LANE_X[s[i].lane] || W / 2, y: lerp(top, bot, Math.min(1, shown[i] / GOAL)) }));
      const order = data.leader === s[0].handle ? [1, 0] : [0, 1];
      for (const i of order) sled(pos[i].x, pos[i].y, i ? "#8b5cf6" : "#10b981", s[i].handle, i ? "B" : "A", s[i].last_crash >= 0 && s[i].last_crash === s[i].leg, t);
      hud(); finish();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  function rrect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function label(x, y, t, px, c, al) { ctx.fillStyle = c; ctx.textAlign = al || "left"; ctx.font = `700 ${px}px ui-monospace,monospace`; ctx.fillText(t, x, y); }
  function bar(x, y, w, h, f, c) { ctx.fillStyle = "#0a1322"; rrect(x, y, w, h, h / 2); ctx.fill(); ctx.fillStyle = c; rrect(x, y, Math.max(2, w * Math.max(0, Math.min(1, f))), h, h / 2); ctx.fill(); }
})();
