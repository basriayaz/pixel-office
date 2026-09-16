// Pixel-art office: 32px tiles, rooms with doors, BFS walking, detailed characters.
const TILE = 32;
const COLS = 30;
const ROWS = 17;
const LW = COLS * TILE;
const LH = ROWS * TILE;
const WALK_SPEED = 88;
const ENTRANCE = { tx: 14, ty: 16 }; // doormat at the bottom edge of the open office; new hires walk in from below
const CONFETTI = ["#ff3b3b", "#ffd166", "#4ade80", "#61afef", "#c678dd", "#ff8c42", "#f4f4f4"];
const OUTLINE = "#1d1a1f";

const rand = (a, b) => a + Math.random() * (b - a);
const key = (x, y) => x + "," + y;

// Rooms: x0..x1, y0..y1 in tiles (inclusive)
const ROOM_NAMES = (window.PO && window.PO.strings && window.PO.strings.rooms) || {};
const roomName = (theme, key) => (ROOM_NAMES[theme] && ROOM_NAMES[theme][key]) || ROOM_NAMES[key] || key.toUpperCase();
const ROOMS = [
  { key: "kitchen", name: ROOM_NAMES["kitchen"] || "KITCHEN", x0: 0, y0: 2, x1: 6, y1: 8, floor: "tiles" },
  { key: "office", name: ROOM_NAMES["office"] || "OPEN OFFICE", x0: 8, y0: 2, x1: 21, y1: 16, floor: "wood" },
  { key: "meeting", name: ROOM_NAMES["meeting"] || "MEETING", x0: 23, y0: 2, x1: 29, y1: 8, floor: "carpet" },
  { key: "lounge", name: ROOM_NAMES["lounge"] || "LOUNGE", x0: 0, y0: 10, x1: 6, y1: 16, floor: "wood" },
  { key: "archive", name: ROOM_NAMES["archive"] || "ARCHIVE", x0: 23, y0: 10, x1: 29, y1: 16, floor: "concrete" },
];

// Hangout spots: tile, facing, animation (sit = sits on furniture at that tile)
// `via` = the tile a character must step in from (so nobody climbs over a sofa back or a table)
const SPOTS = [
  { key: "coffee", tx: 3, ty: 3, dir: "up", anim: "drink" },
  { key: "fridge", tx: 5, ty: 3, dir: "up", anim: "stand" },
  { key: "stoolL", tx: 1, ty: 6, dir: "right", anim: "sitfree", via: [1, 7] },
  { key: "stoolR", tx: 4, ty: 6, dir: "left", anim: "sitfree", via: [4, 7] },
  { key: "meetA", tx: 24, ty: 3, dir: "down", anim: "sitfree", via: [24, 2] },
  { key: "meetB", tx: 26, ty: 3, dir: "down", anim: "sitfree", via: [26, 2] },
  { key: "meetC", tx: 24, ty: 6, dir: "up", anim: "sitfree", via: [24, 7] },
  { key: "meetD", tx: 26, ty: 6, dir: "up", anim: "sitfree", via: [26, 7] },
  { key: "sofaL", tx: 1, ty: 12, dir: "down", anim: "sitfree", via: [1, 13] },
  { key: "sofaR", tx: 3, ty: 12, dir: "down", anim: "sitfree", via: [3, 13] },
  { key: "books", tx: 5, ty: 12, dir: "up", anim: "read" },
  { key: "printer", tx: 27, ty: 14, dir: "up", anim: "think" },
  { key: "water", tx: 24, ty: 14, dir: "left", anim: "drink" },
  { key: "window", tx: 20, ty: 2, dir: "up", anim: "stand" },
];

// Desk layout inside the open office (x 8..21): seat tile columns / rows by head-count
function deskLayout(n) {
  const cols = n <= 2 ? [14] : n <= 4 ? [11, 17] : [10, 14, 18];
  const rowsNeeded = Math.ceil(n / cols.length);
  const rows = [[8], [5, 11], [4, 9, 14], [3, 7, 11, 15]][Math.min(rowsNeeded, 4) - 1];
  return { cols, rows };
}

function buildStaticFor(theme) {
    const blocked = new Set(), doors = new Set(), decor = [];
    const block = (x, y) => blocked.add(key(x, y));
    const add = (x, y, draw) => decor.push({ y: (y + 1) * TILE, draw });
    const P = (name) => prop(theme, name);

    for (let x = 0; x < COLS; x++) { block(x, 0); block(x, 1); }
    // interior walls with doors
    const doorTiles = [[7, 5], [7, 6], [22, 5], [22, 6], [3, 9], [4, 9], [25, 9], [26, 9], [7, 12], [7, 13], [22, 12], [22, 13]];
    for (const [x, y] of doorTiles) doors.add(key(x, y));
    for (let y = 2; y < ROWS; y++) { if (!doors.has(key(7, y))) block(7, y); if (!doors.has(key(22, y))) block(22, y); }
    for (let x = 0; x <= 6; x++) if (!doors.has(key(x, 9))) block(x, 9);
    for (let x = 23; x < COLS; x++) if (!doors.has(key(x, 9))) block(x, 9);

    // kitchen
    for (let x = 0; x <= 4; x++) block(x, 2);
    add(2, 2, (b, t) => P("kitchenCounter")(b, 0, 2 * TILE, t));
    block(5, 2); add(5, 2, (b) => P("fridge")(b, 5 * TILE, 2 * TILE));
    block(2, 6); block(3, 6); add(2, 6, (b) => P("roundTable")(b, 2 * TILE, 6 * TILE));
    add(1, 6, (b) => P("stool")(b, 1 * TILE, 6 * TILE)); add(4, 6, (b) => P("stool")(b, 4 * TILE, 6 * TILE));
    block(0, 8); add(0, 8, (b) => P("bin")(b, 0, 8 * TILE));
    block(6, 8); add(6, 8, (b) => P("plant")(b, 6 * TILE, 8 * TILE, 1));

    // meeting room
    for (let x = 24; x <= 27; x++) for (let y = 4; y <= 5; y++) block(x, y);
    add(25, 5, (b) => P("meetingTable")(b, 24 * TILE, 4 * TILE));
    for (const [x, y, dir] of [[24, 3, "down"], [26, 3, "down"], [24, 6, "up"], [26, 6, "up"]]) {
      add(x, y, (b) => P("meetingChair")(b, x * TILE, y * TILE, dir, "back"));
      decor.push({ y: (y + 1) * TILE + 8, draw: (b) => P("meetingChair")(b, x * TILE, y * TILE, dir, "front") });
    }
    block(29, 2); add(29, 2, (b) => P("plant")(b, 29 * TILE, 2 * TILE, 2));
    block(23, 8); add(23, 8, (b) => P("plant")(b, 23 * TILE, 8 * TILE, 1));

    // lounge
    for (let x = 1; x <= 3; x++) block(x, 12);
    add(2, 12, (b) => P("sofa")(b, 1 * TILE, 12 * TILE));
    for (let x = 1; x <= 3; x++) block(x, 14);
    add(2, 14, (b) => P("coffeeTable")(b, 1 * TILE, 14 * TILE));
    block(5, 11); add(5, 11, (b) => P("bookshelf")(b, 5 * TILE, 11 * TILE));
    block(0, 10); add(0, 10, (b, t) => P("lamp")(b, 0, 10 * TILE, t));
    block(6, 16); add(6, 16, (b) => P("plant")(b, 6 * TILE, 16 * TILE, 2));
    block(0, 16); add(0, 16, (b) => P("plant")(b, 0, 16 * TILE, 1));

    // archive
    for (let x = 23; x <= 25; x++) block(x, 10);
    add(24, 10, (b) => P("cabinets")(b, 23 * TILE, 10 * TILE));
    block(28, 10); block(29, 10); add(28, 10, (b) => P("boxes")(b, 28 * TILE, 10 * TILE));
    block(27, 13); block(28, 13); add(27, 13, (b, t) => P("printer")(b, 27 * TILE, 13 * TILE, t));
    block(23, 14); add(23, 14, (b) => P("cooler")(b, 23 * TILE, 14 * TILE));
    block(29, 16); add(29, 16, (b) => P("plant")(b, 29 * TILE, 16 * TILE, 2));

    // open office extras
    block(8, 16); add(8, 16, (b) => P("plant")(b, 8 * TILE, 16 * TILE, 2));
    block(21, 16); add(21, 16, (b) => P("plant")(b, 21 * TILE, 16 * TILE, 2));
    block(8, 2); add(8, 2, (b, t) => P("coffeeStation")(b, 8 * TILE, 2 * TILE, t));
    // entrance doormat (walkable)
    decor.push({ y: ENTRANCE.ty * TILE + 2, draw: (b) => { const x = ENTRANCE.tx * TILE + 2, y = ENTRANCE.ty * TILE + 14; outlineRect(b, x, y, 28, 16, "#6b4a2b"); b.fillStyle = "#8a6a3b"; for (let i = 0; i < 6; i++) b.fillRect(x + 2, y + 2 + i * 2.5, 24, 1); b.fillStyle = "#c9a781"; b.fillRect(x + 8, y + 6, 12, 4); } });
      return { blocked, doors, decor };
}

class Office {
  constructor(canvas, labelsEl) {
    this.canvas = canvas;
    this.labelsEl = labelsEl;
    this.ctx = canvas.getContext("2d");
    this.buf = document.createElement("canvas");
    this.buf.width = LW;
    this.buf.height = LH;
    this.b = this.buf.getContext("2d");
    this.emps = [];
    this.selected = null;
    this.hovered = null;
    this.scale = 1;
    this.offline = false;
    this.clickHandler = null;
    this.blocked = new Set();
    this.doors = new Set();
    this.decor = [];
    this.theme = "default";
    this.particles = [];
    this.last = performance.now();
    this.labelEls = new Map();
    this.roomEls = [];
    canvas.addEventListener("mousemove", (e) => this.onMove(e));
    canvas.addEventListener("mouseleave", () => { this.hovered = null; canvas.classList.remove("hover"); });
    canvas.addEventListener("click", (e) => {
      const id = this.hitTest(e);
      if (id && this.clickHandler) this.clickHandler(id);
    });
    window.addEventListener("resize", () => this.fit());
    this.buildStatic();
    this.fit();
  }

  onClick(cb) { this.clickHandler = cb; }

  setTheme(name) {
    const next = THEMES[name] ? name : "default";
    if (next === this.theme) return;
    this.theme = next;
    this.buildStatic();
    for (const e of this.emps) for (let dx = -1; dx <= 1; dx++) this.blocked.add(key(e.seat.tx + dx, e.seat.ty + 1));
    for (const { r, el } of this.roomEls) el.textContent = roomName(this.theme, r.key);
    this.labelsEl.classList.toggle("dark", !!(THEMES[this.theme] || {}).dark);
  }

  // ---------- layout ----------
  buildStatic() {
    const st = buildStaticFor(this.theme);
    this.blocked = st.blocked;
    this.doors = st.doors;
    this.decor = st.decor;
  }

  setEmployees(list, entering = null) {
    const n = Math.min(list.length, 12);
    const { cols, rows } = deskLayout(n);
    this.buildStatic();
    const prev = new Map(this.emps.map((e) => [e.id, e]));
    this.emps = list.slice(0, 12).map((e, i) => {
      const seat = { tx: cols[i % cols.length], ty: rows[Math.floor(i / cols.length)] };
      for (let dx = -1; dx <= 1; dx++) this.blocked.add(key(seat.tx + dx, seat.ty + 1));
      const look = e.look || { skin: "#f1c9a5", hair: "#3b2a20", hairStyle: "short", top: e.color, bottom: "#2f3548" };
      const old = prev.get(e.id);
      if (old && old.seat.tx === seat.tx && old.seat.ty === seat.ty) {
        Object.assign(old, { name: e.name, role: e.role, color: e.color, look, status: e.status || old.status });
        return old;
      }
      // A brand-new colleague (hired while the office is open) walks in through the entrance.
      const enters = !old && !!entering?.has(e.id);
      const ne = {
        ...e,
        look,
        status: e.status || "idle",
        seat,
        tx: enters ? ENTRANCE.tx : seat.tx, ty: enters ? ROWS : seat.ty,
        x: (enters ? ENTRANCE.tx : seat.tx) * TILE, y: (enters ? ROWS : seat.ty) * TILE,
        dir: enters ? "up" : "down", anim: enters ? "walk" : "sit", path: [], walkDist: 0, spot: null,
        restUntil: performance.now() + rand(5000, 16000),
        bubble: null, unread: 0, seed: i * 977 + 13, sipAt: performance.now() + rand(6000, 20000),
      };
      if (enters) { ne.entering = true; ne.restUntil = 0; }
      return ne;
    });
    for (const e of this.emps) if (e.entering && !e.path.length && !this.atSeat(e)) { this.goTo(e, e.seat.tx, e.seat.ty); this.burst(ENTRANCE.tx * TILE + 16, ENTRANCE.ty * TILE + 16, 40); }
    this.labelsEl.innerHTML = "";
    this.labelEls.clear();
    this.roomEls = ROOMS.map((r) => {
      const el = document.createElement("div");
      el.className = "room-label";
      el.textContent = roomName(this.theme, r.key);
      this.labelsEl.appendChild(el);
      return { r, el };
    });
    for (const e of this.emps) {
      const el = document.createElement("div");
      el.className = "label";
      el.innerHTML = `${e.name}<small>${e.role}</small>`;
      this.labelsEl.appendChild(el);
      this.labelEls.set(e.id, el);
    }
    this.placeRoomLabels();
  }

  placeRoomLabels() {
    for (const { r, el } of this.roomEls) {
      el.style.left = ((r.x0 + r.x1 + 1) / 2) * TILE * this.scale + "px";
      el.style.top = (r.y1 + 1) * TILE * this.scale - 14 * this.scale + "px";
    }
  }

  setStatus(id, status, reason) {
    const e = this.emps.find((x) => x.id === id);
    if (!e || e.status === status) return;
    const prev = e.status;
    e.status = status;
    const now = performance.now();
    if (status === "working" || status === "waiting" || status === "error") {
      e.spot = null;
      e.bubble = null;
      if (!this.atSeat(e)) this.goTo(e, e.seat.tx, e.seat.ty);
    } else if (status === "idle" && reason === "interrupted") {
      e.bubble = null;
      e.restUntil = now + rand(6000, 15000);
    } else if (status === "idle" && (prev === "working" || prev === "waiting")) {
      e.bubble = { kind: "done", until: now + 4000 };
      e.restUntil = now + rand(9000, 22000);
    }
  }

  setUnread(id, n) { const e = this.emps.find((x) => x.id === id); if (e) e.unread = n; }
  setSelected(id) { this.selected = id; }
  setOffline(v) { this.offline = v; }

  portrait(id) {
    const e = this.emps.find((x) => x.id === id);
    return e ? portraitOf(e) : "";
  }

  fit() {
    const stage = this.canvas.parentElement.parentElement;
    const cs = getComputedStyle(stage);
    const cw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const roster = stage.querySelector(".roster");
    const rosterH = roster && getComputedStyle(roster).display !== "none" ? Math.max(roster.offsetHeight, 36) + 14 : 0;
    const ch = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - rosterH;
    const raw = Math.min(cw / LW, ch / LH);
    // 1/16 steps keep pixels crisp; cap at 2.5× for 4K screens, floor at 0.3× for phones
    this.scale = Math.max(0.3, Math.min(2.5, Math.floor(raw * 16) / 16));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(LW * this.scale * dpr);
    this.canvas.height = Math.round(LH * this.scale * dpr);
    this.canvas.style.width = Math.round(LW * this.scale) + "px";
    this.canvas.style.height = Math.round(LH * this.scale) + "px";
    this.ctx.imageSmoothingEnabled = false;
    this.labelsEl.classList.toggle("compact", this.scale < 0.8);
    this.placeRoomLabels();
  }

  // ---------- movement ----------
  atSeat(e) { return e.tx === e.seat.tx && e.ty === e.seat.ty && e.path.length === 0; }

  isBlocked(x, y, self) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return true;
    if (this.blocked.has(key(x, y))) return true;
    for (const o of this.emps) {
      if (o === self) continue;
      if (o.seat.tx === x && o.seat.ty === y) return true;
      if (o.spot && o.spot.tx === x && o.spot.ty === y) return true;
      if (!o.path.length && o.tx === x && o.ty === y) return true;
    }
    return false;
  }

  goToSpot(e, s) {
    if (!s.via) return this.goTo(e, s.tx, s.ty);
    if (e.tx === s.tx && e.ty === s.ty) return true;
    if (!this.goTo(e, s.via[0], s.via[1])) return false;
    e.path.push({ tx: s.tx, ty: s.ty });
    return true;
  }

  goTo(e, tx, ty) {
    const start = key(e.tx, e.ty);
    const goal = key(tx, ty);
    if (start === goal) { e.path = []; return true; }
    const prev = new Map([[start, null]]);
    const queue = [[e.tx, e.ty]];
    while (queue.length) {
      const [cx, cy] = queue.shift();
      if (key(cx, cy) === goal) break;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy, k = key(nx, ny);
        if (prev.has(k) || (this.isBlocked(nx, ny, e) && k !== goal)) continue;
        prev.set(k, key(cx, cy));
        queue.push([nx, ny]);
      }
    }
    if (!prev.has(goal)) return false;
    const path = [];
    for (let k = goal; k !== start; k = prev.get(k)) {
      const [x, y] = k.split(",").map(Number);
      path.push({ tx: x, ty: y });
    }
    e.path = path.reverse();
    return true;
  }

  freeSpot(e) {
    const taken = new Set(this.emps.filter((o) => o !== e && o.spot).map((o) => o.spot.key));
    const options = SPOTS.filter((s) => !taken.has(s.key));
    return options.length ? options[Math.floor(Math.random() * options.length)] : null;
  }

  update(dt, now) {
    if (this.particles.length) {
      for (const p of this.particles) { p.vy += 260 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.98; p.life -= dt; p.rot += p.vr * dt; }
      this.particles = this.particles.filter((p) => p.life > 0 && p.y < LH + 8);
    }
    for (const e of this.emps) {
      if (e.bubble && now > e.bubble.until) e.bubble = null;
      if (e.path.length) {
        const next = e.path[0];
        const gx = next.tx * TILE, gy = next.ty * TILE;
        const dx = gx - e.x, dy = gy - e.y;
        const dist = Math.hypot(dx, dy);
        const step = WALK_SPEED * dt;
        e.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
        if (dist <= step) {
          e.x = gx; e.y = gy; e.tx = next.tx; e.ty = next.ty;
          e.path.shift();
          if (!e.path.length) this.arrived(e, now);
        } else {
          e.x += (dx / dist) * step;
          e.y += (dy / dist) * step;
        }
        e.walkDist += step;
        e.anim = "walk";
        continue;
      }
      if (this.atSeat(e)) {
        e.dir = "down";
        e.anim = e.status === "working" ? "type" : e.status === "waiting" ? "wave" : e.status === "error" ? "slump" : "sit";
        // idle at the desk: now and then pick up the mug and take a sip
        if (e.anim === "sit") {
          if (e.sipping && now - e.sipping < 2600) e.anim = "sip";
          else if (e.sipping) { e.sipping = 0; e.sipAt = now + rand(12000, 32000); }
          else if (now > (e.sipAt ?? 0)) { e.sipping = now; e.anim = "sip"; }
        } else e.sipping = 0;
      } else if (e.spot) {
        e.dir = e.spot.dir;
        e.anim = e.spot.anim;
      } else {
        e.anim = "stand";
      }
      if (e.status === "idle" && now > e.restUntil) this.decideIdle(e, now);
      if (e.status !== "idle" && !this.atSeat(e)) this.goTo(e, e.seat.tx, e.seat.ty);
    }
  }

  arrived(e, now) {
    if (this.atSeat(e)) { e.dir = "down"; e.spot = null; }
    if (e.entering && this.atSeat(e)) { e.entering = false; this.burst(e.x + 16, e.y + 8, 60); e.bubble = { kind: "party", until: now + 4000 }; }
    e.restUntil = now + rand(8000, 20000);
  }

  // Confetti burst at a logical point.
  burst(x, y, n = 40) {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4, sp = 90 + Math.random() * 170;
      this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, life: 1.6 + Math.random() * 1.2, col: CONFETTI[i % CONFETTI.length], w: 2 + Math.floor(Math.random() * 3), h: 2 + Math.floor(Math.random() * 3), rot: Math.random() * 6, vr: (Math.random() - 0.5) * 12 });
    }
  }
  celebrate(id) { const e = this.emps.find((x) => x.id === id); if (e) this.burst(e.x + 16, e.y + 8, 60); }

  decideIdle(e, now) {
    const goSpot = this.atSeat(e) ? Math.random() < 0.6 : Math.random() < 0.45;
    if (goSpot) {
      const s = this.freeSpot(e);
      if (s && this.goToSpot(e, s)) { e.spot = s; return; }
    }
    e.spot = null;
    this.goTo(e, e.seat.tx, e.seat.ty);
    e.restUntil = now + rand(8000, 20000);
  }

  // ---------- input ----------
  toLogical(ev) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / this.scale, y: (ev.clientY - r.top) / this.scale };
  }

  hitTest(ev) {
    const p = this.toLogical(ev);
    let best = null, bestD = 1e9;
    for (const e of this.emps) {
      const cx = e.x + 16, cy = e.y - 4;
      if (p.x >= e.x - 8 && p.x <= e.x + 40 && p.y >= e.y - 36 && p.y <= e.y + 36) {
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (d < bestD) { best = e.id; bestD = d; }
      }
    }
    return best;
  }

  onMove(ev) {
    this.hovered = this.hitTest(ev);
    this.canvas.classList.toggle("hover", !!this.hovered);
  }

  // ---------- render ----------
  start() {
    const loop = (now) => {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.update(dt, now);
      this.draw(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  draw(t) {
    const b = this.b;
    drawFloors(b, this.theme);
    drawWalls(b, this.blocked, this.doors, t, this.theme);
    const items = [];
    for (const d of this.decor) items.push({ y: d.y, draw: () => d.draw(b, t) });
    for (const e of this.emps) {
      const seatFeet = (e.seat.ty + 1) * TILE;
      items.push({ y: seatFeet - 24, draw: () => drawChair(b, e.seat.tx * TILE, seatFeet) });
      items.push({ y: seatFeet + TILE + 6, draw: () => drawDesk(b, e, t) });
      const frame = Math.floor(e.walkDist / 9) % 4;
      const seated = e.anim === "sit" || e.anim === "type" || e.anim === "wave" || e.anim === "slump" || e.anim === "sip";
      const sitFree = e.anim === "sitfree";
      const oy = e.y - 16 + (seated ? 14 : sitFree ? 6 : 0);
      items.push({
        y: e.y + TILE + (seated ? -4 : sitFree ? 4 : 1),
        draw: () => {
          const sel = e.id === this.selected, hov = e.id === this.hovered;
          if (sel || hov) drawRing(b, e.x + 16, e.y + TILE - 2, sel);
          drawPerson(b, e.x, oy, e, { dir: e.dir, anim: e.anim, frame, t, seed: e.seed, sipT: e.sipping ? performance.now() - e.sipping : 0 });
        },
      });
    }
    items.sort((a, c) => a.y - c.y);
    for (const it of items) it.draw();
    const occupied = new Set(this.emps.filter((e) => e.spot && !e.path.length).map((e) => e.spot.key));
    for (const e of this.emps) drawOverhead(b, e, t, occupied);
    for (const p of this.particles) { b.save(); b.translate(p.x, p.y); b.rotate(p.rot); b.globalAlpha = Math.min(1, p.life); b.fillStyle = p.col; b.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); b.restore(); }
    if (this.offline) { b.fillStyle = "rgba(10,12,20,.55)"; b.fillRect(0, 0, LW, LH); }
    this.ctx.drawImage(this.buf, 0, 0, this.canvas.width, this.canvas.height);
    for (const e of this.emps) {
      const el = this.labelEls.get(e.id);
      if (!el) continue;
      el.style.left = (e.x + 16) * this.scale + "px";
      el.style.top = (e.y + TILE + (this.atSeat(e) ? 30 : 2)) * this.scale + "px";
      el.classList.toggle("selected", e.id === this.selected);
    }
  }
}

// ---------- floors & walls ----------
function drawFloors(b, theme = "default") {
  const T = THEMES[theme] || THEMES.default;
  for (const r of ROOMS) {
    const x = r.x0 * TILE, y = r.y0 * TILE, w = (r.x1 - r.x0 + 1) * TILE, h = (r.y1 - r.y0 + 1) * TILE;
    const floor = T.floors[r.key] || r.floor;
    if (floor === "wood") drawWood(b, x, y, w, h);
    else if (floor === "tiles") drawTiles(b, x, y, w, h);
    else if (floor === "carpet") drawCarpet(b, x, y, w, h);
    else if (floor === "turf") drawTurf(b, x, y, w, h);
    else if (floor === "carpetLight") drawCarpetLight(b, x, y, w, h);
    else if (floor === "marble") drawMarble(b, x, y, w, h);
    else if (floor === "stone") drawStone(b, x, y, w, h);
    else if (floor === "darkwood") drawDarkWood(b, x, y, w, h);
    else if (floor === "redcarpet") drawRedCarpet(b, x, y, w, h);
    else if (floor === "cobble") drawCobble(b, x, y, w, h);
    else if (floor === "studioCarpet") drawStudioCarpet(b, x, y, w, h);
    else if (floor === "darkTiles") drawDarkTiles(b, x, y, w, h);
    else if (floor === "sand") drawSand(b, x, y, w, h);
    else if (floor === "checker") drawChecker(b, x, y, w, h);
    else drawConcrete(b, x, y, w, h);
  }
  // door thresholds
  b.fillStyle = "#c9a273";
  for (const [x, y] of [[7, 5], [7, 6], [22, 5], [22, 6], [7, 12], [7, 13], [22, 12], [22, 13], [3, 9], [4, 9], [25, 9], [26, 9]]) b.fillRect(x * TILE, y * TILE, TILE, TILE);
  if (T.rug === "lounge") {
    b.fillStyle = "#7d4a6b"; b.fillRect(8, 11 * TILE + 8, 144, 144);
    b.fillStyle = "#9a5d85"; b.fillRect(14, 11 * TILE + 14, 132, 132);
    b.fillStyle = "#7d4a6b"; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) b.fillRect(28 + i * 30, 11 * TILE + 28 + j * 30, 12, 12);
    b.fillStyle = "#e7c9dd"; for (let i = 0; i < 12; i++) { b.fillRect(16 + i * 11, 11 * TILE + 16, 5, 2); b.fillRect(16 + i * 11, 11 * TILE + 138, 5, 2); }
  } else if (T.rug === "pitch") {
    // mini pitch markings on the lounge turf
    b.fillStyle = "#f4f4f4"; const px = 8, py = 11 * TILE + 8, pw = 144, ph = 144;
    b.fillRect(px, py, pw, 2); b.fillRect(px, py + ph - 2, pw, 2); b.fillRect(px, py, 2, ph); b.fillRect(px + pw - 2, py, 2, ph); b.fillRect(px, py + ph / 2 - 1, pw, 2);
    b.fillRect(px + 40, py, 64, 2); b.fillRect(px + 40, py, 2, 24); b.fillRect(px + 102, py, 2, 24); b.fillRect(px + 40, py + 24, 64, 2);
    b.fillRect(px + 40, py + ph - 26, 64, 2); b.fillRect(px + 40, py + ph - 26, 2, 26); b.fillRect(px + 102, py + ph - 26, 2, 26);
    for (let a = 0; a < 24; a++) b.fillRect(Math.round(px + pw / 2 + Math.cos(a / 24 * Math.PI * 2) * 16) - 1, Math.round(py + ph / 2 + Math.sin(a / 24 * Math.PI * 2) * 16) - 1, 2, 2);
  } else if (T.rug === "gothic") {
    b.fillStyle = "#3a1f28"; b.fillRect(8, 11 * TILE + 8, 144, 144);
    b.fillStyle = "#5a1d24"; b.fillRect(14, 11 * TILE + 14, 132, 132);
    b.fillStyle = "#ffd166"; for (let i = 0; i < 12; i++) { b.fillRect(16 + i * 11, 11 * TILE + 16, 5, 2); b.fillRect(16 + i * 11, 11 * TILE + 138, 5, 2); b.fillRect(16, 11 * TILE + 18 + i * 11, 2, 5); b.fillRect(140, 11 * TILE + 18 + i * 11, 2, 5); }
    b.fillStyle = "#3a1f28"; b.fillRect(60, 11 * TILE + 60, 40, 40); b.fillStyle = "#ffd166"; b.fillRect(78, 11 * TILE + 66, 4, 28); b.fillRect(66, 11 * TILE + 78, 28, 4);
  } else if (T.rug === "compass") {
    drawCompassRug(b, 8, 11 * TILE + 8);
  } else if (T.rug === "vinyl") {
    drawVinylRug(b, 8, 11 * TILE + 8);
  } else if (T.rug === "round") {
    b.fillStyle = "#e9c4d3"; b.fillRect(30, 11 * TILE + 30, 100, 100); b.fillRect(20, 11 * TILE + 46, 120, 68); b.fillRect(46, 11 * TILE + 20, 68, 120);
    b.fillStyle = "#f4dbe5"; b.fillRect(40, 11 * TILE + 40, 80, 80); b.fillRect(32, 11 * TILE + 52, 96, 56); b.fillRect(52, 11 * TILE + 32, 56, 96);
    b.fillStyle = "#e9c4d3"; b.fillRect(70, 11 * TILE + 70, 20, 20);
  }
}

function drawWood(b, x, y, w, h) {
  b.fillStyle = "#c9a273"; b.fillRect(x, y, w, h);
  for (let py = y; py < y + h; py += 16) {
    const row = (py - y) / 16;
    b.fillStyle = row % 2 ? "#c29b6c" : "#cda77a";
    b.fillRect(x, py, w, 16);
    b.fillStyle = "#a9835a";
    b.fillRect(x, py + 15, w, 1);
    const off = (row % 3) * 48;
    for (let px = x - off; px < x + w; px += 144) if (px >= x) b.fillRect(px, py, 1, 16);
    b.fillStyle = "rgba(255,255,255,.08)";
    for (let px = x + 20 + off; px < x + w; px += 144) if (px + 6 < x + w) b.fillRect(px, py + 4, 6, 1);
  }
}

function drawTiles(b, x, y, w, h) {
  for (let py = y; py < y + h; py += 16)
    for (let px = x; px < x + w; px += 16) {
      b.fillStyle = ((px + py) / 16) % 2 ? "#e6e2d8" : "#d4cfc4";
      b.fillRect(px, py, 16, 16);
      b.fillStyle = "#bdb7ab"; b.fillRect(px, py + 15, 16, 1); b.fillRect(px + 15, py, 1, 16);
    }
}

function drawCarpet(b, x, y, w, h) {
  b.fillStyle = "#6c8496"; b.fillRect(x, y, w, h);
  b.fillStyle = "#76909f";
  for (let py = y + 4; py < y + h; py += 8) for (let px = x + ((py / 8) % 2) * 4; px < x + w; px += 8) b.fillRect(px, py, 2, 2);
}

function drawConcrete(b, x, y, w, h) {
  b.fillStyle = "#b9b7b0"; b.fillRect(x, y, w, h);
  b.fillStyle = "#a9a7a0";
  for (let py = y; py < y + h; py += 32) b.fillRect(x, py, w, 1);
  for (let px = x; px < x + w; px += 32) b.fillRect(px, y, 1, h);
  b.fillStyle = "#c4c2bb";
  for (let py = y + 8; py < y + h; py += 32) for (let px = x + 8; px < x + w; px += 32) b.fillRect(px + ((py / 32) % 2) * 9, py, 3, 1);
}

function skyColors() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (h < 5.5 || h >= 20.5) return { top: "#0c1330", bot: "#1f3260", stars: true };
  if (h < 7.5) return { top: "#5a4a8a", bot: "#f2a35e", stars: false };
  if (h < 18) return { top: "#5fb0ea", bot: "#c4e6f8", stars: false };
  return { top: "#3d4a8a", bot: "#f0834d", stars: false };
}

function drawWalls(b, blocked, doors, t, theme = "default") {
  const T = THEMES[theme] || THEMES.default;
  const W = T.wall;
  // top wall face
  b.fillStyle = W.face; b.fillRect(0, 0, LW, 56);
  b.fillStyle = W.top; b.fillRect(0, 0, LW, 3);
  b.fillStyle = W.base; b.fillRect(0, 48, LW, 8);
  b.fillStyle = W.base2; b.fillRect(0, 56, LW, 8);
  b.fillStyle = W.edge; b.fillRect(0, 62, LW, 2);
  // windows with blinds (open office)
  const sky = skyColors();
  for (const wx of [9 * TILE, 17 * TILE]) {
    b.fillStyle = "#eef2f4"; b.fillRect(wx - 4, 4, 104, 48);
    b.fillStyle = "#c9d3d8"; b.fillRect(wx - 4, 50, 104, 3);
    const g = b.createLinearGradient(0, 8, 0, 48);
    g.addColorStop(0, sky.top); g.addColorStop(1, sky.bot);
    b.fillStyle = g; b.fillRect(wx, 8, 96, 40);
    if (sky.stars) {
      b.fillStyle = "#fff8d0";
      for (let i = 0; i < 14; i++) if ((t / 600 + i * 1.7) % 5 < 4) b.fillRect(wx + 4 + ((i * 37) % 90), 10 + ((i * 13) % 30), 1 + (i % 3 === 0 ? 1 : 0), 1);
      b.fillStyle = "#fff3b0"; b.fillRect(wx + 70, 14, 8, 8); b.fillStyle = sky.top; b.fillRect(wx + 74, 12, 8, 8);
    } else {
      // clouds drift across the pane — clipped so they never spill onto the wall
      b.save(); b.beginPath(); b.rect(wx, 8, 96, 40); b.clip();
      b.fillStyle = "rgba(255,255,255,.9)";
      const cx = wx + ((t / 90) % 140) - 40;
      b.fillRect(cx, 18, 22, 6); b.fillRect(cx + 5, 14, 12, 4); b.fillRect(cx + 40, 30, 16, 5); b.fillRect(cx + 44, 27, 8, 3);
      b.restore();
      b.fillStyle = "#3f7f3f"; b.fillRect(wx, 42, 96, 6); b.fillStyle = "#5aa05a"; for (let i = 0; i < 12; i++) b.fillRect(wx + i * 8, 40 + (i % 2), 6, 3);
    }
    b.fillStyle = "#eef2f4"; b.fillRect(wx + 47, 8, 2, 40); b.fillRect(wx, 27, 96, 2);
    b.fillStyle = "rgba(240,240,236,.55)"; for (let i = 0; i < 4; i++) b.fillRect(wx, 9 + i * 4, 96, 2);
  }
  prop(theme, "wallDecor")(b, t);

  // interior walls (top-down): cap + shadow
  for (let y = 2; y < ROWS; y++)
    for (let x = 0; x < COLS; x++) {
      const k = key(x, y);
      const isWall = (x === 7 || x === 22 || (y === 9 && (x <= 6 || x >= 23))) && blocked.has(k) && !doors.has(k);
      if (!isWall) continue;
      const px = x * TILE, py = y * TILE;
      const vertical = x === 7 || x === 22;
      const horizontal = y === 9;
      const wallBelow = blocked.has(key(x, y + 1)) && !doors.has(key(x, y + 1)) && (vertical) && y + 1 < ROWS;
      if (vertical) {
        b.fillStyle = W.innerDark; b.fillRect(px + 7, py, 18, TILE);
        b.fillStyle = W.inner; b.fillRect(px + 8, py, 16, TILE);
        b.fillStyle = W.innerLight; b.fillRect(px + 8, py, 3, TILE);
        b.fillStyle = W.face; b.fillRect(px + 21, py, 3, TILE);
        if (!wallBelow) { b.fillStyle = W.base; b.fillRect(px + 8, py + TILE - 8, 16, 8); b.fillStyle = W.innerDark; b.fillRect(px + 8, py + TILE - 2, 16, 2); }
      }
      if (horizontal) {
        b.fillStyle = W.innerDark; b.fillRect(px, py + 7, TILE, 20);
        b.fillStyle = W.inner; b.fillRect(px, py + 8, TILE, 12);
        b.fillStyle = W.innerLight; b.fillRect(px, py + 8, TILE, 3);
        b.fillStyle = W.base; b.fillRect(px, py + 20, TILE, 6);
        b.fillStyle = W.innerDark; b.fillRect(px, py + 25, TILE, 2);
      }
    }
  // door frames
  for (const [x, y] of [[7, 5], [22, 5], [7, 12], [22, 12]]) {
    b.fillStyle = "#5c3a1e"; b.fillRect(x * TILE + 8, y * TILE - 6, 16, 6); b.fillRect(x * TILE + 8, (y + 2) * TILE, 16, 6);
  }
  for (const [x, y] of [[3, 9], [25, 9]]) {
    b.fillStyle = "#5c3a1e"; b.fillRect(x * TILE - 6, y * TILE + 8, 6, 16); b.fillRect((x + 2) * TILE, y * TILE + 8, 6, 16);
  }
}

function line(b, x0, y0, x1, y1, col) {
  b.strokeStyle = col; b.lineWidth = 2; b.beginPath(); b.moveTo(x0, y0); b.lineTo(x1, y1); b.stroke();
}


function drawWallDecorDefault(b, t) {
  // kitchen wall cabinets
  for (let i = 0; i < 4; i++) {
    const cx = 8 + i * 40;
    b.fillStyle = "#e9e4d8"; b.fillRect(cx, 8, 36, 34);
    b.fillStyle = "#cdc6b6"; b.fillRect(cx, 8, 36, 2); b.fillRect(cx, 40, 36, 2); b.fillRect(cx + 17, 8, 2, 34);
    b.fillStyle = "#5c5c5c"; b.fillRect(cx + 12, 24, 3, 6); b.fillRect(cx + 21, 24, 3, 6);
  }
  // poster + clock + shelf
  b.fillStyle = "#2b2b2b"; b.fillRect(13 * TILE + 4, 10, 30, 38);
  b.fillStyle = "#ffd166"; b.fillRect(13 * TILE + 7, 13, 24, 32);
  b.fillStyle = "#2b2b2b"; b.fillRect(13 * TILE + 12, 20, 14, 12); b.fillRect(13 * TILE + 10, 36, 18, 2); b.fillRect(13 * TILE + 13, 40, 12, 2);
  b.fillStyle = "#ffd166"; b.fillRect(13 * TILE + 16, 24, 6, 4);
  const d = new Date();
  const ccx = 15 * TILE + 16, ccy = 28;
  b.fillStyle = "#2b2b2b"; b.fillRect(ccx - 13, ccy - 13, 26, 26);
  b.fillStyle = "#f7f7f7"; b.fillRect(ccx - 11, ccy - 11, 22, 22);
  b.fillStyle = "#2b2b2b";
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; b.fillRect(ccx + Math.round(Math.cos(a) * 9) - 1, ccy + Math.round(Math.sin(a) * 9) - 1, i % 3 === 0 ? 2 : 1, i % 3 === 0 ? 2 : 1); }
  const ha = ((d.getHours() % 12) + d.getMinutes() / 60) / 12 * Math.PI * 2 - Math.PI / 2;
  const ma = d.getMinutes() / 60 * Math.PI * 2 - Math.PI / 2;
  line(b, ccx, ccy, ccx + Math.cos(ha) * 5, ccy + Math.sin(ha) * 5, "#2b2b2b");
  line(b, ccx, ccy, ccx + Math.cos(ma) * 8, ccy + Math.sin(ma) * 8, "#2b2b2b");
  b.fillStyle = "#d9534f"; b.fillRect(ccx - 1, ccy - 1, 2, 2);
  const shx = 20 * TILE + 12;
  b.fillStyle = "#5c3d22"; b.fillRect(shx - 2, 36, 50, 5);
  b.fillStyle = "#8a5a32"; b.fillRect(shx - 2, 36, 50, 1);
  ["#d9534f", "#3f7cc9", "#ffd166", "#3a9d5d", "#c678dd", "#e07b39"].forEach((c, i) => { b.fillStyle = c; b.fillRect(shx + 2 + i * 7, 14 + (i % 2) * 3, 5, 22 - (i % 2) * 3); b.fillStyle = "rgba(0,0,0,.25)"; b.fillRect(shx + 2 + i * 7, 14 + (i % 2) * 3, 1, 22 - (i % 2) * 3); });
  // meeting TV
  const tx = 24 * TILE + 8;
  b.fillStyle = "#1c1e24"; b.fillRect(tx, 8, 112, 42);
  b.fillStyle = "#0f2a3a"; b.fillRect(tx + 4, 12, 104, 34);
  const bars = [10, 16, 12, 22, 18, 26, 20];
  bars.forEach((h, i) => { b.fillStyle = i === 5 ? "#ffd166" : "#4fc3f7"; b.fillRect(tx + 10 + i * 14, 44 - h, 9, h); });
  b.fillStyle = "#fff"; b.fillRect(tx + 8, 16, 30, 2); b.fillRect(tx + 8, 20, 18, 2);
  b.fillStyle = Math.floor(t / 900) % 2 ? "#4ade80" : "#1c1e24"; b.fillRect(tx + 106, 46, 3, 2);
  // meeting whiteboard (right)
  b.fillStyle = "#c9ced3"; b.fillRect(28 * TILE + 4, 10, 52, 36);
  b.fillStyle = "#fbfbf8"; b.fillRect(28 * TILE + 7, 13, 46, 30);
  b.fillStyle = "#3f7cc9"; b.fillRect(28 * TILE + 11, 18, 30, 2); b.fillRect(28 * TILE + 11, 24, 22, 2);
  b.fillStyle = "#d9534f"; b.fillRect(28 * TILE + 11, 31, 14, 6); b.fillStyle = "#3a9d5d"; b.fillRect(28 * TILE + 30, 30, 18, 8);

}

// ---------- furniture ----------
function outlineRect(b, x, y, w, h, fill) {
  b.fillStyle = OUTLINE; b.fillRect(x - 1, y - 1, w + 2, h + 2);
  b.fillStyle = fill; b.fillRect(x, y, w, h);
}

function drawPlant(b, x, y, kind) {
  if (kind === 2) {
    outlineRect(b, x + 8, y + 12, 16, 18, "#b4593a");
    b.fillStyle = "#d16d47"; b.fillRect(x + 6, y + 10, 20, 4); b.fillStyle = "#8a3f26"; b.fillRect(x + 8, y + 26, 16, 4);
    b.fillStyle = "#2f8f4e"; b.fillRect(x + 12, y - 12, 8, 24); b.fillRect(x + 2, y - 2, 12, 10); b.fillRect(x + 18, y - 6, 12, 12);
    b.fillStyle = "#49b36a"; b.fillRect(x + 14, y - 16, 4, 12); b.fillRect(x + 4, y - 4, 5, 5); b.fillRect(x + 22, y - 8, 5, 5);
    b.fillStyle = "#1f6b38"; b.fillRect(x + 8, y + 6, 6, 4); b.fillRect(x + 20, y + 4, 6, 4);
  } else {
    outlineRect(b, x + 10, y + 16, 12, 12, "#8a6a4a");
    b.fillStyle = "#a8845c"; b.fillRect(x + 9, y + 14, 14, 3);
    b.fillStyle = "#3a9d5d"; b.fillRect(x + 8, y + 2, 16, 12); b.fillRect(x + 12, y - 2, 8, 6);
    b.fillStyle = "#5ac27a"; b.fillRect(x + 10, y + 4, 4, 4); b.fillRect(x + 17, y + 2, 4, 3);
  }
}

function drawKitchenCounter(b, x, y, t) {
  outlineRect(b, x, y + 6, 160, 26, "#d9d4c7");
  b.fillStyle = "#efeae0"; b.fillRect(x, y + 6, 160, 4);
  b.fillStyle = "#8c8578"; b.fillRect(x, y + 30, 160, 2);
  for (let i = 0; i < 5; i++) { b.fillStyle = "#c7c1b3"; b.fillRect(x + i * 32 + 2, y + 14, 28, 16); b.fillStyle = "#5c5c5c"; b.fillRect(x + i * 32 + 13, y + 20, 6, 2); }
  // sink at tile 2
  b.fillStyle = "#9aa3ab"; b.fillRect(x + 66, y + 8, 28, 12);
  b.fillStyle = "#c8d0d6"; b.fillRect(x + 68, y + 10, 24, 8);
  b.fillStyle = "#6f7a84"; b.fillRect(x + 78, y - 2, 3, 10); b.fillRect(x + 78, y - 2, 8, 2);
  // coffee machine at tiles 3-4
  outlineRect(b, x + 104, y - 18, 30, 26, "#3a3a3f");
  b.fillStyle = "#55555c"; b.fillRect(x + 108, y - 14, 22, 6);
  b.fillStyle = Math.floor(t / 700) % 2 ? "#4ade80" : "#1f7a3f"; b.fillRect(x + 108, y - 6, 3, 3);
  b.fillStyle = "#f5f5f5"; b.fillRect(x + 114, y - 2, 10, 8); b.fillStyle = "#6b3e1e"; b.fillRect(x + 116, y, 6, 3);
  if (Math.floor(t / 450) % 2 === 0) { b.fillStyle = "rgba(255,255,255,.6)"; b.fillRect(x + 118, y - 8, 2, 4); b.fillRect(x + 122, y - 11, 2, 5); }
  // toaster / jar at tile 0-1
  outlineRect(b, x + 8, y - 6, 22, 12, "#d94c4c"); b.fillStyle = "#f08a8a"; b.fillRect(x + 10, y - 4, 18, 3);
  outlineRect(b, x + 40, y - 8, 12, 14, "#e8dcc0"); b.fillStyle = "#b58a4a"; b.fillRect(x + 42, y - 2, 8, 6);
}

function drawFridge(b, x, y) {
  outlineRect(b, x + 3, y - 26, 26, 56, "#dfe3e6");
  b.fillStyle = "#c3c9ce"; b.fillRect(x + 3, y - 8, 26, 2); b.fillRect(x + 3, y + 26, 26, 4);
  b.fillStyle = "#f4f6f7"; b.fillRect(x + 5, y - 24, 4, 50);
  b.fillStyle = "#6b7378"; b.fillRect(x + 23, y - 20, 3, 10); b.fillRect(x + 23, y - 4, 3, 18);
  b.fillStyle = "#ffd166"; b.fillRect(x + 8, y - 20, 6, 6); b.fillStyle = "#61afef"; b.fillRect(x + 16, y - 18, 5, 4);
}

function drawRoundTable(b, x, y) {
  b.fillStyle = OUTLINE; b.fillRect(x + 6, y + 2, 52, 26); b.fillRect(x + 2, y + 6, 60, 18);
  b.fillStyle = "#a8734a"; b.fillRect(x + 7, y + 3, 50, 24); b.fillRect(x + 3, y + 7, 58, 16);
  b.fillStyle = "#c58f60"; b.fillRect(x + 7, y + 3, 50, 4); b.fillRect(x + 3, y + 7, 4, 4);
  b.fillStyle = "#7a4d2c"; b.fillRect(x + 7, y + 23, 50, 4);
  b.fillStyle = "#5c3618"; b.fillRect(x + 28, y + 26, 8, 6);
  b.fillStyle = "#f5f5f5"; b.fillRect(x + 14, y + 8, 12, 10); b.fillStyle = "#e07b39"; b.fillRect(x + 16, y + 10, 8, 6);
  b.fillStyle = "#3a9d5d"; b.fillRect(x + 40, y + 6, 10, 8); b.fillStyle = "#b4593a"; b.fillRect(x + 42, y + 14, 6, 5);
}

function drawStool(b, x, y) {
  outlineRect(b, x + 9, y + 14, 14, 8, "#3e4250");
  b.fillStyle = "#5a5f70"; b.fillRect(x + 9, y + 14, 14, 2);
  b.fillStyle = "#2b2e38"; b.fillRect(x + 12, y + 22, 3, 8); b.fillRect(x + 18, y + 22, 3, 8);
}

function drawBin(b, x, y) {
  outlineRect(b, x + 9, y + 8, 14, 20, "#6c7580");
  b.fillStyle = "#8a94a0"; b.fillRect(x + 7, y + 6, 18, 4);
  b.fillStyle = "#4f5761"; b.fillRect(x + 12, y + 12, 2, 12); b.fillRect(x + 18, y + 12, 2, 12);
}

function drawMeetingTable(b, x, y) {
  outlineRect(b, x + 4, y + 4, 120, 48, "#7d5a3c");
  b.fillStyle = "#9c7048"; b.fillRect(x + 4, y + 4, 120, 40);
  b.fillStyle = "#b98a5c"; b.fillRect(x + 4, y + 4, 120, 5);
  b.fillStyle = "#5c3d22"; b.fillRect(x + 4, y + 44, 120, 8);
  b.fillStyle = "#f5f5f5"; for (const [px, py] of [[14, 14], [80, 12], [50, 28]]) { b.fillRect(x + px, y + py, 16, 12); b.fillStyle = "#9aa"; b.fillRect(x + px + 2, y + py + 3, 10, 1); b.fillRect(x + px + 2, y + py + 6, 8, 1); b.fillStyle = "#f5f5f5"; }
  b.fillStyle = "#2b2b2b"; b.fillRect(x + 100, y + 26, 16, 10); b.fillStyle = "#4fc3f7"; b.fillRect(x + 102, y + 28, 12, 6);
  b.fillStyle = "#e8e8e8"; b.fillRect(x + 36, y + 12, 6, 8); b.fillStyle = "#61afef"; b.fillRect(x + 37, y + 14, 4, 4);
}

function drawMeetingChair(b, x, y, dir, layer) {
  if (dir === "down") {
    if (layer === "front") return;
    outlineRect(b, x + 6, y - 2, 20, 12, "#3b4a6b");
    b.fillStyle = "#4f6390"; b.fillRect(x + 6, y - 2, 20, 3);
    outlineRect(b, x + 5, y + 14, 22, 12, "#4a5c86");
    b.fillStyle = "#2b2d3a"; b.fillRect(x + 8, y + 26, 3, 5); b.fillRect(x + 21, y + 26, 3, 5);
  } else if (layer === "back") {
    outlineRect(b, x + 5, y + 12, 22, 12, "#4a5c86");
  } else {
    outlineRect(b, x + 6, y + 22, 20, 12, "#3b4a6b");
    b.fillStyle = "#4f6390"; b.fillRect(x + 6, y + 22, 20, 3);
  }
}

function drawSofa(b, x, y) {
  outlineRect(b, x + 2, y - 10, 92, 18, "#8f5d3a");
  b.fillStyle = "#a86f47"; b.fillRect(x + 2, y - 10, 92, 4);
  outlineRect(b, x, y + 6, 96, 22, "#9c6a44");
  b.fillStyle = "#b07a50"; b.fillRect(x + 6, y + 8, 26, 12); b.fillRect(x + 35, y + 8, 26, 12); b.fillRect(x + 64, y + 8, 26, 12);
  b.fillStyle = "#7a4d2c"; b.fillRect(x, y + 22, 96, 6);
  outlineRect(b, x - 2, y + 2, 8, 24, "#8f5d3a"); outlineRect(b, x + 90, y + 2, 8, 24, "#8f5d3a");
  b.fillStyle = "#ffd166"; b.fillRect(x + 8, y - 6, 12, 10); b.fillStyle = "#61afef"; b.fillRect(x + 76, y - 6, 12, 10);
}

function drawCoffeeTable(b, x, y) {
  outlineRect(b, x + 8, y + 6, 80, 18, "#5c3d22");
  b.fillStyle = "#7d5a3c"; b.fillRect(x + 8, y + 6, 80, 14);
  b.fillStyle = "#9c7048"; b.fillRect(x + 8, y + 6, 80, 3);
  b.fillStyle = "#3a3a3f"; b.fillRect(x + 12, y + 24, 4, 6); b.fillRect(x + 80, y + 24, 4, 6);
  b.fillStyle = "#f5f5f5"; b.fillRect(x + 20, y + 10, 18, 8); b.fillStyle = "#d9534f"; b.fillRect(x + 22, y + 12, 14, 4);
  b.fillStyle = "#e8e8e8"; b.fillRect(x + 56, y + 8, 8, 8); b.fillStyle = "#6b3e1e"; b.fillRect(x + 58, y + 10, 4, 3);
}

function drawBookshelf(b, x, y) {
  outlineRect(b, x + 2, y - 30, 28, 60, "#5c3d22");
  b.fillStyle = "#7d5a3c"; b.fillRect(x + 4, y - 28, 24, 56);
  const cols = ["#d9534f", "#3f7cc9", "#ffd166", "#3a9d5d", "#c678dd", "#e07b39", "#61afef", "#f8f8f2"];
  for (let s = 0; s < 3; s++) {
    b.fillStyle = "#5c3d22"; b.fillRect(x + 4, y - 12 + s * 18 - 2, 24, 2);
    for (let i = 0; i < 5; i++) { b.fillStyle = cols[(s * 5 + i) % cols.length]; b.fillRect(x + 6 + i * 4, y - 26 + s * 18 + (i % 2), 3, 12 - (i % 2)); }
  }
}

function drawLamp(b, x, y, t) {
  b.fillStyle = OUTLINE; b.fillRect(x + 14, y - 30, 4, 56);
  b.fillStyle = "#8a8f99"; b.fillRect(x + 15, y - 29, 2, 54);
  outlineRect(b, x + 8, y + 24, 16, 5, "#5a5f70");
  outlineRect(b, x + 4, y - 44, 24, 16, "#f2d38b");
  b.fillStyle = "#e0b95c"; b.fillRect(x + 4, y - 30, 24, 2);
  b.fillStyle = `rgba(255,220,130,${0.10 + (Math.floor(t / 800) % 2) * 0.03})`; b.fillRect(x - 8, y - 28, 48, 60);
}

function drawCabinets(b, x, y) {
  for (let i = 0; i < 3; i++) {
    const cx = x + i * 32;
    outlineRect(b, cx + 3, y - 22, 26, 52, "#8d949c");
    b.fillStyle = "#a6adb5"; b.fillRect(cx + 3, y - 22, 26, 3);
    for (let d = 0; d < 3; d++) { b.fillStyle = "#6f767e"; b.fillRect(cx + 5, y - 18 + d * 16, 22, 1); b.fillStyle = "#3e444b"; b.fillRect(cx + 12, y - 12 + d * 16, 8, 3); }
  }
}

function drawBoxes(b, x, y) {
  outlineRect(b, x + 4, y + 6, 26, 22, "#c8a06a"); b.fillStyle = "#a7854f"; b.fillRect(x + 4, y + 14, 26, 2); b.fillRect(x + 16, y + 6, 2, 22);
  outlineRect(b, x + 34, y + 10, 24, 18, "#c8a06a"); b.fillStyle = "#a7854f"; b.fillRect(x + 34, y + 18, 24, 2);
  outlineRect(b, x + 12, y - 12, 22, 18, "#d6b27c"); b.fillStyle = "#a7854f"; b.fillRect(x + 12, y - 4, 22, 2);
}

function drawPrinter(b, x, y, t) {
  outlineRect(b, x + 2, y + 8, 60, 22, "#7d5a3c");
  b.fillStyle = "#9c7048"; b.fillRect(x + 2, y + 8, 60, 3);
  outlineRect(b, x + 10, y - 10, 40, 18, "#e6e6e6");
  b.fillStyle = "#c7c7c7"; b.fillRect(x + 10, y - 2, 40, 6);
  b.fillStyle = "#3a3a3f"; b.fillRect(x + 14, y - 6, 20, 2);
  b.fillStyle = Math.floor(t / 600) % 2 ? "#4ade80" : "#2a2a2a"; b.fillRect(x + 42, y - 6, 3, 2);
  b.fillStyle = "#fff"; b.fillRect(x + 18, y - 14 + (Math.floor(t / 300) % 3), 24, 5);
}

function drawCooler(b, x, y) {
  outlineRect(b, x + 8, y + 4, 16, 26, "#dcdcdc");
  b.fillStyle = "#bfbfbf"; b.fillRect(x + 8, y + 24, 16, 6);
  outlineRect(b, x + 9, y - 16, 14, 20, "#e6f2ff");
  b.fillStyle = "#7fc4ff"; b.fillRect(x + 10, y - 10, 12, 13);
  b.fillStyle = "rgba(255,255,255,.5)"; b.fillRect(x + 12, y - 8, 2, 8);
  b.fillStyle = "#3a7bd5"; b.fillRect(x + 11, y + 10, 4, 3); b.fillStyle = "#d33"; b.fillRect(x + 17, y + 10, 4, 3);
}

function drawCoffeeStation(b, x, y, t) {
  outlineRect(b, x + 2, y + 8, 28, 22, "#8a8f99");
  b.fillStyle = "#a4a9b3"; b.fillRect(x + 2, y + 8, 28, 3);
  outlineRect(b, x + 6, y - 8, 20, 18, "#3a3a3f");
  b.fillStyle = "#55555c"; b.fillRect(x + 8, y - 6, 16, 4);
  b.fillStyle = Math.floor(t / 700) % 2 ? "#4ade80" : "#1f7a3f"; b.fillRect(x + 9, y + 2, 2, 2);
  b.fillStyle = "#f5f5f5"; b.fillRect(x + 13, y + 3, 7, 6);
}

function drawChair(b, x, feet) {
  outlineRect(b, x + 3, feet - 34, 26, 16, "#2c2e3d");
  b.fillStyle = "#43465c"; b.fillRect(x + 3, feet - 34, 26, 3); b.fillRect(x + 6, feet - 29, 20, 6);
  outlineRect(b, x + 2, feet - 18, 28, 8, "#343748");
  b.fillStyle = "#2b2d3a"; b.fillRect(x + 14, feet - 10, 4, 8); b.fillRect(x + 6, feet - 3, 20, 3);
}

function drawDesk(b, e, t) {
  const x = (e.seat.tx - 1) * TILE, y = (e.seat.ty + 1) * TILE;
  const status = e.status;
  // feet under the desk (seen through the gap between the desk legs)
  const seated = e.tx === e.seat.tx && e.ty === e.seat.ty && e.path.length === 0;
  if (seated) {
    const L = e.look;
    b.fillStyle = OUTLINE; b.fillRect(x + 36, y + 23, 9, 9); b.fillRect(x + 50, y + 23, 9, 9);
    b.fillStyle = L.bottom || "#2f3548"; b.fillRect(x + 37, y + 24, 7, 3); b.fillRect(x + 51, y + 24, 7, 3);
    b.fillStyle = "#26222a"; b.fillRect(x + 37, y + 27, 7, 4); b.fillRect(x + 51, y + 27, 7, 4);
    b.fillStyle = "#4a4650"; b.fillRect(x + 38, y + 27, 5, 1); b.fillRect(x + 52, y + 27, 5, 1);
    b.fillStyle = "#2b2d3a"; b.fillRect(x + 46, y + 22, 4, 8); b.fillRect(x + 40, y + 29, 16, 2);
  }
  // desk body: top surface, apron, legs (open underneath)
  outlineRect(b, x + 2, y, 92, 22, "#a8734a");
  b.fillStyle = "#c58f60"; b.fillRect(x + 2, y, 92, 4);
  b.fillStyle = "#7a4d2c"; b.fillRect(x + 2, y + 17, 92, 5);
  b.fillStyle = "#5c3618"; b.fillRect(x + 2, y + 21, 92, 1);
  outlineRect(b, x + 4, y + 22, 6, 10, "#5c3618"); outlineRect(b, x + 86, y + 22, 6, 10, "#5c3618");
  b.fillStyle = "#7a4d2c"; b.fillRect(x + 5, y + 22, 2, 9); b.fillRect(x + 87, y + 22, 2, 9);
  // wood grain
  b.fillStyle = "rgba(255,255,255,.08)"; b.fillRect(x + 12, y + 7, 30, 1); b.fillRect(x + 50, y + 12, 24, 1);
  // keyboard + mouse
  outlineRect(b, x + 32, y + 7, 28, 8, "#3b3f4a");
  b.fillStyle = "#6b7080"; for (let r = 0; r < 2; r++) for (let i = 0; i < 8; i++) b.fillRect(x + 34 + i * 3, y + 9 + r * 3, 2, 2);
  outlineRect(b, x + 66, y + 8, 6, 7, "#4a4e5a"); b.fillStyle = "#7a7f8c"; b.fillRect(x + 68, y + 9, 2, 2);
  // monitor
  const mx = x + 58, my = y - 18;
  b.fillStyle = "#2a2d34"; b.fillRect(mx + 11, my + 22, 8, 5); b.fillRect(mx + 5, my + 26, 20, 3);
  outlineRect(b, mx, my, 30, 22, "#2a2d34");
  b.fillStyle = "#3a3e47"; b.fillRect(mx, my, 30, 1);
  const sx = mx + 2, sy = my + 2;
  if (status === "working") {
    b.fillStyle = "#0f2a22"; b.fillRect(sx, sy, 26, 18);
    b.fillStyle = "#5cf2a5";
    const n = 4 + (Math.floor(t / 260) % 4);
    for (let i = 0; i < n; i++) b.fillRect(sx + 2 + (i % 2) * 2, sy + 2 + i * 2, 4 + ((i * 7 + Math.floor(t / 260)) % 16), 1);
    b.fillStyle = "rgba(92,242,165,.16)"; b.fillRect(mx - 6, my + 18, 42, 12);
  } else if (status === "waiting") {
    b.fillStyle = Math.floor(t / 400) % 2 ? "#5a4a10" : "#3a3010"; b.fillRect(sx, sy, 26, 18);
    b.fillStyle = "#ffd166"; b.fillRect(sx + 11, sy + 3, 4, 8); b.fillRect(sx + 11, sy + 13, 4, 3);
  } else if (status === "error") {
    b.fillStyle = "#3a1a1a"; b.fillRect(sx, sy, 26, 18);
    b.fillStyle = "#f87171"; b.fillRect(sx + 7, sy + 5, 2, 2); b.fillRect(sx + 17, sy + 5, 2, 2); b.fillRect(sx + 9, sy + 13, 8, 2);
  } else {
    b.fillStyle = "#1c2433"; b.fillRect(sx, sy, 26, 18);
    b.fillStyle = "#33415c"; b.fillRect(sx + 3, sy + 4, 16, 2); b.fillRect(sx + 3, sy + 8, 10, 2); b.fillRect(sx + 3, sy + 12, 13, 2);
    b.fillStyle = "#4a6a9c"; b.fillRect(sx + 20, sy + 12, 4, 4);
  }
  b.fillStyle = "#ffd166"; b.fillRect(mx + 30, my + 2, 5, 5);
  // mug (in the employee's hand while sipping)
  if (!(seated && e.anim === "sip")) {
    outlineRect(b, x + 10, y + 3, 10, 11, e.color);
    b.fillStyle = "rgba(255,255,255,.35)"; b.fillRect(x + 12, y + 5, 2, 6);
    b.fillStyle = OUTLINE; b.fillRect(x + 20, y + 5, 4, 6); b.fillStyle = e.color; b.fillRect(x + 21, y + 6, 2, 4);
    b.fillStyle = "rgba(255,255,255,.4)"; b.fillRect(x + 13, y - 2 - (Math.floor(t / 400) % 3), 1, 3); b.fillRect(x + 16, y - 1 - (Math.floor((t + 250) / 400) % 3), 1, 2);
  }
  // notebook + pen
  outlineRect(b, x + 22, y + 9, 8, 7, "#f5f5f5"); b.fillStyle = "#9aa"; b.fillRect(x + 24, y + 11, 4, 1); b.fillRect(x + 24, y + 13, 3, 1);
  b.fillStyle = "#3f7cc9"; b.fillRect(x + 12, y + 15, 8, 1);
  if (e.seed % 2) { b.fillStyle = "#3a9d5d"; b.fillRect(x + 78, y + 2, 8, 6); b.fillStyle = "#b4593a"; b.fillRect(x + 79, y + 8, 6, 4); }
}

function drawRing(b, cx, y, strong) {
  b.fillStyle = strong ? "rgba(255,209,102,.45)" : "rgba(255,255,255,.3)";
  b.fillRect(cx - 16, y - 5, 32, 8);
  b.fillStyle = strong ? "#ffd166" : "#fff";
  b.fillRect(cx - 16, y - 5, 32, 2); b.fillRect(cx - 16, y + 1, 32, 2);
}

function drawOverhead(b, e, t, occupied) {
  const cx = e.x + 16;
  let top = e.y - 22;
  const bob = Math.floor(t / 300) % 2 ? -1 : 0;
  const bubble = (w, h, fill) => {
    b.fillStyle = OUTLINE; b.fillRect(cx - w / 2 - 1, top - h - 1 + bob, w + 2, h + 2); b.fillRect(cx - 3, top + bob, 6, 3);
    b.fillStyle = fill; b.fillRect(cx - w / 2, top - h + bob, w, h); b.fillRect(cx - 2, top + bob, 4, 2);
  };
  if (e.unread > 0) {
    const y0 = top - 22 + bob;
    b.fillStyle = OUTLINE; b.fillRect(cx - 12, y0 - 1, 24, 18);
    b.fillStyle = "#fff"; b.fillRect(cx - 11, y0, 22, 16);
    b.fillStyle = "#e06c75"; b.fillRect(cx - 9, y0 + 2, 18, 12);
    b.fillStyle = "#fff"; for (let i = 0; i < 6; i++) b.fillRect(cx - 8 + i, y0 + 3 + i, 1, 1), b.fillRect(cx + 7 - i, y0 + 3 + i, 1, 1);
    top = y0 - 4;
  }
  if (e.status === "working" && (e.anim === "type" || e.anim === "walk")) {
    bubble(28, 16, "#fff");
    b.fillStyle = "#2b2b2b";
    const n = Math.floor(t / 350) % 4;
    for (let i = 0; i < 3; i++) b.fillRect(cx - 10 + i * 8, top - 10 + bob + (i < n ? -2 : 0), 4, 4);
  } else if (e.status === "waiting") {
    bubble(20, 18, "#ffd166");
    b.fillStyle = "#3a2a00"; b.fillRect(cx - 2, top - 15 + bob, 4, 8); b.fillRect(cx - 2, top - 5 + bob, 4, 3);
  } else if (e.status === "error") {
    bubble(20, 18, "#f87171");
    b.fillStyle = "#3a0000";
    for (let i = 0; i < 8; i++) { b.fillRect(cx - 4 + i, top - 15 + bob + i, 2, 2); b.fillRect(cx + 3 - i, top - 15 + bob + i, 2, 2); }
  } else if (e.bubble?.kind === "party") {
    bubble(24, 18, "#fff");
    // tiny party popper: cone + sparks
    b.fillStyle = "#ffd166"; for (let i = 0; i < 6; i++) b.fillRect(cx - 8 + i, top - 6 + bob - i, 2, 2);
    b.fillStyle = "#ff3b3b"; b.fillRect(cx + 2, top - 15 + bob, 2, 2); b.fillStyle = "#4ade80"; b.fillRect(cx + 6, top - 12 + bob, 2, 2); b.fillStyle = "#61afef"; b.fillRect(cx + 4, top - 8 + bob, 2, 2); b.fillStyle = "#c678dd"; b.fillRect(cx - 1, top - 14 + bob, 2, 2);
  } else if (e.bubble?.kind === "done") {
    bubble(20, 18, "#4ade80");
    b.fillStyle = "#0b3a1e";
    for (let i = 0; i < 4; i++) b.fillRect(cx - 7 + i, top - 11 + bob + i, 2, 2);
    for (let i = 0; i < 7; i++) b.fillRect(cx - 3 + i, top - 8 + bob - i, 2, 2);
  } else if (e.anim === "chat" || (e.anim === "sitfree" && e.spot && (e.spot.key.startsWith("meet") || e.spot.key.startsWith("sofa") || e.spot.key.startsWith("stool")))) {
    const group = e.spot.key.replace(/[A-Z]$/, "");
    const others = [...occupied].filter((k) => k !== e.spot.key && k.replace(/[A-Z]$/, "") === group);
    if (others.length) {
      const phase = Math.floor(t / 1500 + e.seed) % 3 === 0;
      if (phase) { bubble(24, 12, "#fff"); b.fillStyle = "#2b2b2b"; for (let i = 0; i < 3; i++) b.fillRect(cx - 8 + i * 6, top - 8 + bob, 3, 3); }
    }
  } else if (e.anim === "think") {
    if (Math.floor(t / 900) % 3 === 0) { b.fillStyle = OUTLINE; b.fillRect(cx + 9, top - 7 + bob, 5, 5); b.fillRect(cx + 15, top - 15 + bob, 7, 7); b.fillStyle = "#fff"; b.fillRect(cx + 10, top - 6 + bob, 3, 3); b.fillRect(cx + 16, top - 14 + bob, 5, 5); }
  }
}

// ---------- themes ----------
// Same room layout and walkable tiles for every theme; only palette, floors, wall decor and props change.
const THEMES = {
  default: { wall: { face: "#6f8896", top: "#7f98a6", base: "#5c7280", base2: "#43545f", edge: "#39474f", inner: "#8ea3b0", innerLight: "#a9bcc7", innerDark: "#3f4f5a" }, floors: { kitchen: "tiles", office: "wood", meeting: "carpet", lounge: "wood", archive: "concrete" }, rug: "lounge" },
  football: { wall: { face: "#2f6b45", top: "#3f8a5a", base: "#25553a", base2: "#1c412c", edge: "#142f20", inner: "#4f7f62", innerLight: "#6c9c7e", innerDark: "#223d2d" }, floors: { kitchen: "tiles", office: "wood", meeting: "turf", lounge: "turf", archive: "concrete" }, rug: "pitch" },
  fashion: { wall: { face: "#e6cfc8", top: "#f2e2dd", base: "#cfb0a8", base2: "#b8968e", edge: "#9f7f78", inner: "#d9bdb6", innerLight: "#ecd6d0", innerDark: "#8f6f68" }, floors: { kitchen: "tiles", office: "wood", meeting: "carpetLight", lounge: "marble", archive: "wood" }, rug: "round" },
};
const THEME_NAMES = Object.keys(THEMES);

function drawTurf(b, x, y, w, h) {
  for (let py = y; py < y + h; py += 16) { b.fillStyle = ((py - y) / 16) % 2 ? "#3f8f4f" : "#47a058"; b.fillRect(x, py, w, 16); }
  b.fillStyle = "rgba(255,255,255,.12)"; for (let px = x + 6; px < x + w; px += 24) for (let py = y + 4; py < y + h; py += 12) b.fillRect(px + ((py / 12) % 2) * 6, py, 2, 1);
}
function drawCarpetLight(b, x, y, w, h) {
  b.fillStyle = "#d6cfc9"; b.fillRect(x, y, w, h);
  b.fillStyle = "#cbc3bc"; for (let py = y + 4; py < y + h; py += 8) for (let px = x + ((py / 8) % 2) * 4; px < x + w; px += 8) b.fillRect(px, py, 2, 2);
}
function drawMarble(b, x, y, w, h) {
  for (let py = y; py < y + h; py += 32) for (let px = x; px < x + w; px += 32) {
    b.fillStyle = ((px + py) / 32) % 2 ? "#f1ece6" : "#e8e1da"; b.fillRect(px, py, 32, 32);
    b.fillStyle = "#d8d0c8"; b.fillRect(px, py + 31, 32, 1); b.fillRect(px + 31, py, 1, 32);
    b.fillStyle = "rgba(160,150,140,.25)"; b.fillRect(px + 6, py + 10, 12, 1); b.fillRect(px + 17, py + 11, 8, 1); b.fillRect(px + 20, py + 22, 7, 1);
  }
}

// --- football props ---
function fbBall(b, x, y, r = 5) {
  b.fillStyle = OUTLINE; b.fillRect(x - r, y - r + 1, 2 * r, 2 * r - 2); b.fillRect(x - r + 1, y - r, 2 * r - 2, 2 * r);
  b.fillStyle = "#f4f4f4"; b.fillRect(x - r + 1, y - r + 2, 2 * r - 2, 2 * r - 4); b.fillRect(x - r + 2, y - r + 1, 2 * r - 4, 2 * r - 2);
  b.fillStyle = "#1c1a20"; b.fillRect(x - 1, y - 1, 2, 2); b.fillRect(x - r + 2, y - 2, 1, 1); b.fillRect(x + r - 3, y - 2, 1, 1); b.fillRect(x - 2, y + r - 3, 1, 1); b.fillRect(x + 1, y + r - 3, 1, 1);
}
function drawSnackBar(b, x, y, t) {
  outlineRect(b, x, y + 6, 160, 26, "#2f6b45");
  b.fillStyle = "#3f8a5a"; b.fillRect(x, y + 6, 160, 4);
  b.fillStyle = "#1c412c"; b.fillRect(x, y + 30, 160, 2);
  b.fillStyle = "#f4f4f4"; for (let i = 0; i < 5; i++) b.fillRect(x + i * 32 + 4, y + 16, 24, 2);
  // popcorn box
  outlineRect(b, x + 8, y - 8, 14, 14, "#f4f4f4"); b.fillStyle = "#d9534f"; for (let i = 0; i < 3; i++) b.fillRect(x + 9 + i * 5, y - 7, 2, 12);
  b.fillStyle = "#fff3b0"; b.fillRect(x + 7, y - 12, 16, 5); b.fillStyle = "#e8d48a"; b.fillRect(x + 9, y - 14, 4, 2); b.fillRect(x + 16, y - 13, 5, 2);
  // soda cups
  for (let i = 0; i < 2; i++) { outlineRect(b, x + 40 + i * 14, y - 6, 10, 12, "#d9534f"); b.fillStyle = "#f4f4f4"; b.fillRect(x + 42 + i * 14, y - 4, 6, 3); b.fillStyle = "#1c1a20"; b.fillRect(x + 44 + i * 14, y - 12, 1, 6); }
  // soda fountain
  outlineRect(b, x + 104, y - 18, 30, 26, "#2b2d3a"); b.fillStyle = "#3f4a5c"; b.fillRect(x + 108, y - 14, 22, 8);
  for (let i = 0; i < 3; i++) { b.fillStyle = ["#d9534f", "#ffd166", "#61afef"][i]; b.fillRect(x + 109 + i * 7, y - 12, 5, 4); }
  b.fillStyle = "#6c7080"; b.fillRect(x + 110, y - 4, 18, 2); b.fillStyle = "#f4f4f4"; b.fillRect(x + 114, y, 10, 7);
  if (Math.floor(t / 500) % 2) { b.fillStyle = "#61afef"; b.fillRect(x + 118, y - 4, 2, 4); }
  fbBall(b, x + 146, y + 2, 5);
}
function drawVending(b, x, y) {
  outlineRect(b, x + 3, y - 26, 26, 56, "#2c4f9e");
  b.fillStyle = "#1c2b55"; b.fillRect(x + 6, y - 22, 20, 30);
  for (let r = 0; r < 3; r++) for (let i = 0; i < 3; i++) { b.fillStyle = ["#d9534f", "#ffd166", "#4ade80", "#61afef"][(r + i) % 4]; b.fillRect(x + 8 + i * 6, y - 20 + r * 9, 4, 7); }
  b.fillStyle = "#4a6ad0"; b.fillRect(x + 3, y - 26, 26, 3); b.fillStyle = "#f4f4f4"; b.fillRect(x + 8, y + 12, 16, 3); b.fillStyle = "#1c1a20"; b.fillRect(x + 10, y + 20, 12, 6);
}
function drawBallTable(b, x, y) { drawRoundTable(b, x, y); b.fillStyle = "#a8734a"; b.fillRect(x + 12, y + 6, 40, 14); fbBall(b, x + 32, y + 12, 6); }
function drawTacticsTable(b, x, y) {
  outlineRect(b, x + 4, y + 4, 120, 48, "#3f8f4f");
  b.fillStyle = "#47a058"; b.fillRect(x + 4, y + 4, 120, 40); b.fillStyle = "#2f7a40"; b.fillRect(x + 4, y + 44, 120, 8);
  b.fillStyle = "#f4f4f4"; b.fillRect(x + 8, y + 8, 112, 1); b.fillRect(x + 8, y + 39, 112, 1); b.fillRect(x + 8, y + 8, 1, 32); b.fillRect(x + 119, y + 8, 1, 32); b.fillRect(x + 63, y + 8, 1, 32);
  b.fillRect(x + 8, y + 16, 12, 1); b.fillRect(x + 8, y + 31, 12, 1); b.fillRect(x + 20, y + 16, 1, 16); b.fillRect(x + 108, y + 16, 12, 1); b.fillRect(x + 108, y + 31, 12, 1); b.fillRect(x + 107, y + 16, 1, 16);
  b.fillRect(x + 60, y + 21, 7, 1); b.fillRect(x + 60, y + 27, 7, 1); b.fillRect(x + 58, y + 22, 1, 5); b.fillRect(x + 68, y + 22, 1, 5);
  for (const [px, py, c] of [[28, 14, "#d9534f"], [40, 24, "#d9534f"], [30, 34, "#d9534f"], [84, 12, "#61afef"], [96, 26, "#61afef"], [86, 34, "#61afef"]]) { b.fillStyle = OUTLINE; b.fillRect(x + px - 1, y + py - 1, 6, 6); b.fillStyle = c; b.fillRect(x + px, y + py, 4, 4); }
  fbBall(b, x + 64, y + 24, 3);
}
function drawBench(b, x, y) {
  outlineRect(b, x + 2, y - 8, 92, 8, "#6c7080");
  for (let i = 0; i < 3; i++) { outlineRect(b, x + 6 + i * 30, y - 10, 24, 16, "#2c62c9"); b.fillStyle = "#4a86e8"; b.fillRect(x + 6 + i * 30, y - 10, 24, 3); outlineRect(b, x + 5 + i * 30, y + 8, 26, 14, "#2c62c9"); b.fillStyle = "#1f4aa0"; b.fillRect(x + 5 + i * 30, y + 18, 26, 4); }
  b.fillStyle = "#4a4d59"; b.fillRect(x + 8, y + 22, 4, 8); b.fillRect(x + 84, y + 22, 4, 8); b.fillRect(x + 2, y + 27, 92, 3);
}
function drawBallRack(b, x, y) {
  outlineRect(b, x + 8, y + 12, 80, 4, "#6c7080"); b.fillStyle = "#4a4d59"; b.fillRect(x + 12, y + 16, 3, 12); b.fillRect(x + 81, y + 16, 3, 12);
  for (let i = 0; i < 3; i++) fbBall(b, x + 24 + i * 24, y + 6, 6);
}
function drawTrophyCase(b, x, y) {
  outlineRect(b, x + 2, y - 30, 28, 60, "#2b2d3a"); b.fillStyle = "#1c2433"; b.fillRect(x + 4, y - 28, 24, 56);
  b.fillStyle = "rgba(120,180,255,.18)"; b.fillRect(x + 4, y - 28, 24, 56);
  for (let s = 0; s < 3; s++) { const sy = y - 24 + s * 18; b.fillStyle = "#3a3f4a"; b.fillRect(x + 4, sy + 14, 24, 2); b.fillStyle = "#ffd166"; b.fillRect(x + 12, sy, 8, 6); b.fillRect(x + 14, sy + 6, 4, 4); b.fillRect(x + 11, sy + 10, 10, 3); b.fillStyle = "#e0a93a"; b.fillRect(x + 9, sy + 1, 2, 3); b.fillRect(x + 21, sy + 1, 2, 3); b.fillStyle = "#fff3b0"; b.fillRect(x + 13, sy + 1, 2, 2); }
}
function drawFloodlight(b, x, y, t) {
  b.fillStyle = OUTLINE; b.fillRect(x + 14, y - 34, 4, 60); b.fillStyle = "#8a8f99"; b.fillRect(x + 15, y - 33, 2, 58);
  outlineRect(b, x + 8, y + 24, 16, 5, "#5a5f70");
  outlineRect(b, x + 2, y - 46, 28, 14, "#3a3f4a"); for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { b.fillStyle = "#fff3b0"; b.fillRect(x + 5 + i * 8, y - 44 + j * 6, 6, 4); }
  b.fillStyle = `rgba(255,240,180,${0.10 + (Math.floor(t / 800) % 2) * 0.03})`; b.fillRect(x - 10, y - 30, 52, 62);
}
function drawLockers(b, x, y) {
  for (let i = 0; i < 3; i++) { const cx = x + i * 32; outlineRect(b, cx + 3, y - 22, 26, 52, i % 2 ? "#d9534f" : "#2c62c9"); b.fillStyle = "rgba(255,255,255,.18)"; b.fillRect(cx + 3, y - 22, 26, 3); b.fillStyle = OUTLINE; for (let v = 0; v < 3; v++) b.fillRect(cx + 9, y - 16 + v * 3, 14, 1); b.fillStyle = "#f4f4f4"; b.fillRect(cx + 22, y + 4, 3, 8); b.fillStyle = OUTLINE; b.fillRect(cx + 3, y + 8, 26, 1); }
}
function drawCones(b, x, y) {
  for (let i = 0; i < 3; i++) { const cx = x + 6 + i * 18, cy = y + 6; b.fillStyle = OUTLINE; b.fillRect(cx, cy + 14, 14, 4); b.fillRect(cx + 3, cy, 8, 15); b.fillStyle = "#fb923c"; b.fillRect(cx + 4, cy + 1, 6, 13); b.fillStyle = "#f4f4f4"; b.fillRect(cx + 4, cy + 6, 6, 2); b.fillStyle = "#e07b2a"; b.fillRect(cx + 1, cy + 15, 12, 2); }
  outlineRect(b, x + 4, y - 12, 30, 16, "#2b2d3a"); b.fillStyle = "#3f4a5c"; b.fillRect(x + 6, y - 10, 26, 4); fbBall(b, x + 14, y - 4, 3); fbBall(b, x + 25, y - 4, 3);
}
function drawJerseyRack(b, x, y) {
  outlineRect(b, x + 2, y - 12, 60, 3, "#6c7080"); b.fillStyle = "#4a4d59"; b.fillRect(x + 4, y - 9, 3, 38); b.fillRect(x + 57, y - 9, 3, 38);
  const cols = ["#d9534f", "#f4f4f4", "#2c62c9"];
  for (let i = 0; i < 3; i++) { const jx = x + 10 + i * 17; b.fillStyle = OUTLINE; b.fillRect(jx + 5, y - 9, 2, 3); outlineRect(b, jx, y - 6, 12, 16, cols[i]); b.fillStyle = cols[i]; b.fillRect(jx - 2, y - 5, 2, 5); b.fillRect(jx + 12, y - 5, 2, 5); b.fillStyle = i === 1 ? "#1c1a20" : "#f4f4f4"; b.fillRect(jx + 4, y - 1, 2, 5); b.fillRect(jx + 7, y - 1, 2, 5); }
}
function drawBottleCrate(b, x, y) {
  outlineRect(b, x + 5, y + 8, 22, 20, "#2c62c9"); b.fillStyle = "#1f4aa0"; b.fillRect(x + 5, y + 20, 22, 8);
  for (let i = 0; i < 4; i++) { b.fillStyle = "#c9e8ff"; b.fillRect(x + 7 + i * 5, y - 2, 4, 12); b.fillStyle = "#61afef"; b.fillRect(x + 8 + i * 5, y - 5, 2, 3); }
}
function drawDrinksCooler(b, x, y, t) { outlineRect(b, x + 4, y + 4, 24, 24, "#2c62c9"); b.fillStyle = "#4a86e8"; b.fillRect(x + 4, y + 4, 24, 5); b.fillStyle = "#f4f4f4"; b.fillRect(x + 8, y + 14, 16, 3); if (Math.floor(t / 900) % 2) { b.fillStyle = "#c9e8ff"; b.fillRect(x + 10, y + 20, 4, 4); } }
function drawWallDecorFootball(b, t) {
  // scoreboard
  const sx = 24 * TILE + 8; outlineRect(b, sx, 8, 112, 42, "#1c1e24");
  b.fillStyle = "#0a0c10"; b.fillRect(sx + 4, 12, 104, 34);
  const led = (x, y, digit) => { const seg = { 0: [1,1,1,1,1,1,0], 1: [0,1,1,0,0,0,0], 2: [1,1,0,1,1,0,1], 3: [1,1,1,1,0,0,1] }[digit]; b.fillStyle = "#ff3b3b"; if (seg[0]) b.fillRect(x + 1, y, 6, 2); if (seg[1]) b.fillRect(x + 6, y + 1, 2, 6); if (seg[2]) b.fillRect(x + 6, y + 8, 2, 6); if (seg[3]) b.fillRect(x + 1, y + 13, 6, 2); if (seg[4]) b.fillRect(x, y + 8, 2, 6); if (seg[5]) b.fillRect(x, y + 1, 2, 6); if (seg[6]) b.fillRect(x + 1, y + 7, 6, 2); };
  led(sx + 30, 22, 2); led(sx + 74, 22, 1); b.fillStyle = "#ff3b3b"; b.fillRect(sx + 54, 26, 3, 3); b.fillRect(sx + 54, 33, 3, 3);
  b.fillStyle = "#ffd166"; b.fillRect(sx + 10, 14, 24, 3); b.fillRect(sx + 78, 14, 24, 3);
  b.fillStyle = Math.floor(t / 1000) % 2 ? "#4ade80" : "#0a0c10"; b.fillRect(sx + 48, 40, 16, 3);
  // pennant string across the open office
  b.fillStyle = "#f4f4f4"; b.fillRect(8 * TILE, 6, 14 * TILE, 1);
  const cols = ["#d9534f", "#ffd166", "#2c62c9", "#f4f4f4", "#4ade80"];
  for (let i = 0; i < 14; i++) { const px = 8 * TILE + 8 + i * 32; b.fillStyle = cols[i % cols.length]; b.fillRect(px, 7, 12, 4); b.fillRect(px + 2, 11, 8, 4); b.fillRect(px + 4, 15, 4, 3); }
  // framed jersey
  outlineRect(b, 13 * TILE + 2, 12, 36, 36, "#3a3f4a"); b.fillStyle = "#f4f4f4"; b.fillRect(13 * TILE + 8, 20, 24, 22); b.fillRect(13 * TILE + 4, 22, 5, 8); b.fillRect(13 * TILE + 31, 22, 5, 8); b.fillStyle = "#d9534f"; b.fillRect(13 * TILE + 8, 20, 24, 3);
  b.fillStyle = "#1c1a20"; b.fillRect(13 * TILE + 14, 28, 2, 10); b.fillRect(13 * TILE + 19, 28, 2, 10); b.fillRect(13 * TILE + 21, 28, 5, 2); b.fillRect(13 * TILE + 21, 36, 5, 2); b.fillRect(13 * TILE + 25, 28, 2, 10);
  // trophy shelf + clock
  b.fillStyle = "#5c3d22"; b.fillRect(20 * TILE + 10, 40, 52, 4);
  for (let i = 0; i < 3; i++) { const tx = 20 * TILE + 14 + i * 17; b.fillStyle = i === 1 ? "#ffd166" : "#c0c0c0"; b.fillRect(tx, 14 + (i === 1 ? -4 : 0), 10, 10); b.fillRect(tx + 3, 24, 4, 8); b.fillRect(tx + 1, 32, 8, 4); b.fillStyle = "#fff3b0"; b.fillRect(tx + 2, 16 + (i === 1 ? -4 : 0), 2, 3); }
  drawClock(b, 15 * TILE + 16, 28);
  // kitchen wall: GOL banner
  outlineRect(b, 16, 10, 150, 30, "#d9534f"); b.fillStyle = "#f4f4f4"; for (const [gx, gw] of [[40, 18], [70, 18], [100, 18]]) b.fillRect(gx, 16, gw, 18); b.fillStyle = "#d9534f"; b.fillRect(45, 21, 8, 8); b.fillRect(75, 21, 8, 8); b.fillRect(105, 16, 13, 12); b.fillRect(100, 21, 6, 8);
  // meeting whiteboard: pitch diagram
  b.fillStyle = "#c9ced3"; b.fillRect(28 * TILE + 4, 10, 52, 36); b.fillStyle = "#fbfbf8"; b.fillRect(28 * TILE + 7, 13, 46, 30);
  b.fillStyle = "#3a9d5d"; b.fillRect(28 * TILE + 10, 16, 40, 24); b.fillStyle = "#fbfbf8"; b.fillRect(28 * TILE + 29, 16, 1, 24); b.fillStyle = "#d9534f"; b.fillRect(28 * TILE + 14, 22, 3, 3); b.fillRect(28 * TILE + 20, 30, 3, 3); b.fillStyle = "#2c62c9"; b.fillRect(28 * TILE + 38, 20, 3, 3); b.fillRect(28 * TILE + 42, 32, 3, 3);
}

// --- fashion props ---
function drawCuttingTable(b, x, y, t) {
  outlineRect(b, x, y + 6, 160, 26, "#c9a781"); b.fillStyle = "#dcbf9a"; b.fillRect(x, y + 6, 160, 4); b.fillStyle = "#a8865f"; b.fillRect(x, y + 30, 160, 2);
  // fabric bolt + scissors
  outlineRect(b, x + 6, y - 4, 40, 12, "#c678dd"); b.fillStyle = "#d99cf0"; b.fillRect(x + 6, y - 4, 40, 3); b.fillStyle = "#a45cc0"; for (let i = 0; i < 4; i++) b.fillRect(x + 10 + i * 10, y, 2, 6);
  b.fillStyle = "#8a8f99"; b.fillRect(x + 54, y - 2, 12, 2); b.fillRect(x + 54, y + 2, 12, 2); b.fillStyle = "#d9534f"; b.fillRect(x + 64, y - 3, 6, 3); b.fillRect(x + 64, y + 3, 6, 3);
  // sewing machine
  outlineRect(b, x + 96, y - 12, 44, 8, "#f4f4f4"); outlineRect(b, x + 100, y - 20, 30, 10, "#1c1a20"); b.fillStyle = "#3a3a3f"; b.fillRect(x + 102, y - 18, 26, 3);
  outlineRect(b, x + 122, y - 12, 10, 12, "#1c1a20"); b.fillStyle = "#c0c0c0"; b.fillRect(x + 126, y - 2, 2, 5); b.fillStyle = "#ffd166"; b.fillRect(x + 104, y - 16, 4, 4);
  b.fillStyle = "#c678dd"; b.fillRect(x + 106, y - 4, 14, 6); if (Math.floor(t / 300) % 2) { b.fillStyle = "#c0c0c0"; b.fillRect(x + 126, y - 4, 2, 2); }
}
function drawMannequin(b, x, y, top = "#f4e9df") {
  outlineRect(b, x + 10, y + 22, 12, 4, "#5c3d22"); b.fillStyle = OUTLINE; b.fillRect(x + 15, y + 4, 2, 20); b.fillStyle = "#8a5a32"; b.fillRect(x + 15, y + 6, 1, 17);
  outlineRect(b, x + 9, y - 20, 14, 24, top); b.fillStyle = shade(top, -20); b.fillRect(x + 9, y - 6, 14, 2); b.fillRect(x + 20, y - 18, 3, 12); b.fillStyle = OUTLINE; b.fillRect(x + 13, y - 24, 6, 4); b.fillStyle = "#c9a781"; b.fillRect(x + 14, y - 23, 4, 2);
}
function drawSwatchTable(b, x, y) { drawRoundTable(b, x, y); b.fillStyle = "#a8734a"; b.fillRect(x + 12, y + 6, 40, 14); ["#e06c75", "#61afef", "#98c379", "#c678dd", "#ffd166"].forEach((c, i) => { b.fillStyle = OUTLINE; b.fillRect(x + 13 + i * 8, y + 7, 8, 12); b.fillStyle = c; b.fillRect(x + 14 + i * 8, y + 8, 6, 10); }); }
function drawDesignTable(b, x, y) {
  outlineRect(b, x + 4, y + 4, 120, 48, "#f4f4f4"); b.fillStyle = "#e9e4de"; b.fillRect(x + 4, y + 44, 120, 8); b.fillStyle = "#fbfbf8"; b.fillRect(x + 4, y + 4, 120, 4);
  // sketch sheets with dress silhouettes
  for (const px of [14, 48]) { b.fillStyle = "#fbfbf8"; b.fillRect(x + px, y + 12, 24, 26); b.fillStyle = "#d8d0c8"; b.fillRect(x + px, y + 37, 24, 1); b.fillStyle = "#6b7280"; b.fillRect(x + px + 10, y + 15, 4, 4); b.fillRect(x + px + 8, y + 19, 8, 6); b.fillRect(x + px + 6, y + 25, 12, 8); }
  // colour chips + pencils
  ["#e06c75", "#f78fb3", "#c678dd", "#61afef", "#ffd166", "#98c379"].forEach((c, i) => { b.fillStyle = OUTLINE; b.fillRect(x + 84 + (i % 3) * 11, y + 12 + Math.floor(i / 3) * 11, 10, 10); b.fillStyle = c; b.fillRect(x + 85 + (i % 3) * 11, y + 13 + Math.floor(i / 3) * 11, 8, 8); });
  b.fillStyle = "#ffd166"; b.fillRect(x + 84, y + 36, 24, 2); b.fillStyle = "#d9534f"; b.fillRect(x + 88, y + 39, 24, 2); b.fillStyle = "#1c1a20"; b.fillRect(x + 106, y + 36, 3, 2); b.fillRect(x + 110, y + 39, 3, 2);
}
function drawVelvetSofa(b, x, y) {
  outlineRect(b, x + 2, y - 10, 92, 18, "#c95c86"); b.fillStyle = "#e07aa4"; b.fillRect(x + 2, y - 10, 92, 4);
  outlineRect(b, x, y + 6, 96, 22, "#d16a95"); b.fillStyle = "#e28ab0"; b.fillRect(x + 6, y + 8, 26, 12); b.fillRect(x + 35, y + 8, 26, 12); b.fillRect(x + 64, y + 8, 26, 12);
  b.fillStyle = "#b04d78"; b.fillRect(x, y + 22, 96, 6); outlineRect(b, x - 2, y + 2, 8, 24, "#c95c86"); outlineRect(b, x + 90, y + 2, 8, 24, "#c95c86");
  b.fillStyle = "#ffd166"; b.fillRect(x + 6, y + 28, 4, 3); b.fillRect(x + 86, y + 28, 4, 3); b.fillStyle = "#fff"; b.fillRect(x + 8, y - 6, 12, 10); b.fillStyle = "#ffd166"; b.fillRect(x + 76, y - 6, 12, 10);
}
function drawShoeDisplay(b, x, y) {
  outlineRect(b, x + 8, y + 6, 80, 4, "#f4f4f4"); outlineRect(b, x + 8, y + 20, 80, 4, "#f4f4f4"); b.fillStyle = "#e9e4de"; b.fillRect(x + 10, y + 10, 3, 10); b.fillRect(x + 83, y + 10, 3, 10);
  const shoe = (sx, sy, c, heel) => { b.fillStyle = OUTLINE; b.fillRect(sx - 1, sy - 1, 14, 6); b.fillStyle = c; b.fillRect(sx, sy, 12, 4); if (heel) { b.fillStyle = OUTLINE; b.fillRect(sx, sy + 4, 3, 3); b.fillStyle = c; b.fillRect(sx + 1, sy + 4, 1, 2); } else { b.fillStyle = "#f4f4f4"; b.fillRect(sx, sy + 3, 12, 1); } };
  shoe(x + 16, y, "#d9534f", true); shoe(x + 40, y, "#1c1a20", true); shoe(x + 64, y, "#61afef", false);
  shoe(x + 16, y + 14, "#c678dd", true); shoe(x + 40, y + 14, "#f4f4f4", false); shoe(x + 64, y + 14, "#ffd166", true);
}
function drawClothesRack(b, x, y) {
  b.fillStyle = OUTLINE; b.fillRect(x + 3, y - 32, 26, 3); b.fillRect(x + 4, y - 30, 3, 58); b.fillRect(x + 25, y - 30, 3, 58); b.fillStyle = "#c0c0c0"; b.fillRect(x + 4, y - 31, 24, 1); b.fillRect(x + 5, y - 29, 1, 56); b.fillRect(x + 26, y - 29, 1, 56);
  const cols = ["#e06c75", "#61afef", "#f4f4f4", "#c678dd"];
  for (let i = 0; i < 4; i++) { const gx = x + 7 + i * 5; b.fillStyle = OUTLINE; b.fillRect(gx + 1, y - 29, 1, 3); b.fillRect(gx - 1, y - 26, 6, 22 + (i % 2) * 6); b.fillStyle = cols[i]; b.fillRect(gx, y - 25, 4, 20 + (i % 2) * 6); b.fillStyle = shade(cols[i], -30); b.fillRect(gx, y - 25, 1, 20 + (i % 2) * 6); }
  b.fillStyle = OUTLINE; b.fillRect(x + 2, y + 26, 28, 3);
}
function drawMirror(b, x, y, t) {
  outlineRect(b, x + 6, y - 40, 20, 62, "#c9a781"); b.fillStyle = "#dcbf9a"; b.fillRect(x + 6, y - 40, 20, 2);
  b.fillStyle = "#cfe6f2"; b.fillRect(x + 8, y - 38, 16, 58); b.fillStyle = "rgba(255,255,255,.7)"; b.fillRect(x + 10, y - 34, 2, 30); b.fillRect(x + 13, y - 36, 1, 10);
  outlineRect(b, x + 4, y + 22, 24, 5, "#a8865f");
  if (Math.floor(t / 1500) % 3 === 0) { b.fillStyle = "rgba(255,255,255,.9)"; b.fillRect(x + 18, y - 20, 2, 2); }
}
function drawWardrobe(b, x, y) {
  outlineRect(b, x + 3, y - 22, 90, 52, "#f1e6dc"); b.fillStyle = "#e3d3c6"; b.fillRect(x + 3, y - 22, 90, 3); b.fillRect(x + 3, y + 26, 90, 4);
  for (let i = 0; i < 3; i++) { b.fillStyle = "#d8c4b4"; b.fillRect(x + 6 + i * 30, y - 18, 26, 44); b.fillStyle = "#f7efe7"; b.fillRect(x + 8 + i * 30, y - 16, 22, 40); b.fillStyle = "#ffd166"; b.fillRect(x + 27 + i * 30, y + 2, 2, 8); b.fillStyle = OUTLINE; b.fillRect(x + 33 + i * 30, y - 22, 1, 52); }
}
function drawFabricRolls(b, x, y) {
  const cols = ["#e06c75", "#61afef", "#ffd166", "#98c379", "#c678dd"];
  for (let i = 0; i < 5; i++) { const rx = x + 4 + i * 11, ry = y - 10 + (i % 2) * 6; b.fillStyle = OUTLINE; b.fillRect(rx - 1, ry - 1, 10, 38); b.fillStyle = cols[i]; b.fillRect(rx, ry, 8, 36); b.fillStyle = shade(cols[i], 40); b.fillRect(rx + 1, ry + 1, 2, 34); b.fillStyle = "#f4f4f4"; b.fillRect(rx + 2, ry - 3, 4, 3); }
}
function drawIroning(b, x, y, t) {
  outlineRect(b, x + 4, y + 6, 56, 10, "#f4f4f4"); b.fillStyle = "#c9c9c9"; b.fillRect(x + 4, y + 13, 56, 3); b.fillStyle = OUTLINE; b.fillRect(x + 12, y + 16, 3, 14); b.fillRect(x + 50, y + 16, 3, 14); b.fillRect(x + 8, y + 26, 48, 2);
  outlineRect(b, x + 34, y - 6, 18, 12, "#3a3f4a"); b.fillStyle = "#6c7080"; b.fillRect(x + 36, y - 4, 14, 3); b.fillStyle = "#c0c0c0"; b.fillRect(x + 33, y + 2, 20, 4); b.fillStyle = Math.floor(t / 700) % 2 ? "#ff3b3b" : "#3a3f4a"; b.fillRect(x + 46, y - 3, 2, 2);
  b.fillStyle = "#c678dd"; b.fillRect(x + 8, y + 2, 20, 5);
}
function drawHatStand(b, x, y) {
  b.fillStyle = OUTLINE; b.fillRect(x + 14, y - 26, 4, 52); b.fillStyle = "#8a5a32"; b.fillRect(x + 15, y - 25, 2, 50); outlineRect(b, x + 8, y + 24, 16, 5, "#5c3d22");
  b.fillStyle = OUTLINE; b.fillRect(x + 4, y - 24, 24, 2); b.fillRect(x + 4, y - 10, 24, 2);
  const hat = (hx, hy, c) => { b.fillStyle = OUTLINE; b.fillRect(hx - 1, hy + 5, 16, 3); b.fillRect(hx + 2, hy - 1, 10, 7); b.fillStyle = c; b.fillRect(hx, hy + 6, 14, 1); b.fillRect(hx + 3, hy, 8, 6); b.fillStyle = shade(c, -30); b.fillRect(hx + 3, hy + 4, 8, 1); };
  hat(x + 2, y - 32, "#d9534f"); hat(x + 16, y - 18, "#2b2b2b"); hat(x + 2, y - 4, "#ffd166");
}
function drawSmallMannequin(b, x, y) { drawMannequin(b, x, y, "#e06c75"); }
function drawWallDecorFashion(b, t) {
  // moodboard
  b.fillStyle = "#c9a781"; b.fillRect(198, 3, 70, 22); b.fillStyle = "#f7efe7"; b.fillRect(200, 5, 66, 18);
  ["#e06c75", "#f78fb3", "#c678dd", "#61afef", "#ffd166", "#98c379"].forEach((c, i) => { b.fillStyle = c; b.fillRect(204 + i * 10, 8 + (i % 2) * 3, 7, 8); b.fillStyle = "#1c1a20"; b.fillRect(207 + i * 10, 7 + (i % 2) * 3, 1, 1); });
  // dress poster
  outlineRect(b, 13 * TILE + 2, 8, 30, 42, "#2b2b2b"); b.fillStyle = "#f7efe7"; b.fillRect(13 * TILE + 5, 11, 24, 36);
  b.fillStyle = "#e06c75"; b.fillRect(13 * TILE + 14, 14, 6, 4); b.fillRect(13 * TILE + 12, 18, 10, 8); b.fillRect(13 * TILE + 9, 26, 16, 16); b.fillStyle = "#c95c86"; b.fillRect(13 * TILE + 9, 40, 16, 2);
  // string lights across open office
  b.fillStyle = "#3a3f4a"; b.fillRect(8 * TILE, 6, 14 * TILE, 1);
  for (let i = 0; i < 14; i++) { const on = Math.floor(t / 600 + i) % 3 !== 0; b.fillStyle = on ? "#fff3b0" : "#8a8060"; b.fillRect(8 * TILE + 12 + i * 32, 7, 3, 4); if (on) { b.fillStyle = "rgba(255,240,180,.25)"; b.fillRect(8 * TILE + 10 + i * 32, 6, 7, 7); } }
  // ATELIER sign
  outlineRect(b, 16, 10, 150, 28, "#f7efe7"); b.fillStyle = "#c95c86"; for (let i = 0; i < 7; i++) b.fillRect(28 + i * 18, 17, 12, 14); b.fillStyle = "#f7efe7"; for (let i = 0; i < 7; i++) b.fillRect(32 + i * 18, 21, 4, 6);
  // mirror wall (meeting)
  b.fillStyle = "#c9a781"; b.fillRect(24 * TILE + 8, 6, 112, 46); b.fillStyle = "#cfe6f2"; b.fillRect(24 * TILE + 12, 10, 104, 38); b.fillStyle = "rgba(255,255,255,.6)"; b.fillRect(24 * TILE + 20, 14, 3, 30); b.fillRect(24 * TILE + 26, 12, 1, 14);
  drawClock(b, 15 * TILE + 16, 28);
  // hat shelf
  b.fillStyle = "#c9a781"; b.fillRect(20 * TILE + 10, 40, 52, 4); ["#d9534f", "#2b2b2b", "#ffd166"].forEach((c, i) => { const hx = 20 * TILE + 12 + i * 17; b.fillStyle = OUTLINE; b.fillRect(hx - 1, 33, 18, 3); b.fillRect(hx + 3, 26, 10, 8); b.fillStyle = c; b.fillRect(hx, 34, 16, 1); b.fillRect(hx + 4, 27, 8, 7); });
}

function drawClock(b, ccx, ccy) {
  const d = new Date();
  b.fillStyle = "#2b2b2b"; b.fillRect(ccx - 13, ccy - 13, 26, 26);
  b.fillStyle = "#f7f7f7"; b.fillRect(ccx - 11, ccy - 11, 22, 22);
  b.fillStyle = "#2b2b2b";
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; b.fillRect(ccx + Math.round(Math.cos(a) * 9) - 1, ccy + Math.round(Math.sin(a) * 9) - 1, i % 3 === 0 ? 2 : 1, i % 3 === 0 ? 2 : 1); }
  const ha = ((d.getHours() % 12) + d.getMinutes() / 60) / 12 * Math.PI * 2 - Math.PI / 2;
  const ma = d.getMinutes() / 60 * Math.PI * 2 - Math.PI / 2;
  line(b, ccx, ccy, ccx + Math.cos(ha) * 5, ccy + Math.sin(ha) * 5, "#2b2b2b");
  line(b, ccx, ccy, ccx + Math.cos(ma) * 8, ccy + Math.sin(ma) * 8, "#2b2b2b");
  b.fillStyle = "#d9534f"; b.fillRect(ccx - 1, ccy - 1, 2, 2);
}

const PROPS = {
  default: { plant: drawPlant, counter: drawKitchenCounter, fridge: drawFridge, roundTable: drawRoundTable, stool: drawStool, bin: drawBin, meetingTable: drawMeetingTable, meetingChair: drawMeetingChair, sofa: drawSofa, coffeeTable: drawCoffeeTable, bookshelf: drawBookshelf, lamp: drawLamp, cabinets: drawCabinets, boxes: drawBoxes, printer: drawPrinter, cooler: drawCooler, coffeeStation: drawCoffeeStation, wallDecor: drawWallDecorDefault },
  football: { counter: drawSnackBar, fridge: drawVending, roundTable: drawBallTable, meetingTable: drawTacticsTable, sofa: drawBench, coffeeTable: drawBallRack, bookshelf: drawTrophyCase, lamp: drawFloodlight, cabinets: drawLockers, boxes: drawCones, printer: drawJerseyRack, cooler: drawBottleCrate, coffeeStation: drawDrinksCooler, wallDecor: drawWallDecorFootball },
  fashion: { counter: drawCuttingTable, fridge: drawMannequin, roundTable: drawSwatchTable, meetingTable: drawDesignTable, sofa: drawVelvetSofa, coffeeTable: drawShoeDisplay, bookshelf: drawClothesRack, lamp: drawMirror, cabinets: drawWardrobe, boxes: drawFabricRolls, printer: drawIroning, cooler: drawHatStand, coffeeStation: drawSmallMannequin, wallDecor: drawWallDecorFashion },
};
const PROP_ALIAS = { kitchenCounter: "counter" };
const prop = (theme, name) => { const n = PROP_ALIAS[name] || name; return (PROPS[theme] && PROPS[theme][n]) || PROPS.default[n]; };

// --- gothic theme ---
THEMES.gothic = { wall: { face: "#3b3547", top: "#4a4358", base: "#2c2735", base2: "#1f1b28", edge: "#15121b", inner: "#4c4459", innerLight: "#5e5670", innerDark: "#221e2b" }, floors: { kitchen: "stone", office: "stone", meeting: "darkwood", lounge: "redcarpet", archive: "cobble" }, rug: "gothic" };

function drawStone(b, x, y, w, h) {
  for (let py = y; py < y + h; py += 24) for (let px = x - ((py / 24) % 2) * 24; px < x + w; px += 48) {
    const cx = Math.max(px, x), cw = Math.min(px + 48, x + w) - cx;
    if (cw <= 0) continue;
    b.fillStyle = ((px + py) / 24) % 3 === 0 ? "#6a6474" : "#5f596a"; b.fillRect(cx, py, cw, 24);
    b.fillStyle = "#3e3947"; b.fillRect(cx, py + 23, cw, 1); if (px >= x) b.fillRect(px, py, 1, 24);
    b.fillStyle = "rgba(255,255,255,.05)"; b.fillRect(cx + 4, py + 4, Math.max(0, cw - 10), 1);
  }
}
function drawDarkWood(b, x, y, w, h) {
  b.fillStyle = "#4a3324"; b.fillRect(x, y, w, h);
  for (let py = y; py < y + h; py += 16) { b.fillStyle = ((py - y) / 16) % 2 ? "#44301f" : "#4f3727"; b.fillRect(x, py, w, 16); b.fillStyle = "#2e1f14"; b.fillRect(x, py + 15, w, 1); const off = ((py / 16) % 3) * 40; for (let px = x + 30 - off; px < x + w; px += 120) if (px >= x) b.fillRect(px, py, 1, 16); }
}
function drawRedCarpet(b, x, y, w, h) {
  b.fillStyle = "#5a1d24"; b.fillRect(x, y, w, h);
  b.fillStyle = "#6b2430"; for (let py = y + 4; py < y + h; py += 8) for (let px = x + ((py / 8) % 2) * 4; px < x + w; px += 8) b.fillRect(px, py, 2, 2);
}
function drawCobble(b, x, y, w, h) {
  b.fillStyle = "#4b4650"; b.fillRect(x, y, w, h);
  for (let py = y; py < y + h; py += 12) for (let px = x - ((py / 12) % 2) * 6; px < x + w; px += 12) { const cx = Math.max(px, x); if (cx + 10 > x + w) continue; b.fillStyle = ((px + py) / 12) % 2 ? "#5d5763" : "#565060"; b.fillRect(cx + 1, py + 1, 10, 10); b.fillStyle = "rgba(255,255,255,.06)"; b.fillRect(cx + 2, py + 2, 5, 1); }
}
function drawCandleFlame(b, x, y, t, seed = 0) {
  const f = Math.floor((t + seed * 137) / 180) % 3;
  b.fillStyle = "#ffb347"; b.fillRect(x, y - 4 + (f === 1 ? 1 : 0), 2, 4);
  b.fillStyle = "#fff0a0"; b.fillRect(x, y - 2 + (f === 2 ? 1 : 0), 2, 2);
  b.fillStyle = "rgba(255,180,80,.10)"; b.fillRect(x - 6, y - 10, 14, 14);
}
function drawCandelabra(b, x, y, t) {
  b.fillStyle = OUTLINE; b.fillRect(x + 11, y - 14, 10, 2); b.fillRect(x + 15, y - 12, 2, 20); b.fillRect(x + 9, y + 6, 14, 3);
  b.fillStyle = "#6c6c74"; b.fillRect(x + 12, y - 13, 8, 1); b.fillRect(x + 16, y - 11, 1, 18);
  for (const cx of [x + 11, x + 15, x + 19]) { b.fillStyle = "#f4ecd8"; b.fillRect(cx, y - 22, 2, 8); drawCandleFlame(b, cx, y - 22, t, cx); }
}
function drawGothicCounter(b, x, y, t) {
  outlineRect(b, x, y + 6, 160, 26, "#5f596a"); b.fillStyle = "#726b7d"; b.fillRect(x, y + 6, 160, 4); b.fillStyle = "#3e3947"; b.fillRect(x, y + 30, 160, 2);
  for (let i = 0; i < 5; i++) { b.fillStyle = "#4b4650"; b.fillRect(x + i * 32 + 2, y + 14, 28, 16); }
  // cauldron
  outlineRect(b, x + 54, y - 12, 34, 22, "#2b2b30"); b.fillStyle = "#3a3a40"; b.fillRect(x + 56, y - 10, 30, 4); b.fillStyle = "#1c1c20"; b.fillRect(x + 50, y - 14, 42, 4);
  b.fillStyle = "#4ade80"; b.fillRect(x + 58, y - 11, 26, 3); const bub = Math.floor(t / 400) % 3; b.fillStyle = "#a3ffb0"; b.fillRect(x + 62 + bub * 6, y - 13, 2, 2);
  b.fillStyle = "rgba(74,222,128,.15)"; b.fillRect(x + 54, y - 26, 34, 14);
  // candles + potion bottles
  drawCandelabra(b, x + 4, y + 2, t);
  for (let i = 0; i < 3; i++) { const c = ["#c678dd", "#61afef", "#d9534f"][i]; outlineRect(b, x + 104 + i * 14, y - 6, 8, 12, c); b.fillStyle = "#2b2b30"; b.fillRect(x + 106 + i * 14, y - 10, 4, 4); }
}
function drawArmor(b, x, y) {
  outlineRect(b, x + 8, y + 22, 16, 4, "#3e3947");
  b.fillStyle = OUTLINE; b.fillRect(x + 11, y - 26, 10, 10); b.fillStyle = "#9aa0ad"; b.fillRect(x + 12, y - 25, 8, 8); b.fillStyle = "#1c1c20"; b.fillRect(x + 13, y - 21, 6, 2);
  b.fillStyle = "#d9534f"; b.fillRect(x + 15, y - 30, 2, 4);
  outlineRect(b, x + 9, y - 16, 14, 18, "#8a909c"); b.fillStyle = "#b8bec9"; b.fillRect(x + 10, y - 15, 3, 8); b.fillStyle = "#6c727e"; b.fillRect(x + 15, y - 12, 2, 12);
  outlineRect(b, x + 4, y - 15, 5, 14, "#8a909c"); outlineRect(b, x + 23, y - 15, 5, 14, "#8a909c");
  outlineRect(b, x + 10, y + 2, 5, 20, "#8a909c"); outlineRect(b, x + 17, y + 2, 5, 20, "#8a909c");
  b.fillStyle = OUTLINE; b.fillRect(x + 27, y - 24, 2, 34); b.fillStyle = "#c0c0c0"; b.fillRect(x + 27, y - 26, 2, 12);
}
function drawGothicTable(b, x, y, t) {
  b.fillStyle = OUTLINE; b.fillRect(x + 6, y + 2, 52, 26); b.fillRect(x + 2, y + 6, 60, 18);
  b.fillStyle = "#4a3324"; b.fillRect(x + 7, y + 3, 50, 24); b.fillRect(x + 3, y + 7, 58, 16);
  b.fillStyle = "#5f4330"; b.fillRect(x + 7, y + 3, 50, 4); b.fillStyle = "#2e1f14"; b.fillRect(x + 7, y + 23, 50, 4);
  b.fillStyle = "#2e1f14"; b.fillRect(x + 28, y + 26, 8, 6);
  drawCandelabra(b, x + 16, y + 14, t);
  b.fillStyle = "#c9a781"; b.fillRect(x + 40, y + 9, 12, 9); b.fillStyle = "#6b4a2b"; b.fillRect(x + 41, y + 10, 10, 1);
}
function drawGothicMeeting(b, x, y, t) {
  outlineRect(b, x + 4, y + 4, 120, 48, "#4a3324"); b.fillStyle = "#5f4330"; b.fillRect(x + 4, y + 4, 120, 5); b.fillStyle = "#2e1f14"; b.fillRect(x + 4, y + 44, 120, 8);
  b.fillStyle = "#3a281c"; for (let i = 0; i < 6; i++) b.fillRect(x + 10 + i * 19, y + 12, 1, 30);
  for (const [px, py, c] of [[14, 14, "#7a1f2b"], [80, 12, "#1f3a5a"], [50, 28, "#3a5a1f"]]) { outlineRect(b, x + px, y + py, 18, 12, c); b.fillStyle = "#c9a781"; b.fillRect(x + px + 2, y + py + 2, 14, 1); b.fillRect(x + px + 2, y + py + 9, 14, 1); }
  drawCandelabra(b, x + 92, y + 30, t); drawCandelabra(b, x + 24, y + 34, t);
  b.fillStyle = "#f4ecd8"; b.fillRect(x + 100, y + 14, 6, 6); b.fillStyle = "#1c1c20"; b.fillRect(x + 101, y + 16, 1, 1); b.fillRect(x + 104, y + 16, 1, 1);
}
function drawThrone(b, x, y) {
  outlineRect(b, x + 2, y - 16, 92, 24, "#3a1f28"); b.fillStyle = "#5a1d24"; b.fillRect(x + 6, y - 12, 84, 16);
  b.fillStyle = "#ffd166"; b.fillRect(x + 2, y - 22, 6, 6); b.fillRect(x + 88, y - 22, 6, 6); b.fillRect(x + 44, y - 24, 8, 8); b.fillStyle = "#3a1f28"; b.fillRect(x + 46, y - 22, 4, 4);
  outlineRect(b, x, y + 6, 96, 22, "#6b2430"); b.fillStyle = "#8a2f3d"; b.fillRect(x + 6, y + 8, 26, 12); b.fillRect(x + 35, y + 8, 26, 12); b.fillRect(x + 64, y + 8, 26, 12);
  b.fillStyle = "#3a1f28"; b.fillRect(x, y + 22, 96, 6); outlineRect(b, x - 2, y + 2, 8, 24, "#3a1f28"); outlineRect(b, x + 90, y + 2, 8, 24, "#3a1f28");
  b.fillStyle = "#ffd166"; b.fillRect(x + 4, y + 28, 4, 3); b.fillRect(x + 88, y + 28, 4, 3);
}
function drawChest(b, x, y) {
  outlineRect(b, x + 12, y + 4, 72, 22, "#4a3324"); b.fillStyle = "#5f4330"; b.fillRect(x + 12, y + 4, 72, 6);
  b.fillStyle = "#8a909c"; b.fillRect(x + 12, y + 10, 72, 2); b.fillRect(x + 24, y + 4, 3, 22); b.fillRect(x + 69, y + 4, 3, 22);
  b.fillStyle = "#ffd166"; b.fillRect(x + 45, y + 12, 6, 7); b.fillStyle = OUTLINE; b.fillRect(x + 47, y + 15, 2, 2);
  b.fillStyle = "#f4ecd8"; b.fillRect(x + 30, y - 4, 8, 7); b.fillStyle = "#1c1c20"; b.fillRect(x + 32, y - 2, 1, 2); b.fillRect(x + 35, y - 2, 1, 2); b.fillRect(x + 32, y + 1, 4, 1);
}
function drawTomeShelf(b, x, y) {
  outlineRect(b, x + 2, y - 30, 28, 60, "#2e1f14"); b.fillStyle = "#4a3324"; b.fillRect(x + 4, y - 28, 24, 56);
  const cols = ["#7a1f2b", "#1f3a5a", "#3a5a1f", "#5a3a1f", "#4a2a5a", "#6b4a2b"];
  for (let s = 0; s < 3; s++) { b.fillStyle = "#2e1f14"; b.fillRect(x + 4, y - 12 + s * 18 - 2, 24, 2); for (let i = 0; i < 5; i++) { b.fillStyle = cols[(s * 5 + i) % cols.length]; b.fillRect(x + 6 + i * 4, y - 26 + s * 18 + (i % 2), 3, 12 - (i % 2)); b.fillStyle = "#c9a781"; b.fillRect(x + 7 + i * 4, y - 22 + s * 18, 1, 1); } }
  b.fillStyle = "rgba(255,255,255,.35)"; b.fillRect(x + 4, y - 28, 8, 1); b.fillRect(x + 4, y - 28, 1, 8); b.fillRect(x + 5, y - 27, 1, 1); b.fillRect(x + 6, y - 26, 1, 1); b.fillRect(x + 7, y - 25, 1, 1);
}
function drawCandleStand(b, x, y, t) {
  b.fillStyle = OUTLINE; b.fillRect(x + 14, y - 30, 4, 56); b.fillStyle = "#6c6c74"; b.fillRect(x + 15, y - 29, 2, 54);
  outlineRect(b, x + 8, y + 24, 16, 5, "#3e3947");
  b.fillStyle = OUTLINE; b.fillRect(x + 4, y - 32, 24, 3); b.fillStyle = "#6c6c74"; b.fillRect(x + 5, y - 31, 22, 1);
  for (const cx of [x + 6, x + 15, x + 24]) { b.fillStyle = "#f4ecd8"; b.fillRect(cx, y - 42, 2, 10); drawCandleFlame(b, cx, y - 42, t, cx); }
  b.fillStyle = `rgba(255,180,80,${0.08 + (Math.floor(t / 300) % 2) * 0.03})`; b.fillRect(x - 10, y - 46, 52, 60);
}
function drawBarrels(b, x, y) {
  for (let i = 0; i < 3; i++) { const cx = x + i * 32; outlineRect(b, cx + 4, y - 18, 24, 46, "#5f4330"); b.fillStyle = "#4a3324"; b.fillRect(cx + 4, y - 18, 24, 3); b.fillRect(cx + 4, y + 25, 24, 3); b.fillStyle = "#8a909c"; b.fillRect(cx + 4, y - 10, 24, 2); b.fillRect(cx + 4, y + 16, 24, 2); b.fillStyle = "#2e1f14"; for (let v = 0; v < 4; v++) b.fillRect(cx + 8 + v * 6, y - 15, 1, 40); b.fillStyle = "#1c1c20"; b.fillRect(cx + 14, y + 4, 4, 4); }
}
function drawBones(b, x, y) {
  b.fillStyle = OUTLINE; b.fillRect(x + 4, y + 8, 56, 20);
  b.fillStyle = "#2b2730"; b.fillRect(x + 5, y + 9, 54, 18);
  const skull = (sx, sy) => { b.fillStyle = OUTLINE; b.fillRect(sx - 1, sy - 1, 12, 11); b.fillStyle = "#f4ecd8"; b.fillRect(sx, sy, 10, 7); b.fillRect(sx + 2, sy + 7, 6, 2); b.fillStyle = "#1c1c20"; b.fillRect(sx + 2, sy + 2, 2, 2); b.fillRect(sx + 6, sy + 2, 2, 2); b.fillRect(sx + 3, sy + 7, 1, 1); b.fillRect(sx + 6, sy + 7, 1, 1); };
  skull(x + 10, y + 10); skull(x + 40, y + 12);
  b.fillStyle = "#f4ecd8"; b.fillRect(x + 22, y + 22, 18, 2); b.fillRect(x + 20, y + 20, 3, 5); b.fillRect(x + 39, y + 20, 3, 5); b.fillRect(x + 8, y + 24, 12, 2);
  b.fillStyle = "#4ade80"; b.fillRect(x + 28, y + 12, 4, 6); b.fillStyle = "#1c1c20"; b.fillRect(x + 29, y + 9, 2, 3);
}
function drawLectern(b, x, y, t) {
  outlineRect(b, x + 22, y + 22, 20, 6, "#2e1f14"); b.fillStyle = OUTLINE; b.fillRect(x + 30, y - 2, 4, 24); b.fillStyle = "#4a3324"; b.fillRect(x + 31, y - 1, 2, 22);
  outlineRect(b, x + 16, y - 12, 32, 12, "#4a3324"); b.fillStyle = "#5f4330"; b.fillRect(x + 16, y - 12, 32, 2);
  outlineRect(b, x + 19, y - 18, 26, 10, "#f4ecd8"); b.fillStyle = "#6b4a2b"; b.fillRect(x + 22, y - 15, 8, 1); b.fillRect(x + 22, y - 12, 6, 1); b.fillRect(x + 34, y - 15, 8, 1); b.fillRect(x + 34, y - 12, 7, 1);
  b.fillStyle = "#c678dd"; b.fillRect(x + 31, y - 16, 2, 6); if (Math.floor(t / 500) % 2) { b.fillStyle = "rgba(198,120,221,.3)"; b.fillRect(x + 26, y - 22, 12, 10); }
  b.fillStyle = "#f4ecd8"; b.fillRect(x + 50, y - 8, 2, 8); drawCandleFlame(b, x + 50, y - 8, t, 5);
}
function drawGargoyle(b, x, y) {
  outlineRect(b, x + 6, y + 18, 20, 10, "#5f596a"); b.fillStyle = "#726b7d"; b.fillRect(x + 6, y + 18, 20, 2);
  b.fillStyle = OUTLINE; b.fillRect(x + 9, y - 6, 14, 24); b.fillStyle = "#6a6474"; b.fillRect(x + 10, y - 5, 12, 22);
  b.fillStyle = OUTLINE; b.fillRect(x + 4, y - 14, 6, 12); b.fillRect(x + 22, y - 14, 6, 12); b.fillStyle = "#6a6474"; b.fillRect(x + 5, y - 13, 4, 10); b.fillRect(x + 23, y - 13, 4, 10);
  b.fillStyle = OUTLINE; b.fillRect(x + 11, y - 12, 10, 8); b.fillStyle = "#6a6474"; b.fillRect(x + 12, y - 11, 8, 6); b.fillStyle = "#ffb347"; b.fillRect(x + 13, y - 9, 2, 2); b.fillRect(x + 17, y - 9, 2, 2);
  b.fillStyle = OUTLINE; b.fillRect(x + 12, y - 15, 2, 3); b.fillRect(x + 18, y - 15, 2, 3);
}
function drawCauldronSmall(b, x, y, t) {
  outlineRect(b, x + 6, y + 4, 22, 18, "#2b2b30"); b.fillStyle = "#1c1c20"; b.fillRect(x + 3, y + 2, 28, 4); b.fillStyle = "#c678dd"; b.fillRect(x + 8, y + 5, 18, 3);
  const bub = Math.floor(t / 350) % 3; b.fillStyle = "#e9b5ff"; b.fillRect(x + 10 + bub * 5, y + 3, 2, 2); b.fillStyle = "rgba(198,120,221,.15)"; b.fillRect(x + 4, y - 10, 26, 14);
  b.fillStyle = OUTLINE; b.fillRect(x + 8, y + 22, 4, 6); b.fillRect(x + 22, y + 22, 4, 6);
}
function drawWallDecorGothic(b, t) {
  // stained glass over the two windows (arched)
  for (const wx of [9 * TILE, 17 * TILE]) {
    b.fillStyle = "#2c2735"; b.fillRect(wx - 4, 4, 104, 48);
    b.fillStyle = "#1f1b28"; b.fillRect(wx, 8, 96, 40);
    const cols = ["#7a1f2b", "#1f3a5a", "#3a5a1f", "#5a3a8a", "#8a6a1f"];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) { b.fillStyle = cols[(i + j) % cols.length]; b.fillRect(wx + 2 + i * 16, 10 + j * 10, 14, 8); }
    b.fillStyle = "#15121b"; b.fillRect(wx + 47, 8, 2, 40); b.fillRect(wx, 27, 96, 2); for (let i = 1; i < 6; i++) b.fillRect(wx + i * 16, 8, 1, 40);
    b.fillStyle = "#2c2735"; b.fillRect(wx, 8, 8, 6); b.fillRect(wx + 88, 8, 8, 6); b.fillRect(wx, 8, 4, 10); b.fillRect(wx + 92, 8, 4, 10);
    b.fillStyle = `rgba(255,230,180,${0.06 + (Math.floor(t / 900) % 2) * 0.02})`; b.fillRect(wx, 48, 96, 8);
  }
  // chandelier (center)
  const cx = 14 * TILE + 16;
  b.fillStyle = "#3a3a40"; b.fillRect(cx - 1, 0, 2, 14); b.fillRect(cx - 22, 14, 44, 3); b.fillRect(cx - 24, 17, 4, 8); b.fillRect(cx + 20, 17, 4, 8); b.fillRect(cx - 2, 17, 4, 8);
  for (const px of [cx - 22, cx, cx + 22]) { b.fillStyle = "#f4ecd8"; b.fillRect(px - 1, 20, 2, 6); drawCandleFlame(b, px - 1, 20, t, px); }
  // torches on kitchen and meeting walls
  for (const px of [30, 120, 26 * TILE, 28 * TILE + 20]) { b.fillStyle = OUTLINE; b.fillRect(px, 22, 4, 22); b.fillStyle = "#6b4a2b"; b.fillRect(px + 1, 24, 2, 18); b.fillStyle = "#ffb347"; b.fillRect(px - 2, 12 + (Math.floor((t + px) / 150) % 2), 8, 10); b.fillStyle = "#fff0a0"; b.fillRect(px, 15, 4, 5); b.fillStyle = "rgba(255,180,80,.12)"; b.fillRect(px - 10, 6, 24, 40); }
  // portrait with watching eyes
  outlineRect(b, 13 * TILE + 2, 8, 30, 40, "#8a6a1f"); b.fillStyle = "#2b2730"; b.fillRect(13 * TILE + 6, 12, 22, 32);
  b.fillStyle = "#c9a781"; b.fillRect(13 * TILE + 12, 16, 10, 10); b.fillRect(13 * TILE + 9, 26, 16, 14); b.fillStyle = "#1c1c20"; b.fillRect(13 * TILE + 10, 14, 14, 4);
  const look = Math.floor(t / 1500) % 3; b.fillStyle = "#1c1c20"; b.fillRect(13 * TILE + 13 + look, 20, 2, 2); b.fillRect(13 * TILE + 18 + look, 20, 2, 2);
  // cobwebs in the corners
  b.fillStyle = "rgba(255,255,255,.35)"; for (let i = 0; i < 8; i++) { b.fillRect(0, i * 3, 24 - i * 3, 1); b.fillRect(i * 3, 0, 1, 24 - i * 3); b.fillRect(LW - 24 + i * 3, i * 3, 1, 1); b.fillRect(LW - 1 - i * 3, 0, 1, 24 - i * 3); }
  // moon in the sky above the meeting wall
  b.fillStyle = "#f4ecd8"; b.fillRect(20 * TILE + 10, 10, 12, 12); b.fillStyle = THEMES.gothic.wall.face; b.fillRect(20 * TILE + 15, 8, 10, 10);
  // clock
  drawClock(b, 15 * TILE + 16, 28);
}
PROPS.gothic = { counter: drawGothicCounter, fridge: drawArmor, roundTable: drawGothicTable, meetingTable: drawGothicMeeting, sofa: drawThrone, coffeeTable: drawChest, bookshelf: drawTomeShelf, lamp: drawCandleStand, cabinets: drawBarrels, boxes: drawBones, printer: drawLectern, cooler: drawGargoyle, coffeeStation: drawCauldronSmall, wallDecor: drawWallDecorGothic };
THEME_NAMES.push("gothic");

// --- music theme (YouTube music channel studio) ---
THEMES.music = { dark: true, wall: { face: "#2b2b35", top: "#3a3a46", base: "#22222b", base2: "#18181f", edge: "#0f0f14", inner: "#3a3a48", innerLight: "#4c4c5c", innerDark: "#1a1a22" }, floors: { kitchen: "darkTiles", office: "darkwood", meeting: "studioCarpet", lounge: "checker", archive: "studioCarpet" }, rug: "vinyl" };
THEMES.gothic.dark = true;

function drawDarkTiles(b, x, y, w, h) {
  for (let py = y; py < y + h; py += 32) for (let px = x; px < x + w; px += 32) { b.fillStyle = ((px + py) / 32) % 2 ? "#3a3a46" : "#34343f"; b.fillRect(px, py, 32, 32); b.fillStyle = "#26262e"; b.fillRect(px, py + 31, 32, 1); b.fillRect(px + 31, py, 1, 32); b.fillStyle = "rgba(255,255,255,.04)"; b.fillRect(px + 2, py + 2, 12, 1); }
}
function drawStudioCarpet(b, x, y, w, h) {
  b.fillStyle = "#33354a"; b.fillRect(x, y, w, h);
  b.fillStyle = "#3b3d55"; for (let py = y + 4; py < y + h; py += 8) for (let px = x + ((py / 8) % 2) * 4; px < x + w; px += 8) b.fillRect(px, py, 2, 2);
}
function drawChecker(b, x, y, w, h) {
  for (let py = y; py < y + h; py += 16) for (let px = x; px < x + w; px += 16) { b.fillStyle = ((px + py) / 16) % 2 ? "#e8e6e0" : "#26262e"; b.fillRect(px, py, 16, 16); }
  b.fillStyle = "rgba(0,0,0,.12)"; for (let py = y; py < y + h; py += 16) b.fillRect(x, py, w, 1); for (let px = x; px < x + w; px += 16) b.fillRect(px, y, 1, h);
}
// pixel disc: rows of spans
function disc(b, cx, cy, r, col) {
  b.fillStyle = col;
  for (let dy = -r; dy <= r; dy++) { const half = Math.round(Math.sqrt(r * r - dy * dy)); b.fillRect(cx - half, cy + dy, half * 2 + 1, 1); }
}
let vinylRug = null;
function drawVinylRug(b, x, y) {
  if (!vinylRug) {
    vinylRug = document.createElement("canvas"); vinylRug.width = 144; vinylRug.height = 144;
    const g = vinylRug.getContext("2d");
    disc(g, 72, 72, 71, OUTLINE); disc(g, 72, 72, 70, "#1c1c22");
    for (let r = 66; r > 26; r -= 4) disc(g, 72, 72, r, r % 8 === 2 ? "#26262e" : "#1c1c22");
    g.fillStyle = "rgba(255,255,255,.08)"; for (let i = 0; i < 6; i++) g.fillRect(30 + i * 3, 30 + i * 4, 3, 1);
    disc(g, 72, 72, 24, "#ff0000"); disc(g, 72, 72, 22, "#e3212b");
    g.fillStyle = "#ffffff"; for (let r = 0; r <= 14; r++) g.fillRect(66, 65 + r, Math.round(7 - Math.abs(r - 7)) + 1, 1);
    disc(g, 72, 72, 3, OUTLINE); disc(g, 72, 72, 2, "#e8e6e0");
  }
  b.drawImage(vinylRug, x, y);
}
// YouTube play-button plaque
function drawYtLogo(b, x, y, w, h, col = "#ff0000") {
  b.fillStyle = OUTLINE; b.fillRect(x + 1, y - 1, w - 2, h + 2); b.fillRect(x - 1, y + 1, w + 2, h - 2);
  b.fillStyle = col; b.fillRect(x + 2, y, w - 4, h); b.fillRect(x, y + 2, w, h - 4);
  b.fillStyle = shade(col, 30); b.fillRect(x + 3, y + 1, w - 6, 1);
  const th = Math.max(6, Math.round(h * 0.45)), tw = Math.round(th * 0.8), tx = x + Math.round(w / 2 - tw / 2) + 1, ty = y + Math.round(h / 2 - th / 2);
  b.fillStyle = "#ffffff"; for (let r = 0; r <= th; r++) b.fillRect(tx, ty + r, Math.max(1, Math.round((th / 2 - Math.abs(r - th / 2)) * (tw / (th / 2)))), 1);
}
function drawLed(b, x, y, on, col = "#ff3b3b") { b.fillStyle = on ? col : "#3a1a1a"; b.fillRect(x, y, 2, 2); if (on) { b.fillStyle = `${col}33`; b.fillRect(x - 2, y - 2, 6, 6); } }
function drawVu(b, x, y, n, t, seed = 0) { // bouncing meter bars
  for (let i = 0; i < n; i++) {
    const h = 2 + Math.round((Math.sin(t / 130 + i * 1.3 + seed) + 1) * 3 + (Math.sin(t / 47 + i) + 1));
    for (let s = 0; s < h; s++) { b.fillStyle = s < 5 ? "#4ade80" : s < 7 ? "#ffd166" : "#ff3b3b"; b.fillRect(x + i * 4, y - s * 2, 3, 1); }
  }
}
function drawMusicNote(b, x, y, col) { b.fillStyle = col; b.fillRect(x, y + 4, 4, 3); b.fillRect(x + 3, y - 3, 1, 8); b.fillRect(x + 4, y - 3, 3, 1); b.fillRect(x + 6, y - 2, 1, 2); }

function drawStudioBar(b, x, y, t = 0) { // kitchen counter: coffee bar with turntable + mugs
  outlineRect(b, x, y + 6, 160, 26, "#3a3a48"); b.fillStyle = "#4c4c5c"; b.fillRect(x, y + 6, 160, 4); b.fillStyle = "#1a1a22"; b.fillRect(x, y + 30, 160, 2);
  for (let i = 0; i < 5; i++) { b.fillStyle = "#2b2b35"; b.fillRect(x + i * 32 + 2, y + 14, 28, 16); b.fillStyle = "#e3212b"; b.fillRect(x + i * 32 + 13, y + 20, 6, 2); }
  // turntable
  outlineRect(b, x + 8, y - 10, 46, 18, "#26262e"); b.fillStyle = "#3a3a48"; b.fillRect(x + 8, y - 10, 46, 2);
  disc(b, x + 26, y - 1, 7, OUTLINE); disc(b, x + 26, y - 1, 6, "#141418"); disc(b, x + 26, y - 1, 2, "#e3212b");
  const a = (t / 400) % (Math.PI * 2); b.fillStyle = "#4c4c5c"; b.fillRect(x + 26 + Math.round(Math.cos(a) * 4), y - 1 + Math.round(Math.sin(a) * 4), 1, 1);
  b.fillStyle = "#c0c0c0"; b.fillRect(x + 44, y - 8, 2, 8); b.fillRect(x + 36, y - 2, 9, 1); drawLed(b, x + 46, y + 3, true, "#4ade80");
  // coffee machine + mugs
  outlineRect(b, x + 104, y - 12, 22, 20, "#1c1c22"); b.fillStyle = "#3a3a48"; b.fillRect(x + 104, y - 12, 22, 3); b.fillStyle = "#e3212b"; b.fillRect(x + 108, y - 6, 6, 2); drawLed(b, x + 121, y - 7, Math.floor(t / 700) % 2);
  for (const [mx, c] of [[66, "#ff0000"], [80, "#f7f7f7"], [136, "#61afef"]]) { outlineRect(b, x + mx, y - 3, 8, 8, c); b.fillStyle = OUTLINE; b.fillRect(x + mx + 9, y - 1, 2, 4); }
  b.fillStyle = "rgba(255,255,255,.5)"; b.fillRect(x + 108, y - 20 - (Math.floor(t / 300) % 3), 1, 3); b.fillRect(x + 112, y - 18 - (Math.floor((t + 200) / 300) % 3), 1, 3);
}
function drawSpeakerStack(b, x, y, t = 0) { // fridge slot: tall PA speaker
  outlineRect(b, x + 4, y - 30, 24, 56, "#1c1c22"); b.fillStyle = "#26262e"; b.fillRect(x + 5, y - 29, 22, 54);
  disc(b, x + 16, y - 16, 8, "#0f0f14"); disc(b, x + 16, y - 16, 6, "#3a3a48"); disc(b, x + 16, y - 16, 2, "#4c4c5c");
  disc(b, x + 16, y + 8, 10, "#0f0f14"); disc(b, x + 16, y + 8, 8, "#3a3a48"); disc(b, x + 16, y + 8, 3 + (Math.floor(t / 120) % 2), "#4c4c5c");
  b.fillStyle = "#0f0f14"; b.fillRect(x + 13, y - 27, 6, 3); drawLed(b, x + 15, y + 22, true, "#4ade80");
  b.fillStyle = "#4c4c5c"; b.fillRect(x + 4, y + 26, 24, 2);
}
function drawDrumKit(b, x, y) { // roundTable slot (2 tiles wide)
  // cymbal + hi-hat stands
  b.fillStyle = "#c0c0c0"; b.fillRect(x + 8, y - 12, 1, 30); b.fillRect(x + 54, y - 10, 1, 28);
  b.fillStyle = OUTLINE; b.fillRect(x - 1, y - 14, 19, 4); b.fillStyle = "#ffd166"; b.fillRect(x, y - 13, 17, 2); b.fillStyle = "#e0b04e"; b.fillRect(x + 4, y - 13, 9, 1);
  b.fillStyle = OUTLINE; b.fillRect(x + 46, y - 12, 17, 3); b.fillRect(x + 46, y - 8, 17, 3); b.fillStyle = "#ffd166"; b.fillRect(x + 47, y - 11, 15, 1); b.fillRect(x + 47, y - 7, 15, 1);
  // toms
  outlineRect(b, x + 14, y - 4, 14, 10, "#e3212b"); b.fillStyle = "#f4f4f4"; b.fillRect(x + 14, y - 4, 14, 2);
  outlineRect(b, x + 36, y - 4, 14, 10, "#e3212b"); b.fillStyle = "#f4f4f4"; b.fillRect(x + 36, y - 4, 14, 2);
  // bass drum
  disc(b, x + 32, y + 18, 13, OUTLINE); disc(b, x + 32, y + 18, 12, "#f4f4f4"); disc(b, x + 32, y + 18, 10, "#e8e6e0");
  b.fillStyle = "#e3212b"; b.fillRect(x + 27, y + 12, 10, 12); b.fillRect(x + 25, y + 14, 14, 8); b.fillStyle = "#ffffff"; for (let r = 0; r <= 6; r++) b.fillRect(x + 30, y + 15 + r, Math.max(1, Math.round((3 - Math.abs(r - 3)) * 1.6)), 1);
  b.fillStyle = "#c0c0c0"; for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; b.fillRect(x + 32 + Math.round(Math.cos(a) * 11) - 1, y + 18 + Math.round(Math.sin(a) * 11) - 1, 2, 2); }
  // snare (left front) + pedal
  outlineRect(b, x + 4, y + 8, 14, 8, "#c0c0c0"); b.fillStyle = "#f4f4f4"; b.fillRect(x + 4, y + 8, 14, 2); b.fillStyle = OUTLINE; b.fillRect(x + 10, y + 16, 2, 8);
  b.fillStyle = "#4c4c5c"; b.fillRect(x + 30, y + 31, 6, 2);
  b.fillStyle = "#c9a781"; b.fillRect(x + 18, y - 2, 1, 8); b.fillRect(x + 20, y - 1, 1, 8);
}
function drawMixingConsole(b, x, y, t = 0) { // meeting table slot 128x48
  outlineRect(b, x + 4, y + 4, 120, 48, "#26262e"); b.fillStyle = "#3a3a48"; b.fillRect(x + 4, y + 4, 120, 4); b.fillStyle = "#1a1a22"; b.fillRect(x + 4, y + 44, 120, 8);
  // channel strips: knobs + faders
  for (let i = 0; i < 12; i++) {
    const cx = x + 10 + i * 9.5;
    for (let k = 0; k < 3; k++) { b.fillStyle = ["#61afef", "#ffd166", "#4ade80"][k]; b.fillRect(Math.round(cx), y + 11 + k * 5, 3, 3); }
    b.fillStyle = "#0f0f14"; b.fillRect(Math.round(cx) + 1, y + 27, 1, 14);
    const fp = Math.round((Math.sin(i * 2.1) + 1) * 5); b.fillStyle = "#e8e6e0"; b.fillRect(Math.round(cx) - 1, y + 28 + fp, 5, 3);
  }
  // meter bridge
  b.fillStyle = "#0f0f14"; b.fillRect(x + 8, y - 8, 112, 12); drawVu(b, x + 12, y + 1, 26, t, 1);
  // laptop at the right end
  outlineRect(b, x + 96, y + 14, 22, 14, "#3a3a48"); b.fillStyle = "#1a1a22"; b.fillRect(x + 98, y + 16, 18, 8); b.fillStyle = "#e3212b"; b.fillRect(x + 100, y + 18, 6, 4); b.fillStyle = "#ffffff"; b.fillRect(x + 102, y + 19, 2, 2);
  b.fillStyle = "#e8e6e0"; b.fillRect(x + 108, y + 18, 6, 1); b.fillRect(x + 108, y + 21, 5, 1);
}
function drawStudioCouch(b, x, y) { // sofa slot (96 wide)
  outlineRect(b, x + 2, y - 14, 92, 22, "#1c1c22"); b.fillStyle = "#26262e"; b.fillRect(x + 6, y - 10, 84, 14);
  outlineRect(b, x, y + 6, 96, 22, "#1c1c22"); b.fillStyle = "#33333f"; b.fillRect(x + 6, y + 8, 26, 12); b.fillRect(x + 35, y + 8, 26, 12); b.fillRect(x + 64, y + 8, 26, 12);
  b.fillStyle = "#e3212b"; b.fillRect(x + 10, y - 6, 16, 10); b.fillRect(x + 70, y - 6, 16, 10); b.fillStyle = "#ff4d57"; b.fillRect(x + 12, y - 5, 12, 1); b.fillRect(x + 72, y - 5, 12, 1);
  b.fillStyle = "#1c1c22"; b.fillRect(x, y + 22, 96, 6); outlineRect(b, x - 2, y + 2, 8, 24, "#1c1c22"); outlineRect(b, x + 90, y + 2, 8, 24, "#1c1c22");
  b.fillStyle = "#c0c0c0"; b.fillRect(x + 2, y + 28, 3, 3); b.fillRect(x + 91, y + 28, 3, 3);
}
function drawSynth(b, x, y) { // coffee table slot: keyboard on a stand
  b.fillStyle = OUTLINE; b.fillRect(x + 16, y + 20, 3, 12); b.fillRect(x + 77, y + 20, 3, 12); b.fillRect(x + 12, y + 31, 12, 2); b.fillRect(x + 72, y + 31, 12, 2);
  outlineRect(b, x + 8, y + 2, 80, 20, "#26262e"); b.fillStyle = "#3a3a48"; b.fillRect(x + 8, y + 2, 80, 4);
  b.fillStyle = "#f4f4f4"; b.fillRect(x + 10, y + 10, 76, 10); b.fillStyle = "#b8b8b8"; for (let i = 0; i < 19; i++) b.fillRect(x + 13 + i * 4, y + 10, 1, 10);
  b.fillStyle = "#0f0f14"; for (let i = 0; i < 19; i++) if (i % 7 !== 2 && i % 7 !== 6) b.fillRect(x + 12 + i * 4, y + 10, 2, 6);
  for (let i = 0; i < 8; i++) { b.fillStyle = ["#ff3b3b", "#ffd166", "#4ade80", "#61afef"][i % 4]; b.fillRect(x + 14 + i * 9, y + 6, 3, 2); }
}
function drawVinylShelf(b, x, y) { // bookshelf slot: record crate shelf
  outlineRect(b, x + 2, y - 30, 28, 60, "#1c1c22"); b.fillStyle = "#26262e"; b.fillRect(x + 4, y - 28, 24, 56);
  const cols = ["#e3212b", "#ffd166", "#61afef", "#4ade80", "#c678dd", "#f4f4f4", "#ff8c42"];
  for (let s = 0; s < 3; s++) { b.fillStyle = "#1c1c22"; b.fillRect(x + 4, y - 12 + s * 18 - 2, 24, 2); for (let i = 0; i < 6; i++) { b.fillStyle = cols[(s * 6 + i) % cols.length]; b.fillRect(x + 5 + i * 4 - (i % 2), y - 26 + s * 18 + (i % 2), 3, 12 - (i % 2)); } }
  drawYtLogo(b, x + 7, y + 8, 18, 12);
  b.fillStyle = "#c0c0c0"; b.fillRect(x + 8, y - 34, 16, 4); disc(b, x + 16, y - 36, 4, OUTLINE); disc(b, x + 16, y - 36, 3, "#141418"); b.fillStyle = "#e3212b"; b.fillRect(x + 16, y - 36, 1, 1);
}
function drawMicStand(b, x, y, t = 0) { // lamp slot: studio mic with pop filter
  outlineRect(b, x + 6, y + 24, 20, 5, "#1c1c22"); b.fillStyle = OUTLINE; b.fillRect(x + 14, y - 24, 4, 48); b.fillStyle = "#c0c0c0"; b.fillRect(x + 15, y - 23, 2, 46);
  b.fillStyle = OUTLINE; b.fillRect(x + 16, y - 26, 12, 3); b.fillStyle = "#c0c0c0"; b.fillRect(x + 17, y - 25, 10, 1);
  outlineRect(b, x + 8, y - 44, 12, 22, "#3a3a48"); b.fillStyle = "#4c4c5c"; for (let i = 0; i < 5; i++) b.fillRect(x + 9, y - 42 + i * 4, 10, 1); b.fillStyle = "#ffd166"; b.fillRect(x + 12, y - 36, 4, 4);
  b.fillStyle = OUTLINE; b.fillRect(x + 22, y - 48, 12, 2); b.fillRect(x + 22, y - 26, 12, 2); b.fillRect(x + 21, y - 47, 2, 22); b.fillRect(x + 33, y - 47, 2, 22); b.fillStyle = "rgba(255,255,255,.18)"; b.fillRect(x + 23, y - 46, 10, 20);
  drawLed(b, x + 13, y - 20, Math.floor(t / 500) % 2);
  b.fillStyle = "#1c1c22"; b.fillRect(x + 16, y + 2, 1, 22); b.fillRect(x + 16, y + 24, 14, 1);
}
function drawGuitarRack(b, x, y) { // cabinets slot (96 wide): 3 guitars on stands
  outlineRect(b, x + 2, y + 20, 92, 6, "#1c1c22"); b.fillStyle = "#3a3a48"; b.fillRect(x + 2, y + 20, 92, 2);
  const guitar = (gx, body, pick, acoustic) => {
    b.fillStyle = OUTLINE; b.fillRect(gx + 8, y - 30, 4, 34); b.fillStyle = "#6b4a2b"; b.fillRect(gx + 9, y - 29, 2, 32); b.fillStyle = "#c0c0c0"; for (let i = 0; i < 6; i++) b.fillRect(gx + 9, y - 26 + i * 5, 2, 1);
    outlineRect(b, gx + 7, y - 34, 6, 6, "#1c1c22"); b.fillStyle = "#c0c0c0"; b.fillRect(gx + 6, y - 33, 1, 1); b.fillRect(gx + 13, y - 33, 1, 1); b.fillRect(gx + 6, y - 30, 1, 1); b.fillRect(gx + 13, y - 30, 1, 1);
    if (acoustic) { disc(b, gx + 10, y + 6, 8, OUTLINE); disc(b, gx + 10, y + 6, 7, body); disc(b, gx + 10, y - 1, 6, OUTLINE); disc(b, gx + 10, y - 1, 5, body); disc(b, gx + 10, y + 4, 3, "#1c1c22"); }
    else { outlineRect(b, gx + 2, y - 2, 16, 18, body); b.fillStyle = OUTLINE; b.fillRect(gx + 2, y - 4, 5, 4); b.fillRect(gx + 13, y - 4, 5, 4); b.fillStyle = body; b.fillRect(gx + 3, y - 3, 3, 4); b.fillRect(gx + 14, y - 3, 3, 4); b.fillStyle = "#f4f4f4"; b.fillRect(gx + 5, y + 2, 10, 2); b.fillRect(gx + 5, y + 8, 10, 2); b.fillStyle = "#1c1c22"; b.fillRect(gx + 8, y + 12, 5, 1); }
    b.fillStyle = pick; b.fillRect(gx + 9, y - 2, 2, 12);
    b.fillStyle = OUTLINE; b.fillRect(gx + 4, y + 16, 12, 2); b.fillRect(gx + 9, y + 18, 2, 3);
  };
  guitar(x + 4, "#e3212b", "#f4f4f4", false); guitar(x + 36, "#c9a781", "#1c1c22", true); guitar(x + 68, "#61afef", "#f4f4f4", false);
}
function drawAmpStack(b, x, y, t = 0) { // boxes slot (64 wide): guitar amps
  outlineRect(b, x + 4, y - 20, 56, 26, "#1c1c22"); b.fillStyle = "#26262e"; b.fillRect(x + 6, y - 18, 52, 22); b.fillStyle = "#3a3a48"; for (let i = 0; i < 10; i++) b.fillRect(x + 8, y - 16 + i * 2, 48, 1);
  outlineRect(b, x + 8, y + 6, 48, 20, "#3a3a48"); b.fillStyle = "#c9a781"; b.fillRect(x + 8, y + 6, 48, 5); b.fillStyle = "#0f0f14"; for (let i = 0; i < 5; i++) b.fillRect(x + 12 + i * 9, y + 7, 3, 3); b.fillStyle = "#c0c0c0"; b.fillRect(x + 12 + (Math.floor(t / 900) % 5) * 9, y + 7, 3, 3);
  disc(b, x + 32, y + 18, 6, "#0f0f14"); disc(b, x + 32, y + 18, 4, "#26262e"); drawLed(b, x + 50, y + 8, true);
  b.fillStyle = "#c0c0c0"; b.fillRect(x + 28, y - 24, 8, 4);
}
function drawCameraRig(b, x, y, t = 0) { // printer slot (64 wide): camera on tripod, blinking REC
  b.fillStyle = OUTLINE; b.fillRect(x + 20, y + 2, 3, 26); b.fillRect(x + 40, y + 2, 3, 26); b.fillRect(x + 30, y + 4, 3, 22); b.fillRect(x + 22, y - 2, 20, 4);
  b.fillStyle = "#4c4c5c"; b.fillRect(x + 21, y + 3, 1, 24); b.fillRect(x + 41, y + 3, 1, 24); b.fillRect(x + 31, y + 5, 1, 20);
  outlineRect(b, x + 16, y - 22, 30, 20, "#26262e"); b.fillStyle = "#3a3a48"; b.fillRect(x + 16, y - 22, 30, 3);
  outlineRect(b, x + 46, y - 18, 12, 12, "#1c1c22"); disc(b, x + 52, y - 12, 4, "#0f0f14"); disc(b, x + 52, y - 12, 2, "#4c6c8c"); b.fillStyle = "#ffffff"; b.fillRect(x + 51, y - 14, 1, 1);
  outlineRect(b, x + 4, y - 20, 12, 16, "#1c1c22"); b.fillStyle = "#26262e"; b.fillRect(x + 5, y - 19, 10, 14); b.fillStyle = "#4c4c5c"; b.fillRect(x + 6, y - 17, 8, 5);
  b.fillStyle = "#ffffff"; b.fillRect(x + 20, y - 12, 8, 1); b.fillRect(x + 20, y - 9, 6, 1); drawLed(b, x + 40, y - 19, Math.floor(t / 500) % 2);
  b.fillStyle = "#ff3b3b"; if (Math.floor(t / 500) % 2) { b.fillRect(x + 7, y - 16, 2, 2); }
}
function drawRingLight(b, x, y, t = 0) { // cooler slot: ring light on a stand
  outlineRect(b, x + 6, y + 24, 20, 5, "#1c1c22"); b.fillStyle = OUTLINE; b.fillRect(x + 14, y - 10, 4, 34); b.fillStyle = "#c0c0c0"; b.fillRect(x + 15, y - 9, 2, 32);
  disc(b, x + 16, y - 20, 14, OUTLINE); disc(b, x + 16, y - 20, 13, "#fff7d6"); disc(b, x + 16, y - 20, 9, OUTLINE); disc(b, x + 16, y - 20, 8, THEMES.music.wall.face);
  b.fillStyle = `rgba(255,247,214,${0.10 + (Math.floor(t / 800) % 2) * 0.03})`; b.fillRect(x - 6, y - 38, 44, 40);
  outlineRect(b, x + 12, y - 24, 8, 8, "#26262e"); b.fillStyle = "#4c6c8c"; b.fillRect(x + 14, y - 22, 4, 4);
}
function drawHeadphoneStand(b, x, y, t = 0) { // coffeeStation slot: headphones + sheet music
  outlineRect(b, x + 2, y + 6, 28, 22, "#3a3a48"); b.fillStyle = "#4c4c5c"; b.fillRect(x + 2, y + 6, 28, 3);
  b.fillStyle = OUTLINE; b.fillRect(x + 14, y - 14, 4, 20); b.fillRect(x + 8, y + 4, 16, 2); b.fillStyle = "#c0c0c0"; b.fillRect(x + 15, y - 13, 2, 18);
  b.fillStyle = OUTLINE; b.fillRect(x + 6, y - 20, 20, 3); b.fillRect(x + 4, y - 18, 3, 6); b.fillRect(x + 25, y - 18, 3, 6);
  outlineRect(b, x + 2, y - 12, 7, 10, "#e3212b"); outlineRect(b, x + 23, y - 12, 7, 10, "#e3212b"); b.fillStyle = "#ff4d57"; b.fillRect(x + 3, y - 11, 2, 2); b.fillRect(x + 24, y - 11, 2, 2);
  b.fillStyle = "#e3212b"; b.fillRect(x + 6, y - 18, 20, 2);
  drawMusicNote(b, x + 30, y - 8 - (Math.floor(t / 600) % 3), "#ffd166");
}
function drawWallDecorMusic(b, t) {
  // acoustic foam on the kitchen wall
  for (let i = 0; i < 6; i++) for (let j = 0; j < 2; j++) { const px = 8 + i * 22, py = 8 + j * 18; b.fillStyle = "#1f1f27"; b.fillRect(px, py, 20, 16); b.fillStyle = "#2b2b35"; for (let k = 0; k < 4; k++) b.fillRect(px + 2 + k * 5, py + 2 + (k % 2) * 6, 3, 6); }
  // wall speakers flanking the windows
  for (const px of [8 * TILE + 2, 20 * TILE + 10]) { outlineRect(b, px, 10, 20, 34, "#1c1c22"); disc(b, px + 10, 20, 4, "#3a3a48"); disc(b, px + 10, 34, 6, "#3a3a48"); disc(b, px + 10, 34, 2 + (Math.floor(t / 150) % 2), "#4c4c5c"); }
  // YouTube plaque between the windows + ON AIR sign
  drawYtLogo(b, 13 * TILE + 2, 12, 40, 28);
  b.fillStyle = "#ffffff"; b.fillRect(13 * TILE + 4, 44, 36, 1);
  const on = Math.floor(t / 800) % 2 === 0;
  outlineRect(b, 15 * TILE + 2, 12, 52, 20, on ? "#5a0f14" : "#26262e"); b.fillStyle = on ? "#ff3b3b" : "#4a2a2a";
  // "ON AIR" in 3x5 pixel letters
  const glyph = { O: ["111", "101", "101", "101", "111"], N: ["101", "111", "111", "111", "101"], A: ["010", "101", "111", "101", "101"], I: ["111", "010", "010", "010", "111"], R: ["110", "101", "110", "101", "101"] };
  let gx = 15 * TILE + 6; for (const ch of "ON AIR") { if (ch !== " ") { const g = glyph[ch]; for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (g[r][c] === "1") b.fillRect(gx + c * 2, 17 + r * 2, 2, 2); } gx += ch === " " ? 4 : 8; }
  if (on) { b.fillStyle = "rgba(255,59,59,.10)"; b.fillRect(15 * TILE - 6, 4, 68, 40); }
  // floating notes rising from the plaque
  for (let i = 0; i < 3; i++) { const ph = ((t / 900) + i / 3) % 1; drawMusicNote(b, 13 * TILE + 46 + i * 6 + Math.round(Math.sin(ph * 6 + i) * 2), 40 - Math.round(ph * 28), ["#ffd166", "#ff3b3b", "#61afef"][i]); }
  // creator award plaques (silver, gold, diamond) on the meeting wall
  for (let i = 0; i < 3; i++) { const px = 23 * TILE + 4 + i * 34; outlineRect(b, px, 10, 28, 36, "#3a3a48"); b.fillStyle = "#1a1a22"; b.fillRect(px + 2, 12, 24, 32); drawYtLogo(b, px + 6, 18, 16, 12, ["#c0c0c0", "#ffd166", "#bfe8ff"][i]); b.fillStyle = "#e8e6e0"; b.fillRect(px + 6, 36, 16, 1); b.fillRect(px + 9, 39, 10, 1); }
  // subscriber counter
  const sx = 26 * TILE + 14; outlineRect(b, sx, 12, 108, 30, "#0a0c10"); b.fillStyle = "#ff3b3b"; b.fillRect(sx + 4, 16, 24, 5); b.fillStyle = "#e8e6e0"; b.fillRect(sx + 32, 17, 40, 3);
  const digits = ["1", ".", "2", "M"]; let dx = sx + 8;
  const seg7 = { 1: [0, 1, 1, 0, 0, 0, 0], 2: [1, 1, 0, 1, 1, 0, 1] };
  for (const d of digits) {
    if (d === ".") { b.fillStyle = "#ff3b3b"; b.fillRect(dx, 36, 2, 2); dx += 6; continue; }
    if (d === "M") { b.fillStyle = "#ff3b3b"; b.fillRect(dx, 25, 2, 13); b.fillRect(dx + 8, 25, 2, 13); b.fillRect(dx + 2, 27, 2, 3); b.fillRect(dx + 6, 27, 2, 3); b.fillRect(dx + 4, 30, 2, 3); dx += 14; continue; }
    const s = seg7[d]; b.fillStyle = "#ff3b3b"; if (s[0]) b.fillRect(dx + 1, 24, 6, 2); if (s[1]) b.fillRect(dx + 6, 25, 2, 6); if (s[2]) b.fillRect(dx + 6, 32, 2, 6); if (s[3]) b.fillRect(dx + 1, 37, 6, 2); if (s[4]) b.fillRect(dx, 32, 2, 6); if (s[5]) b.fillRect(dx, 25, 2, 6); if (s[6]) b.fillRect(dx + 1, 31, 6, 2); dx += 12;
  }
  drawVu(b, sx + 60, 38, 11, t, 3);
  // clock on the kitchen wall
  drawClock(b, 6 * TILE + 6, 28);
}
PROPS.music = { counter: drawStudioBar, fridge: drawSpeakerStack, roundTable: drawDrumKit, meetingTable: drawMixingConsole, sofa: drawStudioCouch, coffeeTable: drawSynth, bookshelf: drawVinylShelf, lamp: drawMicStand, cabinets: drawGuitarRack, boxes: drawAmpStack, printer: drawCameraRig, cooler: drawRingLight, coffeeStation: drawHeadphoneStand, wallDecor: drawWallDecorMusic };
THEME_NAMES.push("music");

// --- travel theme (travel agency / Footyprint) ---
THEMES.travel = { wall: { face: "#5f9fb0", top: "#74b3c3", base: "#4f8797", base2: "#3c6874", edge: "#2f525c", inner: "#7fb3c1", innerLight: "#9cc7d3", innerDark: "#3a5f69" }, floors: { kitchen: "tiles", office: "wood", meeting: "carpet", lounge: "sand", archive: "concrete" }, rug: "compass" };

function drawSand(b, x, y, w, h) {
  b.fillStyle = "#ecdcae"; b.fillRect(x, y, w, h);
  b.fillStyle = "#e2cf9a"; for (let py = y + 3; py < y + h; py += 7) for (let px = x + ((py / 7) % 3) * 3; px < x + w; px += 9) b.fillRect(px, py, 2, 1);
  b.fillStyle = "#f6ebc8"; for (let py = y + 9; py < y + h; py += 13) for (let px = x + ((py / 13) % 2) * 6; px < x + w; px += 17) b.fillRect(px, py, 1, 1);
}
let compassRug = null;
function drawCompassRug(b, x, y) {
  if (!compassRug) {
    compassRug = document.createElement("canvas"); compassRug.width = 144; compassRug.height = 144;
    const g = compassRug.getContext("2d");
    disc(g, 72, 72, 70, "#2f6f8f"); disc(g, 72, 72, 66, "#f4efe1"); disc(g, 72, 72, 58, "#2f6f8f"); disc(g, 72, 72, 54, "#f4efe1");
    g.fillStyle = "#d9d0b8"; for (let a = 0; a < 32; a++) { const r = a % 4 === 0 ? 44 : 50; g.fillRect(72 + Math.round(Math.cos(a / 32 * Math.PI * 2) * r) - 1, 72 + Math.round(Math.sin(a / 32 * Math.PI * 2) * r) - 1, 2, 2); }
    const star = (col, len, rot) => { for (let i = 0; i < 4; i++) { const a = rot + i * Math.PI / 2; for (let d = 0; d < len; d++) { const wdt = Math.max(1, Math.round((len - d) / len * 7)); const px = 72 + Math.cos(a) * d, py = 72 + Math.sin(a) * d; g.fillStyle = col; g.fillRect(Math.round(px - Math.sin(a) * wdt / 2), Math.round(py + Math.cos(a) * wdt / 2), 1, 1); for (let k = -wdt; k <= wdt; k++) g.fillRect(Math.round(px - Math.sin(a) * k / 2), Math.round(py + Math.cos(a) * k / 2), 1, 1); } } };
    star("#c9b98a", 30, Math.PI / 4); star("#1f3a5a", 44, 0);
    g.fillStyle = "#d9534f"; for (let d = 0; d < 44; d++) { const wdt = Math.max(1, Math.round((44 - d) / 44 * 7)); for (let k = -wdt; k <= wdt; k++) g.fillRect(72 + Math.round(k / 2), 72 - d, 1, 1); }
    disc(g, 72, 72, 4, "#1f3a5a"); disc(g, 72, 72, 2, "#f4efe1");
    g.fillStyle = "#1f3a5a"; g.fillRect(70, 8, 2, 8); g.fillRect(70, 8, 1, 1); g.fillRect(72, 9, 1, 2); g.fillRect(73, 11, 1, 2); g.fillRect(74, 8, 1, 8); // N
  }
  b.drawImage(compassRug, x, y);
}
function drawSuitcase(b, x, y, w, h, col, handle = true) {
  outlineRect(b, x, y, w, h, col); b.fillStyle = shade(col, -30); b.fillRect(x, y + Math.floor(h / 2) - 1, w, 2); b.fillRect(x + 3, y, 2, h); b.fillRect(x + w - 5, y, 2, h);
  b.fillStyle = shade(col, 28); b.fillRect(x + 1, y + 1, w - 2, 1);
  if (handle) { b.fillStyle = OUTLINE; b.fillRect(x + Math.floor(w / 2) - 4, y - 3, 8, 3); b.fillStyle = col; b.fillRect(x + Math.floor(w / 2) - 2, y - 2, 4, 1); }
}
function drawPlaneIcon(b, x, y, col, dir = 1) { // small side-view plane, dir 1 = flying right
  b.fillStyle = col; b.fillRect(x, y + 2, 12, 2); b.fillRect(x + 10 * (dir > 0 ? 1 : 0) + (dir > 0 ? 0 : 0), y + 1, 2, 1);
  b.fillRect(x + (dir > 0 ? 4 : 6), y, 3, 2); b.fillRect(x + (dir > 0 ? 3 : 7), y + 4, 4, 1); b.fillRect(x + (dir > 0 ? 0 : 10), y - 1, 2, 3);
}
function drawTravelCafe(b, x, y, t) { // kitchen counter: airport café
  outlineRect(b, x, y + 6, 160, 26, "#8fbfa6"); b.fillStyle = "#f4efe1"; b.fillRect(x, y + 6, 160, 4); b.fillStyle = "#5f8f78"; b.fillRect(x, y + 30, 160, 2);
  for (let i = 0; i < 5; i++) { b.fillStyle = "#6fa58a"; b.fillRect(x + i * 32 + 2, y + 14, 28, 16); b.fillStyle = "#f4efe1"; b.fillRect(x + i * 32 + 13, y + 20, 6, 2); }
  // espresso machine
  outlineRect(b, x + 8, y - 12, 26, 20, "#c9c9cf"); b.fillStyle = "#8a8a94"; b.fillRect(x + 8, y - 12, 26, 3); b.fillStyle = "#d9534f"; b.fillRect(x + 12, y - 6, 6, 2); drawLed(b, x + 28, y - 7, Math.floor(t / 700) % 2, "#4ade80");
  b.fillStyle = "rgba(255,255,255,.5)"; b.fillRect(x + 14, y - 20 - (Math.floor(t / 300) % 3), 1, 3);
  // cups, cake stand, juice
  for (const [mx, c] of [[42, "#f4efe1"], [54, "#2f6f8f"]]) { outlineRect(b, x + mx, y - 3, 8, 8, c); b.fillStyle = OUTLINE; b.fillRect(x + mx + 9, y - 1, 2, 4); }
  b.fillStyle = OUTLINE; b.fillRect(x + 76, y - 8, 24, 2); b.fillRect(x + 86, y - 6, 4, 6); b.fillStyle = "#f4efe1"; b.fillRect(x + 77, y - 7, 22, 1);
  outlineRect(b, x + 80, y - 16, 16, 8, "#e0a458"); b.fillStyle = "#c97a3a"; b.fillRect(x + 82, y - 14, 12, 1); b.fillStyle = "#f4efe1"; b.fillRect(x + 84, y - 16, 8, 2);
  for (let i = 0; i < 3; i++) { const c = ["#ff8c42", "#ffd166", "#4ade80"][i]; outlineRect(b, x + 112 + i * 12, y - 10, 8, 16, c); b.fillStyle = "#f4efe1"; b.fillRect(x + 114 + i * 12, y - 12, 4, 2); b.fillStyle = OUTLINE; b.fillRect(x + 118 + i * 12, y - 16, 1, 6); }
  // little "i" info sign at the end
  outlineRect(b, x + 146, y - 14, 12, 12, "#2f6f8f"); b.fillStyle = "#f4efe1"; b.fillRect(x + 151, y - 11, 2, 2); b.fillRect(x + 151, y - 8, 2, 5);
}
function drawGlobe(b, x, y, t = 0) { // fridge slot: globe on a stand
  outlineRect(b, x + 8, y + 20, 16, 6, "#5c3d22"); b.fillStyle = OUTLINE; b.fillRect(x + 14, y + 8, 4, 12); b.fillStyle = "#c9a781"; b.fillRect(x + 15, y + 9, 2, 10);
  b.fillStyle = OUTLINE; b.fillRect(x + 4, y - 20, 3, 30); b.fillRect(x + 4, y - 22, 12, 3); b.fillRect(x + 4, y + 8, 12, 3); b.fillStyle = "#c9a781"; b.fillRect(x + 5, y - 19, 1, 28);
  disc(b, x + 17, y - 6, 13, OUTLINE); disc(b, x + 17, y - 6, 12, "#3b8bc9");
  const spin = Math.floor(t / 250) % 24;
  b.fillStyle = "#4ade80";
  for (const [ox, oy, w, h] of [[-9, -8, 7, 5], [-6, -3, 5, 8], [1, -9, 8, 4], [3, -4, 5, 6], [5, 3, 4, 4], [-2, 5, 4, 3]]) { const px = ((ox + spin) % 24) - 12; if (px + w <= 10 && px >= -10) b.fillRect(x + 17 + px, y - 6 + oy, w, h); }
  b.fillStyle = "rgba(255,255,255,.25)"; b.fillRect(x + 9, y - 14, 4, 2); b.fillRect(x + 8, y - 12, 2, 4);
}
function drawCafeTable(b, x, y) { // roundTable slot: café table with a map
  b.fillStyle = OUTLINE; b.fillRect(x + 6, y + 2, 52, 26); b.fillRect(x + 2, y + 6, 60, 18);
  b.fillStyle = "#f4efe1"; b.fillRect(x + 7, y + 3, 50, 24); b.fillRect(x + 3, y + 7, 58, 16);
  b.fillStyle = "#d9d0b8"; b.fillRect(x + 7, y + 23, 50, 4); b.fillStyle = OUTLINE; b.fillRect(x + 28, y + 26, 8, 6);
  // folded map
  outlineRect(b, x + 10, y + 7, 26, 14, "#bfe3f5"); b.fillStyle = "#4ade80"; b.fillRect(x + 13, y + 9, 6, 4); b.fillRect(x + 22, y + 12, 8, 5); b.fillRect(x + 28, y + 8, 4, 3); b.fillStyle = "#d9534f"; b.fillRect(x + 16, y + 10, 2, 2); b.fillRect(x + 25, y + 14, 2, 2);
  b.fillStyle = "#8fa7b8"; b.fillRect(x + 22, y + 7, 1, 14);
  // coffee + compass
  outlineRect(b, x + 42, y + 9, 8, 7, "#f4efe1"); b.fillStyle = "#6b4a2b"; b.fillRect(x + 43, y + 10, 6, 2); b.fillStyle = OUTLINE; b.fillRect(x + 51, y + 11, 2, 3);
  disc(b, x + 46, y + 22, 4, OUTLINE); disc(b, x + 46, y + 22, 3, "#c9a781"); b.fillStyle = "#d9534f"; b.fillRect(x + 46, y + 20, 1, 2); b.fillStyle = "#1f3a5a"; b.fillRect(x + 46, y + 22, 1, 2);
}
function drawMapTable(b, x, y, t = 0) { // meeting table slot 128x48: world map table
  outlineRect(b, x + 4, y + 4, 120, 48, "#5c3d22"); b.fillStyle = "#7a5230"; b.fillRect(x + 4, y + 4, 120, 4); b.fillStyle = "#3e2a18"; b.fillRect(x + 4, y + 46, 120, 6);
  outlineRect(b, x + 10, y + 10, 108, 34, "#bfe3f5");
  b.fillStyle = "#6fc276";
  for (const [ox, oy, w, h] of [[4, 4, 16, 10], [8, 14, 10, 12], [26, 3, 20, 8], [30, 11, 12, 6], [46, 4, 30, 10], [52, 14, 10, 8], [78, 16, 12, 6], [64, 24, 8, 4], [88, 6, 10, 8]]) b.fillRect(x + 10 + ox, y + 10 + oy, w, h);
  b.fillStyle = "#3f9d4f"; for (const [ox, oy] of [[6, 6], [30, 5], [50, 7], [90, 8]]) b.fillRect(x + 10 + ox, y + 10 + oy, 4, 2);
  // route string with pins
  const pins = [[14, 9], [40, 7], [62, 8], [84, 19]];
  b.fillStyle = "#d9534f"; for (let i = 0; i < pins.length - 1; i++) { const [ax, ay] = pins[i], [bx, by] = pins[i + 1]; for (let k = 0; k < 8; k++) if (k % 2 === 0) b.fillRect(x + 10 + Math.round(ax + (bx - ax) * k / 8), y + 10 + Math.round(ay + (by - ay) * k / 8), 1, 1); }
  for (const [px, py] of pins) { b.fillStyle = OUTLINE; b.fillRect(x + 10 + px, y + 10 + py - 4, 1, 4); b.fillStyle = "#d9534f"; b.fillRect(x + 9 + px, y + 10 + py - 6, 3, 3); }
  // model plane moving along the route
  const seg = Math.floor(t / 2400) % (pins.length - 1), f = (t % 2400) / 2400; const [ax, ay] = pins[seg], [bx, by] = pins[seg + 1];
  drawPlaneIcon(b, x + 10 + Math.round(ax + (bx - ax) * f) - 4, y + 10 + Math.round(ay + (by - ay) * f) - 6, "#f4efe1", 1);
  // magnifier + tickets
  disc(b, x + 104, y + 36, 5, OUTLINE); disc(b, x + 104, y + 36, 4, "rgba(255,255,255,.55)"); b.fillStyle = OUTLINE; b.fillRect(x + 108, y + 40, 6, 2);
  outlineRect(b, x + 14, y + 36, 14, 6, "#ffd166"); b.fillStyle = "#d9534f"; b.fillRect(x + 16, y + 38, 6, 1); b.fillStyle = OUTLINE; b.fillRect(x + 24, y + 37, 1, 4);
}
function drawBeachSofa(b, x, y) { // sofa slot: rattan sofa under a beach umbrella
  // umbrella
  b.fillStyle = OUTLINE; b.fillRect(x + 47, y - 46, 3, 54); b.fillStyle = "#c9a781"; b.fillRect(x + 48, y - 45, 1, 52);
  for (let r = 0; r < 12; r++) { const half = Math.round(Math.sqrt(12 * 12 - (12 - r) * (12 - r)) * 3.6); b.fillStyle = OUTLINE; b.fillRect(x + 48 - half - 1, y - 58 + r, half * 2 + 3, 1); }
  for (let r = 0; r < 11; r++) { const half = Math.round(Math.sqrt(12 * 12 - (12 - r) * (12 - r)) * 3.6); for (let px = -half; px <= half; px++) { b.fillStyle = Math.floor((px + half) / 11) % 2 ? "#f4efe1" : "#d9534f"; b.fillRect(x + 48 + px, y - 57 + r, 1, 1); } }
  b.fillStyle = "#f4efe1"; b.fillRect(x + 47, y - 62, 3, 5);
  // rattan sofa
  outlineRect(b, x + 2, y - 14, 92, 22, "#b98b52"); b.fillStyle = "#a67a45"; for (let i = 0; i < 11; i++) b.fillRect(x + 6 + i * 8, y - 12, 1, 18); b.fillStyle = "#d1a468"; b.fillRect(x + 2, y - 14, 92, 2);
  outlineRect(b, x, y + 6, 96, 22, "#b98b52"); b.fillStyle = "#3b8bc9"; b.fillRect(x + 6, y + 8, 26, 12); b.fillRect(x + 35, y + 8, 26, 12); b.fillRect(x + 64, y + 8, 26, 12);
  b.fillStyle = "#f4efe1"; for (const sx of [6, 35, 64]) { b.fillRect(x + sx + 6, y + 8, 3, 12); b.fillRect(x + sx + 16, y + 8, 3, 12); }
  b.fillStyle = "#a67a45"; b.fillRect(x, y + 22, 96, 6); outlineRect(b, x - 2, y + 2, 8, 24, "#b98b52"); outlineRect(b, x + 90, y + 2, 8, 24, "#b98b52");
}
function drawBambooTable(b, x, y) { // coffee table slot: bamboo table with cocktails + starfish
  outlineRect(b, x + 12, y + 8, 72, 16, "#c9a781"); b.fillStyle = "#b98b52"; for (let i = 0; i < 9; i++) b.fillRect(x + 14 + i * 8, y + 9, 1, 14); b.fillStyle = "#e0c89a"; b.fillRect(x + 12, y + 8, 72, 2);
  b.fillStyle = OUTLINE; b.fillRect(x + 16, y + 24, 3, 6); b.fillRect(x + 77, y + 24, 3, 6);
  for (const [cx, c] of [[24, "#ff8c42"], [40, "#4ade80"]]) { outlineRect(b, x + cx, y - 2, 8, 10, c); b.fillStyle = "#f4efe1"; b.fillRect(x + cx + 1, y - 1, 6, 2); b.fillStyle = OUTLINE; b.fillRect(x + cx + 3, y + 8, 2, 4); b.fillStyle = "#d9534f"; b.fillRect(x + cx + 5, y - 7, 5, 4); b.fillStyle = OUTLINE; b.fillRect(x + cx + 7, y - 4, 1, 4); }
  b.fillStyle = "#ff8c42"; b.fillRect(x + 60, y + 2, 2, 8); b.fillRect(x + 57, y + 5, 8, 2); b.fillRect(x + 58, y + 3, 1, 1); b.fillRect(x + 63, y + 3, 1, 1); b.fillRect(x + 58, y + 8, 1, 1); b.fillRect(x + 63, y + 8, 1, 1);
  b.fillStyle = "#f4efe1"; b.fillRect(x + 70, y + 4, 6, 4); b.fillStyle = "#e9c4d3"; b.fillRect(x + 71, y + 5, 4, 2);
}
function drawBrochureRack(b, x, y) { // bookshelf slot: brochure rack
  outlineRect(b, x + 2, y - 30, 28, 60, "#f4efe1"); b.fillStyle = "#d9d0b8"; b.fillRect(x + 4, y - 28, 24, 56);
  const cols = ["#3b8bc9", "#ff8c42", "#4ade80", "#d9534f", "#ffd166", "#c678dd"];
  for (let s = 0; s < 3; s++) { b.fillStyle = "#b9b09a"; b.fillRect(x + 4, y - 12 + s * 18 - 2, 24, 3); for (let i = 0; i < 3; i++) { const c = cols[(s * 3 + i) % cols.length]; outlineRect(b, x + 6 + i * 8, y - 26 + s * 18, 6, 13, c); b.fillStyle = "#f4efe1"; b.fillRect(x + 7 + i * 8, y - 24 + s * 18, 4, 1); b.fillRect(x + 7 + i * 8, y - 21 + s * 18, 3, 1); b.fillStyle = shade(c, -30); b.fillRect(x + 7 + i * 8, y - 17 + s * 18, 4, 3); } }
  drawPlaneIcon(b, x + 10, y - 38, "#2f6f8f", 1);
}
function drawPalm(b, x, y) { // lamp slot: palm tree in a pot
  outlineRect(b, x + 6, y + 14, 20, 14, "#c97a3a"); b.fillStyle = "#e0a458"; b.fillRect(x + 6, y + 14, 20, 3);
  b.fillStyle = OUTLINE; b.fillRect(x + 13, y - 26, 6, 40); b.fillStyle = "#a67a45"; b.fillRect(x + 14, y - 25, 4, 38); b.fillStyle = "#7a5230"; for (let i = 0; i < 6; i++) b.fillRect(x + 14, y - 22 + i * 6, 4, 1);
  const frond = (dx, dy, len, dir) => { for (let i = 0; i < len; i++) { const px = x + 16 + dx + Math.round(i * dir * 1.6), py = y - 26 + dy + Math.round(i * 0.7 + (i > len * 0.6 ? (i - len * 0.6) * 0.5 : 0)); b.fillStyle = OUTLINE; b.fillRect(px - 1, py - 1, 5, 5); } for (let i = 0; i < len; i++) { const px = x + 16 + dx + Math.round(i * dir * 1.6), py = y - 26 + dy + Math.round(i * 0.7 + (i > len * 0.6 ? (i - len * 0.6) * 0.5 : 0)); b.fillStyle = i % 2 ? "#3f9d4f" : "#4ade80"; b.fillRect(px, py, 3, 3); } };
  frond(0, -2, 12, -1); frond(0, -2, 12, 1); frond(0, -8, 10, -1); frond(0, -8, 10, 1); frond(-1, -10, 7, 0);
  b.fillStyle = "#7a5230"; b.fillRect(x + 12, y - 24, 3, 3); b.fillRect(x + 18, y - 23, 3, 3);
}
function drawLuggageShelf(b, x, y) { // cabinets slot (96 wide): stacked suitcases
  outlineRect(b, x + 2, y + 20, 92, 6, "#8a8a94"); b.fillStyle = "#c9c9cf"; b.fillRect(x + 2, y + 20, 92, 2);
  drawSuitcase(b, x + 6, y + 2, 26, 18, "#d9534f"); drawSuitcase(b, x + 36, y + 6, 22, 14, "#ffd166"); drawSuitcase(b, x + 62, y, 28, 20, "#3b8bc9");
  drawSuitcase(b, x + 10, y - 16, 20, 14, "#4ade80"); drawSuitcase(b, x + 40, y - 12, 18, 14, "#c678dd", false); drawSuitcase(b, x + 64, y - 18, 24, 14, "#ff8c42");
  b.fillStyle = "#f4efe1"; b.fillRect(x + 70, y + 6, 6, 4); b.fillRect(x + 14, y - 12, 5, 3); b.fillStyle = "#d9534f"; b.fillRect(x + 44, y - 8, 4, 4);
}
function drawLuggageCart(b, x, y) { // boxes slot (64 wide): trolley with suitcases
  b.fillStyle = OUTLINE; b.fillRect(x + 6, y + 22, 52, 3); b.fillRect(x + 52, y - 6, 3, 30); b.fillRect(x + 40, y - 8, 16, 3);
  b.fillStyle = "#8a8a94"; b.fillRect(x + 7, y + 23, 50, 1); b.fillRect(x + 53, y - 5, 1, 28);
  disc(b, x + 12, y + 26, 3, OUTLINE); disc(b, x + 12, y + 26, 2, "#3a3a40"); disc(b, x + 50, y + 26, 3, OUTLINE); disc(b, x + 50, y + 26, 2, "#3a3a40");
  drawSuitcase(b, x + 10, y + 6, 34, 16, "#2f6f8f", false); drawSuitcase(b, x + 14, y - 6, 26, 12, "#ff8c42", false); drawSuitcase(b, x + 20, y - 14, 16, 8, "#ffd166");
  b.fillStyle = "#f4efe1"; b.fillRect(x + 30, y + 10, 8, 5); b.fillStyle = "#d9534f"; b.fillRect(x + 32, y + 12, 4, 1);
}
function drawCheckinKiosk(b, x, y, t = 0) { // printer slot: check-in kiosk
  outlineRect(b, x + 18, y - 2, 28, 30, "#2f6f8f"); b.fillStyle = "#3f8fb0"; b.fillRect(x + 18, y - 2, 28, 3);
  outlineRect(b, x + 14, y - 22, 36, 22, "#1c1c22"); b.fillStyle = "#bfe3f5"; b.fillRect(x + 16, y - 20, 32, 18);
  b.fillStyle = "#2f6f8f"; b.fillRect(x + 18, y - 18, 20, 2); b.fillRect(x + 18, y - 14, 14, 1); b.fillRect(x + 18, y - 11, 24, 1);
  b.fillStyle = Math.floor(t / 600) % 2 ? "#4ade80" : "#3b8bc9"; b.fillRect(x + 18, y - 7, 28, 4); b.fillStyle = "#f4efe1"; b.fillRect(x + 22, y - 6, 12, 2);
  drawPlaneIcon(b, x + 34, y - 19, "#d9534f", 1);
  b.fillStyle = "#1c1c22"; b.fillRect(x + 22, y + 6, 20, 2); b.fillStyle = "#ffd166"; b.fillRect(x + 24, y + 8 + (Math.floor(t / 400) % 3), 16, 5); b.fillStyle = "#d9534f"; b.fillRect(x + 26, y + 10 + (Math.floor(t / 400) % 3), 8, 1);
  b.fillStyle = "#c9c9cf"; b.fillRect(x + 20, y + 16, 24, 1);
}
function drawSignpost(b, x, y) { // cooler slot: direction signpost
  outlineRect(b, x + 10, y + 22, 12, 6, "#7a5230"); b.fillStyle = OUTLINE; b.fillRect(x + 14, y - 34, 4, 56); b.fillStyle = "#a67a45"; b.fillRect(x + 15, y - 33, 2, 54);
  const arrow = (ay, w, col, dir) => { b.fillStyle = OUTLINE; b.fillRect(dir > 0 ? x + 12 : x + 20 - w, ay - 1, w + 1, 9); b.fillRect(dir > 0 ? x + 12 + w : x + 18 - w, ay + 1, 2, 5); b.fillRect(dir > 0 ? x + 14 + w : x + 16 - w, ay + 3, 1, 1); b.fillStyle = col; b.fillRect(dir > 0 ? x + 13 : x + 21 - w, ay, w - 1, 7); b.fillStyle = "#f4efe1"; b.fillRect(dir > 0 ? x + 16 : x + 23 - w, ay + 3, w - 8, 1); };
  arrow(y - 30, 20, "#d9534f", 1); arrow(y - 20, 24, "#3b8bc9", -1); arrow(y - 10, 18, "#4ade80", 1); arrow(y, 22, "#ff8c42", -1);
}
function drawCarryOn(b, x, y, t = 0) { // coffeeStation slot: rolling suitcase with stickers
  b.fillStyle = OUTLINE; b.fillRect(x + 10, y - 16, 3, 12); b.fillRect(x + 19, y - 16, 3, 12); b.fillRect(x + 10, y - 18, 12, 3);
  drawSuitcase(b, x + 6, y - 6, 20, 26, "#c678dd", false);
  b.fillStyle = "#ffd166"; b.fillRect(x + 9, y, 5, 4); b.fillStyle = "#4ade80"; b.fillRect(x + 17, y + 6, 6, 4); b.fillStyle = "#f4efe1"; b.fillRect(x + 10, y + 12, 6, 3);
  disc(b, x + 10, y + 22, 3, OUTLINE); disc(b, x + 10, y + 22, 2, "#3a3a40"); disc(b, x + 22, y + 22, 3, OUTLINE); disc(b, x + 22, y + 22, 2, "#3a3a40");
  b.fillStyle = "#2f6f8f"; b.fillRect(x + 28, y + 8, 8, 6); b.fillStyle = "#ffd166"; b.fillRect(x + 30, y + 10, 4, 2);
}
function drawClockOffset(b, ccx, ccy, offsetH, label) {
  const d = new Date(); const h = (d.getUTCHours() + offsetH + 24) % 24, m = d.getUTCMinutes();
  b.fillStyle = "#2b2b2b"; b.fillRect(ccx - 11, ccy - 11, 22, 22); b.fillStyle = "#f7f7f7"; b.fillRect(ccx - 9, ccy - 9, 18, 18);
  b.fillStyle = "#2b2b2b"; for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; b.fillRect(ccx + Math.round(Math.cos(a) * 7) - 1, ccy + Math.round(Math.sin(a) * 7) - 1, 2, 2); }
  const ha = ((h % 12) + m / 60) / 12 * Math.PI * 2 - Math.PI / 2, ma = m / 60 * Math.PI * 2 - Math.PI / 2;
  line(b, ccx, ccy, ccx + Math.cos(ha) * 4, ccy + Math.sin(ha) * 4, "#2b2b2b"); line(b, ccx, ccy, ccx + Math.cos(ma) * 6, ccy + Math.sin(ma) * 6, "#2b2b2b");
  b.fillStyle = label; b.fillRect(ccx - 6, ccy + 13, 12, 3);
}
function drawWallDecorTravel(b, t) {
  // kitchen wall: bunting flags + world clocks
  b.fillStyle = "#f4efe1"; b.fillRect(8, 8, 200, 1);
  const flags = [["#d9534f", "#f4efe1"], ["#3b8bc9", "#ffd166"], ["#4ade80", "#f4efe1"], ["#ff8c42", "#f4efe1"], ["#c678dd", "#ffd166"], ["#2f6f8f", "#d9534f"], ["#ffd166", "#3b8bc9"], ["#f4efe1", "#d9534f"]];
  for (let i = 0; i < 8; i++) { const px = 12 + i * 25; b.fillStyle = flags[i][0]; b.fillRect(px, 9, 14, 8); b.fillStyle = flags[i][1]; b.fillRect(px, 13, 14, 2); b.fillStyle = flags[i][0]; b.fillRect(px + 4, 17, 6, 3); }
  drawClockOffset(b, 40, 36, 3, "#d9534f"); drawClockOffset(b, 100, 36, 1, "#3b8bc9"); drawClockOffset(b, 160, 36, -4, "#ffd166");
  // Footyprint poster (footprint icon) on the office wall, left of the first window
  outlineRect(b, 8 * TILE - 2, 10, 26, 36, "#2f6f8f"); b.fillStyle = "#3f8fb0"; b.fillRect(8 * TILE, 12, 22, 32);
  const fx = 8 * TILE + 6, fy = 16; b.fillStyle = "#f4efe1"; b.fillRect(fx + 2, fy + 8, 8, 12); b.fillRect(fx + 3, fy + 20, 6, 4); b.fillRect(fx + 1, fy + 3, 3, 4); b.fillRect(fx + 5, fy + 2, 2, 3); b.fillRect(fx + 8, fy + 3, 2, 3); b.fillRect(fx + 11, fy + 5, 2, 3);
  b.fillStyle = "#ffd166"; b.fillRect(fx + 2, fy + 26, 10, 1); b.fillRect(fx + 4, fy + 28, 6, 1);
  // world map mural between the windows with blinking pins + a plane on its route
  const mx = 9 * TILE + 102, my = 8; outlineRect(b, mx, my, 148, 44, "#2f6f8f"); b.fillStyle = "#3b8bc9"; b.fillRect(mx + 2, my + 2, 144, 40);
  b.fillStyle = "#6fc276";
  for (const [ox, oy, w, h] of [[8, 6, 24, 14], [14, 20, 12, 16], [40, 4, 30, 10], [44, 14, 14, 8], [70, 6, 44, 14], [84, 20, 12, 10], [118, 26, 16, 8], [96, 30, 8, 4], [128, 8, 14, 10]]) b.fillRect(mx + 2 + ox, my + 2 + oy, w, h);
  b.fillStyle = "#3f9d4f"; for (const [ox, oy] of [[12, 10], [44, 7], [76, 10], [132, 12]]) b.fillRect(mx + 2 + ox, my + 2 + oy, 5, 2);
  const pins = [[20, 12], [50, 9], [80, 12], [124, 28]];
  b.fillStyle = "#f4efe1"; for (let i = 0; i < pins.length - 1; i++) { const [ax, ay] = pins[i], [bx, by] = pins[i + 1]; for (let k = 0; k < 10; k += 2) b.fillRect(mx + 2 + Math.round(ax + (bx - ax) * k / 10), my + 2 + Math.round(ay + (by - ay) * k / 10), 1, 1); }
  pins.forEach(([px, py], i) => { const on = Math.floor(t / 500) % pins.length === i; b.fillStyle = on ? "#ffd166" : "#d9534f"; b.fillRect(mx + 1 + px, my + 1 + py, 3, 3); if (on) { b.fillStyle = "rgba(255,209,102,.25)"; b.fillRect(mx - 1 + px, my - 1 + py, 7, 7); } });
  const seg = Math.floor(t / 2000) % (pins.length - 1), f = (t % 2000) / 2000; const [ax, ay] = pins[seg], [bx, by] = pins[seg + 1];
  drawPlaneIcon(b, mx + 2 + Math.round(ax + (bx - ax) * f) - 5, my + 2 + Math.round(ay + (by - ay) * f) - 6, "#f4efe1", 1);
  // departures board on the meeting wall
  const dx = 23 * TILE + 4; outlineRect(b, dx, 8, 200, 42, "#1c1e24"); b.fillStyle = "#0a0c10"; b.fillRect(dx + 3, 11, 194, 36);
  b.fillStyle = "#ffd166"; b.fillRect(dx + 8, 14, 44, 3); drawPlaneIcon(b, dx + 180, 12, "#ffd166", 1);
  const rows = 4; for (let r = 0; r < rows; r++) { const flip = Math.floor((t / 900 + r * 0.7)) % 6; const y = 21 + r * 6; b.fillStyle = "#e8e6e0"; b.fillRect(dx + 8, y, 20 + ((r * 7 + flip) % 3) * 6, 2); b.fillRect(dx + 60, y, 24 + ((r * 5 + flip) % 4) * 5, 2); b.fillStyle = flip === r ? "#4ade80" : (r === 2 && flip === 5 ? "#d9534f" : "#ffd166"); b.fillRect(dx + 120, y, 16, 2); b.fillStyle = "#8fa7b8"; b.fillRect(dx + 150, y, 10 + ((r + flip) % 3) * 4, 2); }
  // clock in the office
  drawClock(b, 21 * TILE + 8, 28);
}
PROPS.travel = { counter: drawTravelCafe, fridge: drawGlobe, roundTable: drawCafeTable, meetingTable: drawMapTable, sofa: drawBeachSofa, coffeeTable: drawBambooTable, bookshelf: drawBrochureRack, lamp: drawPalm, cabinets: drawLuggageShelf, boxes: drawLuggageCart, printer: drawCheckinKiosk, cooler: drawSignpost, coffeeStation: drawCarryOn, wallDecor: drawWallDecorTravel };
THEME_NAMES.push("travel");

// ---------- theme previews (for the office picker) ----------
function renderThemePreview(theme, width = 240) {
  const buf = document.createElement("canvas");
  buf.width = LW; buf.height = LH;
  const b = buf.getContext("2d");
  const st = buildStaticFor(theme);
  drawFloors(b, theme);
  drawWalls(b, st.blocked, st.doors, 5000, theme);
  const items = st.decor.map((d) => ({ y: d.y, draw: () => d.draw(b, 5000) }));
  // a couple of desks so the preview reads as an office
  for (const seat of [{ tx: 11, ty: 5 }, { tx: 17, ty: 5 }, { tx: 11, ty: 11 }, { tx: 17, ty: 11 }]) {
    const feet = (seat.ty + 1) * TILE;
    items.push({ y: feet - 24, draw: () => drawChair(b, seat.tx * TILE, feet) });
    items.push({ y: feet + TILE + 6, draw: () => drawDesk(b, { seat, tx: -1, ty: -1, path: [], status: "idle", color: "#61afef", look: {}, seed: 0 }, 5000) });
  }
  items.sort((a, c) => a.y - c.y);
  for (const it of items) it.draw();
  const out = document.createElement("canvas");
  out.width = width; out.height = Math.round(width * LH / LW);
  const g = out.getContext("2d");
  g.imageSmoothingEnabled = true;
  g.drawImage(buf, 0, 0, out.width, out.height);
  return out.toDataURL();
}
window.renderThemePreview = renderThemePreview;
window.THEME_NAMES = THEME_NAMES;

// ---------- characters (32x48 box, feet at oy+48, slim ~3.5 heads tall) ----------
function drawPerson(b, ox, oy, e, o) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) personShapes(b, ox + dx, oy + dy, e, o, OUTLINE);
  personShapes(b, ox, oy, e, o, null);
}

// Normalizes look fields (older configs used accessory: "glasses" and beard: true/false).
const SHOE_DEFAULT = { dark: "#26222a", sneakers: "#f2f2f2", hightops: "#c0392b", boots: "#5a3a22", loafers: "#5a3a22", sandals: "#c9a074", heels: "#1c1a20" };
function shoeDefault(style) { return SHOE_DEFAULT[style] || SHOE_DEFAULT.dark; }
const PANTS_LIKE = ["pants", "cargo", "joggers"];
const SCALP = ["bald", "balding"];   // no hair on top of the head
const SHAVED = ["buzz", "mohawk"];   // base hair drawn in a faded tone
function outfit(L) {
  const glasses = L.glasses && L.glasses !== "none" ? L.glasses : L.accessory === "glasses" ? "square" : "none";
  const topStyle = L.blazer ? "blazer" : L.topStyle || "tshirt";
  const bottomStyle = topStyle === "dress" ? "dress" : L.bottomStyle || "pants";
  const shoes = L.shoes || "dark";
  const beard = typeof L.beard === "string" ? L.beard : L.beard ? "full" : "none";
  const hat = L.hat && L.hat !== "none" ? L.hat : "none";
  let hairStyle = L.hairStyle || "short";
  if (hat !== "none" && hairStyle === "mohawk") hairStyle = "buzz";
  if (hat !== "none" && hairStyle === "spiky") hairStyle = "short";
  return {
    glasses, topStyle, bottomStyle, shoes, beard, hat, hairStyle,
    shoeColor: L.shoeColor || shoeDefault(shoes),
    eyes: L.eyes || (L.fem ? "#4a9de0" : "#3b2412"),
    hatColor: L.hatColor || "#3f51b5",
    tie: L.tie || "#8b1e2d",
    beardColor: L.beardColor || L.hair,
  };
}

// Body proportions: torso x/width, arm x (left/right) & width, leg x (left/right) & width, side-view torso x/width.
function bodyParams(body) {
  switch (body) {
    case "slim": return { tx: 11, tw: 10, axL: 8, axR: 21, aw: 3, lxL: 11, lxR: 17, lw: 4, sx: 12, sw: 8, belly: false, shoulders: false };
    case "muscular": return { tx: 9, tw: 14, axL: 5, axR: 23, aw: 4, lxL: 9, lxR: 17, lw: 6, sx: 11, sw: 11, belly: false, shoulders: true };
    case "heavy": return { tx: 8, tw: 16, axL: 4, axR: 25, aw: 3, lxL: 9, lxR: 17, lw: 6, sx: 10, sw: 13, belly: true, shoulders: false };
    default: return { tx: 10, tw: 12, axL: 7, axR: 22, aw: 3, lxL: 10, lxR: 17, lw: 5, sx: 12, sw: 9, belly: false, shoulders: false };
  }
}

function personShapes(b, ox, oy, e, o, mono) {
  const L = e.look;
  const F = outfit(L);
  const P = bodyParams(L.body);
  const flip = o.dir === "left";
  if (flip) { b.save(); b.translate(ox * 2 + 32, 0); b.scale(-1, 1); }
  const dir = flip ? "right" : o.dir;
  const C = (col) => { b.fillStyle = mono || col; };
  const R = (x, y, w, h) => b.fillRect(ox + x, oy + y, w, h);
  const suit = F.topStyle === "suit";
  const skin = L.skin, hair = L.hair, top = L.top, bottom = suit ? top : L.bottom || "#2f3548";
  const topDark = shade(top, -40), topLight = shade(top, 28), topMid = shade(top, -18);
  const hairLight = shade(hair, 38), hairDark = shade(hair, -28);
  const skinDark = shade(skin, -30), skinLight = shade(skin, 18);
  const bottomDark = shade(bottom, -26), bottomLight = shade(bottom, 16);
  const hatDark = shade(F.hatColor, -35), hatLight = shade(F.hatColor, 30);
  const hs = F.hairStyle;
  const scalp = SCALP.includes(hs);
  const hairBase = SHAVED.includes(hs) ? mix(skin, hair, 0.55) : hair;
  const beardC = F.beardColor, beardLight = shade(beardC, 38);
  const stubble = mix(skin, beardC, 0.35);
  const sleeveC = F.topStyle === "tank" ? skin : top;
  const pantsLike = PANTS_LIKE.includes(F.bottomStyle);
  const legCloth = pantsLike || F.bottomStyle === "bermuda";
  const sitting = ["sit", "type", "wave", "slump", "sip"].includes(o.anim);
  const sitFree = o.anim === "sitfree";
  const walking = o.anim === "walk";
  const f = walking ? o.frame : 0;
  const bob = walking ? (f === 1 || f === 3 ? 1 : 0) : (Math.floor(o.t / 1200) % 2 === 0 ? 1 : 0);
  const blink = Math.floor((o.t + (o.seed || 0)) / 3400) % 18 === 0;
  const slump = o.anim === "slump" ? 3 : 0;
  const H = bob + slump; // head offset
  const T = bob;         // torso offset
  const clothColor = F.bottomStyle === "dress" ? top : bottom;
  const clothDark = F.bottomStyle === "dress" ? topDark : bottomDark;
  const { tx, tw, axL, axR, aw, lxL, lxR, lw } = P;
  const cx = tx + Math.floor(tw / 2); // torso center
  const fem = L.fem && F.topStyle !== "blazer" && F.topStyle !== "hoodie" && !suit && !P.belly && !P.shoulders;

  // ---- shoes; origin = top-left, width w; `side` = profile view (toe points right) ----
  const shoe = (x, y, w = lw + 1, side = false) => {
    const c = F.shoeColor, cD = shade(c, -40), cL = shade(c, 30);
    const sole = lum(c) > 150 ? "#9a9a9a" : "#e8e8e8";
    switch (F.shoes) {
      case "sneakers": C(c); R(x, y, w, 4); C(e.color || top); R(x + 1, y + 1, w - 2, 1); C(sole); R(x, y + 3, w, 1); break;
      case "hightops": C(c); R(x, y - 2, w, 5); C(cL); R(x + 1, y - 1, w - 2, 1); R(x + 1, y + 1, w - 2, 1); C(sole); R(x, y + 3, w, 1); break;
      case "boots": C(c); R(x, y - 3, w, 7); C(cD); R(x, y + 3, w, 1); C(cL); R(x + 2, y - 2, 1, 4); break;
      case "loafers": C(skin); R(x + 1, y, w - 2, 1); C(c); R(x, y + 1, w, 3); C(cD); R(x + 1, y + 1, w - 2, 1); R(x, y + 3, w, 1); C("#e0b030"); R(x + (w >> 1), y + 1, 1, 1); break;
      case "sandals": C(skin); R(x, y, w, 3); C(c); R(x + 1, y + 1, w - 2, 1); R(x, y + 3, w, 1); C(cD); R(x + (w >> 1), y, 1, 1); break;
      case "heels":
        // ankle strap, slim body, stiletto heel at the back and a pointed toe
        if (side) { C(cD); R(x + 1, y - 1, w - 2, 1); C(c); R(x, y, w, 2); R(x + w - 2, y + 2, 2, 2); C(cD); R(x, y + 2, 1, 2); C(cL); R(x + 2, y, 2, 1); }
        else { C(cD); R(x + 1, y - 1, w - 1, 1); C(c); R(x + 1, y, w - 1, 3); C(cL); R(x + 2, y, w - 4, 1); C(cD); R(x + 1, y + 3, 1, 1); R(x + 3, y + 3, w - 4, 1); }
        break;
      default: C(c); R(x, y, w, 4); C(cL); R(x + 1, y, w - 2, 1);
    }
  };

  // ---- legs (front/back) ----
  const legsFront = () => {
    if (sitting) {
      C(clothColor); R(tx, 29, tw, 5);
      C(clothDark); R(tx, 33, tw, 1);
      return;
    }
    if (sitFree) {
      C(clothColor); R(tx, 29, tw, 5); C(clothDark); R(tx, 33, tw, 1);
      if (legCloth) { C(bottom); R(lxL, 34, lw, 7); R(lxR, 34, lw, 7); C(bottomDark); R(lxL + lw - 2, 34, 2, 7); R(lxR + lw - 2, 34, 2, 7); }
      else { C(skin); R(lxL, 34, lw, 7); R(lxR, 34, lw, 7); C(skinDark); R(lxL + lw - 2, 34, 2, 7); R(lxR + lw - 2, 34, 2, 7); }
      shoe(lxL - 1, 41); shoe(lxR, 41);
      return;
    }
    const lift = walking ? [0, 2, 0, -2][f] : 0;
    const lL = Math.max(0, lift), lR = Math.max(0, -lift);
    if (pantsLike) {
      C(bottom); R(lxL, 29, lw, 15 - lL); R(lxR, 29, lw, 15 - lR);
      C(bottomDark); R(lxL + lw - 2, 29, 2, 15 - lL); R(lxR + lw - 2, 29, 2, 15 - lR);
      if (F.bottomStyle === "cargo") {
        C(bottomLight); R(lxL, 35, lw - 1, 3); R(lxR + 1, 35, lw - 1, 3);
        C(bottomDark); R(lxL, 34, lw - 1, 1); R(lxR + 1, 34, lw - 1, 1); R(lxL, 38, lw - 1, 1); R(lxR + 1, 38, lw - 1, 1);
      } else if (F.bottomStyle === "joggers") {
        C(shade(bottom, 50)); R(lxL, 29, 1, 12 - lL); R(lxR + lw - 1, 29, 1, 12 - lR);
        C(bottomDark); R(lxL, 41 - lL, lw, 3); R(lxR, 41 - lR, lw, 3);
      }
    } else if (F.bottomStyle === "shorts" || F.bottomStyle === "bermuda") {
      const ch = F.bottomStyle === "bermuda" ? 9 : 6;
      C(bottom); R(lxL, 29, lw, ch); R(lxR, 29, lw, ch);
      C(bottomDark); R(lxL + lw - 2, 29, 2, ch); R(lxR + lw - 2, 29, 2, ch); R(lxL, 28 + ch, lxR + lw - lxL, 1);
      if (ch === 9) { C(bottomLight); R(lxL, 33, lw - 1, 2); R(lxR + 1, 33, lw - 1, 2); }
      C(skin); R(lxL, 29 + ch, lw, 15 - ch - lL); R(lxR, 29 + ch, lw, 15 - ch - lR);
      C(skinDark); R(lxL + lw - 2, 29 + ch, 2, 15 - ch - lL); R(lxR + lw - 2, 29 + ch, 2, 15 - ch - lR);
    } else {
      const y0 = F.bottomStyle === "dress" ? 27 : 29;
      const hem = F.bottomStyle === "longskirt" ? 41 : 36;
      C(clothColor); R(tx - 1, y0, tw + 2, 4); R(tx - 2, y0 + 4, tw + 4, hem - y0 - 3);
      C(clothDark); R(tx - 2, hem, tw + 4, 1); R(tx + tw - 1, y0 + 2, 3, hem - y0 - 1);
      C(skin); R(lxL, hem + 1, lw, 43 - hem - lL); R(lxR, hem + 1, lw, 43 - hem - lR);
      C(skinDark); R(lxL + lw - 2, hem + 1, 2, 43 - hem - lL); R(lxR + lw - 2, hem + 1, 2, 43 - hem - lR);
    }
    shoe(lxL - 1, 44 - lL); shoe(lxR, 44 - lR);
  };

  // ---- torso (front) ----
  const torsoFront = () => {
    if (F.topStyle === "hoodie") { C(topDark); R(cx - 8, 11 + H, 16, 6); }
    C(top);
    if (fem) { R(tx, 16 + T, tw, 7); R(tx + 2, 23 + T, tw - 4, 3); R(tx + 1, 26 + T, tw - 2, 1); R(tx, 27 + T, tw, 2); }
    else R(tx, 16 + T, tw, 13);
    if (P.shoulders) { C(top); R(tx - 1, 16 + T, tw + 2, 4); C(topDark); R(tx + 4, 20 + T, 2, 1); R(tx + tw - 6, 20 + T, 2, 1); R(cx - 1, 19 + T, 1, 6); }
    if (P.belly) { C(top); R(tx - 1, 20 + T, tw + 2, 8); C(topLight); R(tx + 2, 22 + T, 3, 3); }
    C(topLight); R(tx + 1, 17 + T, 3, 3);
    C(topDark); R(tx + tw - 2, 17 + T, 2, fem ? 5 : 11); R(tx, 27 + T, tw, 2);
    if (P.belly) { C(topDark); R(tx - 1, 27 + T, tw + 2, 1); }
    if (fem) {
      C(topDark); R(tx + tw - 4, 23 + T, 2, 3); R(tx + tw - 3, 26 + T, 2, 1);
      C(topDark); R(tx + 2, 21 + T, 3, 1); R(tx + tw - 5, 21 + T, 3, 1);
      C(topLight); R(tx + 2, 19 + T, 2, 1); R(tx + tw - 5, 19 + T, 2, 1);
    }
    if (F.topStyle === "blazer") {
      C(L.blazer); R(tx, 16 + T, 4, 13); R(tx + tw - 4, 16 + T, 4, 13);
      C(shade(L.blazer, -30)); R(tx + 3, 16 + T, 1, 5); R(tx + tw - 4, 16 + T, 1, 5);
      C("#f7f7f7"); R(tx + 4, 16 + T, tw - 8, 6);
      C(top); R(tx + 4, 22 + T, tw - 8, 7);
    } else if (F.topStyle === "hoodie") {
      C(topDark); R(cx - 4, 25 + T, 8, 3); R(tx, 16 + T, tw, 1);
      C("#f5f5f5"); R(cx - 2, 17 + T, 1, 4); R(cx + 1, 17 + T, 1, 4);
    } else if (suit) {
      C("#f7f7f7"); R(cx - 2, 16 + T, 4, 6);
      C(topDark); R(cx - 3, 16 + T, 1, 6); R(cx + 2, 16 + T, 1, 6); R(cx, 22 + T, 1, 6); R(cx - 2, 22 + T, 4, 1);
      C(F.tie); R(cx - 1, 17 + T, 2, 5);
      C(topLight); R(tx + tw - 3, 19 + T, 2, 1); // pocket square
    } else if (F.topStyle === "tank") {
      const sh = P.shoulders ? 1 : 0;
      C(skin); R(tx - sh, 16 + T, 2 + sh, 4); R(tx + tw - 2, 16 + T, 2 + sh, 4); R(cx - 2, 16 + T, 4, 2);
      C(skinDark); R(cx - 2, 17 + T, 4, 1);
    } else if (F.topStyle === "shirt") {
      C(skin); R(cx - 1, 16 + T, 2, 2); C(skinDark); R(cx - 1, 17 + T, 2, 1);
      C(topLight); R(cx - 4, 16 + T, 3, 2); R(cx + 1, 16 + T, 3, 2);
      C(topDark); R(cx, 18 + T, 1, 10);
      C("#f5f5f5"); R(cx, 20 + T, 1, 1); R(cx, 23 + T, 1, 1); R(cx, 26 + T, 1, 1);
    } else if (F.topStyle === "polo") {
      C(topDark); R(cx - 4, 16 + T, 3, 2); R(cx + 1, 16 + T, 3, 2); R(cx - 1, 17 + T, 2, 3);
      C(skin); R(cx - 1, 16 + T, 2, 1);
      C("#f5f5f5"); R(cx - 1, 18 + T, 1, 1);
    } else if (F.topStyle === "sweater") {
      C(topDark); R(cx - 3, 16 + T, 6, 1);
      C(topMid); R(tx + 2, 19 + T, tw - 4, 1); R(tx + 2, 22 + T, tw - 4, 1); R(tx + 2, 25 + T, tw - 4, 1);
    } else {
      C(skinDark); R(cx - 2, 16 + T, 4, 1);
    }
    if (F.topStyle !== "dress" && !suit) { C("#33303a"); R(P.belly ? tx - 1 : tx, 28 + T, P.belly ? tw + 2 : tw, 1); }
    C(skin); R(14, 14 + H, 4, 3); // neck
    if (P.belly) { C(skin); R(13, 14 + H, 6, 3); }
  };

  const arm = (x, y, sleeve, hand) => {
    C(sleeveC); R(x, y, aw, sleeve);
    if (F.topStyle === "sweater") { C(topDark); R(x, y + sleeve - 1, aw, 1); }
    if (suit) { C("#f7f7f7"); R(x, y + sleeve - 1, aw, 1); }
    if (hand) { C(skin); R(x, y + sleeve, aw, 4); }
    if (P.shoulders && F.topStyle !== "tank") { C(topDark); R(x, y + 3, aw, 1); }
  };

  const armsFront = () => {
    const swing = walking ? [0, 2, 0, -2][f] : 0;
    switch (o.anim) {
      case "type": {
        const tap = Math.floor(o.t / 160) % 2;
        arm(axL, 17 + T, 6, false); arm(axR, 17 + T, 6, false);
        C(skin); R(axL + 1, 23 + T + tap, 5, 3); R(axR - 3, 24 + T - tap, 5, 3);
        break;
      }
      case "wave": {
        arm(axL, 17 + T, 7, true);
        C(sleeveC); R(axR, 6 + H, aw, 12);
        C(skin); R(axR + (Math.floor(o.t / 250) % 2), 2 + H, aw + 1, 4);
        break;
      }
      case "drink": {
        const sip = Math.floor(o.t / 1500) % 4 === 0;
        arm(axL, 17 + T, 7, true);
        const my = sip ? 8 + H : 20 + T;
        C(sleeveC); R(axR, 17 + T, aw, sip ? 3 : 6);
        C(skin); R(axR - 1, my + 4, 4, 3);
        C("#f5f5f5"); R(axR - 1, my, 8, 8);
        C(e.color); R(axR + 1, my + 2, 4, 4);
        break;
      }
      case "think": {
        arm(axL, 17 + T, 7, true);
        C(sleeveC); R(axR, 17 + T, aw, 5);
        C(skin); R(19, 11 + H, 5, 4);
        break;
      }
      case "read": {
        C(sleeveC); R(axL, 17 + T, aw, 5); R(axR, 17 + T, aw, 5);
        C("#f5f5f5"); R(cx - 8, 21 + T, 16, 9);
        C("#33303a"); R(cx - 1, 21 + T, 2, 9);
        C("#9aa"); R(cx - 6, 24 + T, 4, 1); R(cx - 6, 27 + T, 4, 1); R(cx + 2, 24 + T, 4, 1); R(cx + 2, 27 + T, 3, 1);
        C(skin); R(axL, 25 + T, aw, 4); R(axR, 25 + T, aw, 4);
        break;
      }
      case "slump": arm(axL, 19 + T, 7, true); arm(axR, 19 + T, 7, true); break;
      case "sip": {
        // left arm rests on the desk; right hand lifts the mug to the mouth and back
        const p = Math.min(1, (o.sipT || 0) / 2600);
        const k = p < 0.3 ? p / 0.3 : p < 0.75 ? 1 : 1 - (p - 0.75) / 0.25; // 0 = on desk, 1 = at mouth
        const tilt = p > 0.4 && p < 0.65 ? 1 : 0;
        arm(axL, 19 + T, 7, true);
        const handY = Math.round(24 + T - k * 14);
        C(sleeveC); R(axR, 17 + T, aw, Math.max(2, handY - 17 - T - 1));
        C(skin); R(axR - 1, handY, 4, 3);
        const mx = axR - 3, my = handY - 6 + tilt;
        C(OUTLINE); R(mx - 1, my - 1, 9, 10); C(e.color || top); R(mx, my, 7, 8); C("rgba(255,255,255,.35)"); R(mx + 1, my + 1 + tilt, 2, 4); C(OUTLINE); R(mx + 7, my + 2, 3, 5); C(e.color || top); R(mx + 8, my + 3, 1, 3);
        if (k === 1) { C("rgba(255,255,255,.5)"); R(mx + 2, my - 3 - (Math.floor(o.t / 300) % 2), 1, 2); }
        break;
      }
      case "sitfree": arm(axL, 17 + T, 7, true); arm(axR, 17 + T, 7, true); break;
      default: arm(axL, 17 + T + swing, 7, true); arm(axR, 17 + T - swing, 7, true);
    }
  };

  // ---- hats (front / back / side) ----
  const hatFront = () => {
    const c = F.hatColor;
    switch (F.hat) {
      case "cap": C(c); R(8, 0 + H, 16, 6); R(9, -1 + H, 14, 1); C(hatLight); R(10, 1 + H, 5, 1); C(hatDark); R(7, 6 + H, 18, 2); R(15, 0 + H, 1, 6); break;
      case "beanie": C(c); R(8, -1 + H, 16, 8); R(9, -2 + H, 14, 1); C(hatDark); R(8, 5 + H, 16, 2); C(hatLight); R(13, -4 + H, 6, 2); R(10, 0 + H, 4, 1); break;
      case "cowboy": C(c); R(5, 4 + H, 22, 2); R(5, 3 + H, 1, 1); R(26, 3 + H, 1, 1); R(9, -3 + H, 14, 8); C(hatDark); R(5, 6 + H, 22, 1); R(9, 2 + H, 14, 1); R(12, -3 + H, 8, 1); C(hatLight); R(11, -2 + H, 3, 1); break;
      case "fedora": C(c); R(6, 4 + H, 20, 2); R(9, -2 + H, 14, 7); C(hatDark); R(6, 6 + H, 20, 1); R(9, 2 + H, 14, 2); R(12, -2 + H, 8, 1); C(hatLight); R(11, -1 + H, 3, 1); break;
      case "bucket": C(c); R(9, -2 + H, 14, 7); R(7, 4 + H, 18, 2); R(6, 5 + H, 2, 3); R(24, 5 + H, 2, 3); C(hatDark); R(9, 3 + H, 14, 1); R(7, 6 + H, 18, 1); R(6, 7 + H, 2, 1); R(24, 7 + H, 2, 1); C(hatLight); R(11, -1 + H, 4, 1); break;
      case "beret": C(c); R(8, -2 + H, 13, 1); R(6, -1 + H, 17, 3); R(9, 2 + H, 13, 2); C(hatDark); R(9, 3 + H, 13, 1); R(15, -3 + H, 2, 1); C(hatLight); R(9, -1 + H, 4, 1); break;
      case "bandana": C(c); R(9, -2 + H, 13, 1); R(8, -1 + H, 15, 5); R(22, 3 + H, 2, 2); R(23, 5 + H, 2, 3); R(24, 8 + H, 1, 1); C(hatDark); R(8, 3 + H, 15, 1); R(23, 5 + H, 2, 1); C(hatLight); R(10, 0 + H, 4, 1); break;
      case "hood": C(c); R(7, -2 + H, 18, 4); R(7, 2 + H, 3, 13); R(22, 2 + H, 3, 13); R(6, 13 + H, 4, 4); R(22, 13 + H, 4, 4); C(hatDark); R(10, 1 + H, 12, 1); R(9, 2 + H, 1, 11); R(22, 2 + H, 1, 11); R(6, 16 + H, 4, 1); R(22, 16 + H, 4, 1); C(hatLight); R(9, -1 + H, 4, 1); break;
    }
  };
  const hatBack = () => {
    const c = F.hatColor;
    switch (F.hat) {
      case "cap": C(c); R(8, 0 + H, 16, 6); R(9, -1 + H, 14, 1); C(hatDark); R(8, 5 + H, 16, 2); R(13, 4 + H, 6, 2); break;
      case "beanie": C(c); R(8, -1 + H, 16, 8); R(9, -2 + H, 14, 1); C(hatDark); R(8, 5 + H, 16, 2); C(hatLight); R(13, -4 + H, 6, 2); break;
      case "cowboy": C(c); R(5, 4 + H, 22, 2); R(5, 3 + H, 1, 1); R(26, 3 + H, 1, 1); R(9, -3 + H, 14, 8); C(hatDark); R(5, 6 + H, 22, 1); R(9, 2 + H, 14, 1); C(hatLight); R(11, -2 + H, 3, 1); break;
      case "fedora": C(c); R(6, 4 + H, 20, 2); R(9, -2 + H, 14, 7); C(hatDark); R(6, 6 + H, 20, 1); R(9, 2 + H, 14, 2); C(hatLight); R(11, -1 + H, 3, 1); break;
      case "bucket": C(c); R(9, -2 + H, 14, 7); R(7, 4 + H, 18, 2); R(6, 5 + H, 2, 3); R(24, 5 + H, 2, 3); C(hatDark); R(9, 3 + H, 14, 1); R(7, 6 + H, 18, 1); R(6, 7 + H, 2, 1); R(24, 7 + H, 2, 1); C(hatLight); R(11, -1 + H, 4, 1); break;
      case "beret": C(c); R(8, -2 + H, 13, 1); R(6, -1 + H, 17, 3); R(9, 2 + H, 13, 2); C(hatDark); R(9, 3 + H, 13, 1); R(15, -3 + H, 2, 1); C(hatLight); R(9, -1 + H, 4, 1); break;
      case "bandana": C(c); R(9, -2 + H, 13, 1); R(8, -1 + H, 15, 5); C(hatDark); R(8, 3 + H, 15, 1); R(14, 3 + H, 4, 2); C(c); R(13, 5 + H, 2, 4); R(17, 5 + H, 2, 4); C(hatDark); R(13, 8 + H, 2, 1); R(17, 8 + H, 2, 1); break;
      case "hood": C(c); R(7, -2 + H, 18, 17); R(6, 13 + H, 20, 4); R(15, -3 + H, 2, 1); C(hatDark); R(15, -1 + H, 2, 14); R(6, 16 + H, 20, 1); C(hatLight); R(9, -1 + H, 4, 1); break;
    }
  };
  const hatSide = () => {
    const c = F.hatColor;
    switch (F.hat) {
      case "cap": C(c); R(9, 0 + H, 14, 6); R(10, -1 + H, 12, 1); C(hatDark); R(17, 5 + H, 9, 2); C(hatLight); R(11, 1 + H, 4, 1); break;
      case "beanie": C(c); R(9, -1 + H, 14, 8); R(10, -2 + H, 12, 1); C(hatDark); R(9, 5 + H, 14, 2); C(hatLight); R(11, -4 + H, 5, 2); break;
      case "cowboy": C(c); R(5, 4 + H, 23, 2); R(5, 3 + H, 1, 1); R(27, 3 + H, 1, 1); R(10, -3 + H, 13, 8); C(hatDark); R(5, 6 + H, 23, 1); R(10, 2 + H, 13, 1); R(13, -3 + H, 7, 1); C(hatLight); R(12, -2 + H, 3, 1); break;
      case "fedora": C(c); R(6, 4 + H, 21, 2); R(25, 6 + H, 2, 1); R(10, -2 + H, 13, 7); C(hatDark); R(6, 6 + H, 19, 1); R(10, 2 + H, 13, 2); R(13, -2 + H, 7, 1); C(hatLight); R(12, -1 + H, 3, 1); break;
      case "bucket": C(c); R(10, -2 + H, 13, 7); R(8, 4 + H, 18, 2); R(7, 5 + H, 2, 3); R(25, 5 + H, 2, 3); C(hatDark); R(10, 3 + H, 13, 1); R(8, 6 + H, 18, 1); R(7, 7 + H, 2, 1); R(25, 7 + H, 2, 1); C(hatLight); R(12, -1 + H, 4, 1); break;
      case "beret": C(c); R(9, -2 + H, 12, 1); R(6, -1 + H, 17, 3); R(10, 2 + H, 12, 2); C(hatDark); R(10, 3 + H, 12, 1); R(14, -3 + H, 2, 1); C(hatLight); R(9, -1 + H, 4, 1); break;
      case "bandana": C(c); R(10, -2 + H, 12, 1); R(9, -1 + H, 14, 5); R(7, 3 + H, 3, 2); R(6, 5 + H, 2, 4); C(hatDark); R(9, 3 + H, 14, 1); R(7, 5 + H, 1, 3); R(6, 8 + H, 2, 1); C(hatLight); R(11, 0 + H, 4, 1); break;
      case "hood": C(c); R(8, -2 + H, 16, 4); R(8, 2 + H, 5, 13); R(7, 13 + H, 6, 4); R(22, 1 + H, 2, 4); C(hatDark); R(13, 1 + H, 9, 1); R(12, 2 + H, 1, 11); R(7, 16 + H, 6, 1); C(hatLight); R(10, -1 + H, 4, 1); break;
    }
  };

  const glassesFront = () => {
    if (F.glasses === "square") {
      C("#6b7482"); R(11, 11 + H, 3, 1); R(18, 11 + H, 3, 1); R(11, 8 + H, 1, 3); R(20, 8 + H, 1, 3); R(15, 9 + H, 2, 1);
      C("rgba(200,225,255,.35)"); R(12, 8 + H, 2, 3); R(18, 8 + H, 2, 3);
    } else if (F.glasses === "round") {
      C("#3a3f4a"); R(11, 7 + H, 3, 1); R(18, 7 + H, 3, 1); R(11, 11 + H, 3, 1); R(18, 11 + H, 3, 1);
      R(10, 8 + H, 1, 3); R(14, 8 + H, 1, 3); R(17, 8 + H, 1, 3); R(21, 8 + H, 1, 3); R(15, 9 + H, 2, 1);
      C("rgba(200,225,255,.3)"); R(11, 8 + H, 3, 3); R(18, 8 + H, 3, 3);
    } else if (F.glasses === "sun") {
      C("#1c1a20"); R(10, 8 + H, 5, 3); R(17, 8 + H, 5, 3); R(15, 8 + H, 2, 1);
      C("#4a5a6a"); R(11, 8 + H, 1, 1); R(18, 8 + H, 1, 1);
    }
  };

  const beardFront = () => {
    switch (F.beard) {
      case "full": case "stubble": case "long":
        C(F.beard === "stubble" ? stubble : beardC); R(10, 11 + H, 2, 3); R(20, 11 + H, 2, 3); R(11, 13 + H, 10, 2);
        if (F.beard === "long") { R(12, 15 + H, 8, 3); R(13, 18 + H, 6, 1); C(beardLight); R(15, 14 + H, 1, 4); }
        C(skinDark); R(15, 12 + H, 2, 1);
        break;
      case "chin": // circle beard: mustache joined to a rounded chin beard
        C(beardC); R(12, 11 + H, 8, 1); R(12, 12 + H, 1, 2); R(19, 12 + H, 1, 2); R(12, 13 + H, 8, 2); R(13, 15 + H, 6, 1);
        C(beardLight); R(14, 14 + H, 1, 1);
        break;
      case "goatee": // narrow chin tuft tapering to a point
        C(beardC); R(14, 13 + H, 4, 2); R(14, 15 + H, 4, 1); R(15, 16 + H, 2, 1); R(15, 17 + H, 1, 1);
        C(beardLight); R(15, 13 + H, 1, 3);
        break;
      case "mustache": C(beardC); R(12, 11 + H, 8, 1); R(12, 12 + H, 1, 1); R(19, 12 + H, 1, 1); break;
    }
  };
  const beardSide = () => {
    switch (F.beard) {
      case "full": case "stubble": case "long":
        C(F.beard === "stubble" ? stubble : beardC); R(14, 12 + H, 8, 3);
        if (F.beard === "long") { R(15, 15 + H, 6, 3); R(16, 18 + H, 4, 1); C(beardLight); R(17, 14 + H, 1, 4); }
        break;
      case "chin": C(beardC); R(18, 11 + H, 4, 1); R(21, 12 + H, 1, 1); R(16, 13 + H, 6, 2); R(17, 15 + H, 4, 1); break;
      case "goatee": C(beardC); R(18, 13 + H, 4, 2); R(18, 15 + H, 3, 1); R(19, 16 + H, 2, 1); R(19, 17 + H, 1, 1); break;
      case "mustache": C(beardC); R(18, 11 + H, 4, 1); R(18, 12 + H, 1, 1); break;
    }
  };

  const headFront = () => {
    C(skin);
    if (L.fem) { R(10, 3 + H, 12, 9); R(11, 12 + H, 10, 2); R(13, 14 + H, 6, 1); }
    else { R(10, 3 + H, 12, 10); R(11, 13 + H, 10, 2); }
    if (P.belly) { C(skin); R(9, 8 + H, 1, 6); R(22, 8 + H, 1, 6); R(10, 13 + H, 12, 2); }
    C(skinDark); R(20, 6 + H, 2, L.fem ? 6 : 7);
    if (scalp) {
      C(skin); R(10, 1 + H, 12, 2); R(11, 0 + H, 10, 1);
      C(skinLight); R(12, 1 + H, 3, 1);
      if (hs === "balding") { C(hair); R(9, 4 + H, 2, 6); R(21, 4 + H, 2, 6); C(hairDark); R(9, 9 + H, 2, 1); R(21, 9 + H, 2, 1); }
    } else {
      C(hairBase); R(9, 1 + H, 14, 6); R(10, 0 + H, 12, 1); R(9, 7 + H, 2, 3); R(21, 7 + H, 2, 3);
      if (!SHAVED.includes(hs)) { C(hairLight); R(12, 2 + H, 4, 1); }
    }
    hairFront(b, ox, oy + H, L, C, hs);
    hatFront();
    if (!blink) {
      C("#1c1a20"); R(12, 8 + H, 2, 3); R(18, 8 + H, 2, 3);
      if (L.fem) { R(11, 7 + H, 3, 1); R(18, 7 + H, 3, 1); R(11, 8 + H, 1, 1); R(20, 8 + H, 1, 1); }
      C(F.eyes); R(13, 9 + H, 1, 1); R(19, 9 + H, 1, 1);
      C("#ffffff"); R(12, 8 + H, 1, 1); R(18, 8 + H, 1, 1);
    } else { C("#1c1a20"); R(12, 10 + H, 2, 1); R(18, 10 + H, 2, 1); if (L.fem) { R(11, 10 + H, 1, 1); R(20, 10 + H, 1, 1); } }
    if (F.hat === "none") { C(hairDark); R(12, 6 + H, 2, 1); R(18, 6 + H, 2, 1); }
    if (L.fem) { C("#d4607a"); R(15, 12 + H, 2, 1); C("#e98aa0"); R(15, 12 + H, 1, 1); }
    else { C(skinDark); R(15, 12 + H, 2, 1); }
    C(L.fem ? "#f0a0a8" : "#eaa5a0"); R(11, 11 + H, 1, 1); R(20, 11 + H, 1, 1);
    if (L.fem && !["long", "bob", "afro"].includes(hs)) { C("#f2c14e"); R(9, 10 + H, 1, 2); R(22, 10 + H, 1, 2); }
    beardFront();
    glassesFront();
    accessoryFront(b, ox, oy + H, L, C);
  };

  const headBack = () => {
    if (scalp) {
      C(skin); R(10, 1 + H, 12, 13); R(11, 0 + H, 10, 1);
      C(skinLight); R(12, 2 + H, 4, 1); C(skinDark); R(10, 12 + H, 12, 2);
      if (hs === "balding") { C(hair); R(9, 5 + H, 14, 9); C(hairDark); R(9, 12 + H, 14, 2); C(hairLight); R(11, 6 + H, 1, 4); }
    } else {
      C(hairBase); R(9, 1 + H, 14, 13); R(10, 0 + H, 12, 1);
      if (!SHAVED.includes(hs)) { C(hairLight); R(12, 2 + H, 5, 1); }
      C(shade(hairBase, -28)); R(9, 12 + H, 14, 2);
    }
    C(skin); R(14, 14 + H, 4, 3);
    switch (hs) {
      case "long": C(hair); R(8, 8 + H, 16, 17); C(hairDark); R(8, 23 + H, 16, 2); C(hairLight); R(11, 10 + H, 1, 9); break;
      case "ponytail": C(hairDark); R(14, 10 + H, 4, 3); C(hair); R(13, 12 + H, 6, 15); C(hairDark); R(13, 25 + H, 6, 2); C(hairLight); R(14, 14 + H, 1, 8); break;
      case "braid": C(hairDark); R(14, 10 + H, 4, 3); C(hair); R(13, 12 + H, 6, 16); C(hairDark); R(13, 15 + H, 6, 1); R(13, 19 + H, 6, 1); R(13, 23 + H, 6, 1); R(14, 27 + H, 4, 1); C(hairLight); R(14, 13 + H, 1, 2); R(17, 17 + H, 1, 2); R(14, 21 + H, 1, 2); R(17, 25 + H, 1, 2); break;
      case "bun": C(hair); R(12, -4 + H, 8, 6); C(hairLight); R(14, -3 + H, 3, 1); break;
      case "curly": C(hair); R(8, 4 + H, 1, 8); R(23, 4 + H, 1, 8); R(11, -1 + H, 3, 1); R(18, -1 + H, 3, 1); break;
      case "mohawk": C(hair); R(14, -5 + H, 4, 17); C(hairLight); R(15, -4 + H, 1, 10); break;
      case "spiky": C(hair); R(10, -2 + H, 2, 2); R(13, -3 + H, 3, 3); R(17, -3 + H, 3, 3); R(20, -2 + H, 2, 2); break;
      case "afro": C(hair); R(8, -4 + H, 16, 1); R(7, -3 + H, 18, 1); R(6, -2 + H, 20, 15); R(7, 13 + H, 18, 1); C(hairDark); R(7, 12 + H, 18, 1); R(8, 13 + H, 16, 1); R(8, -1 + H, 1, 1); R(12, -2 + H, 1, 1); R(16, -3 + H, 1, 1); R(20, -2 + H, 1, 1); R(23, -1 + H, 1, 1); C(hairLight); R(10, -2 + H, 1, 1); R(14, -2 + H, 1, 1); R(18, -2 + H, 1, 1); R(22, -2 + H, 1, 1); break;
      case "bob": C(hair); R(7, 4 + H, 18, 11); C(hairDark); R(7, 13 + H, 18, 2); C(hairLight); R(9, 6 + H, 1, 6); break;
    }
    hatBack();
    if (F.topStyle === "hoodie" && F.hat !== "hood") { C(topDark); R(cx - 8, 12 + T, 16, 7); C(top); R(cx - 7, 13 + T, 14, 5); }
    if (L.accessory === "headphones" || L.accessory === "headset") { C("#222"); R(9, 3 + H, 14, 2); R(8, 7 + H, 2, 5); R(22, 7 + H, 2, 5); }
  };

  if (dir === "down") {
    legsFront(); torsoFront(); armsFront(); headFront();
  } else if (dir === "up") {
    legsFront();
    C(top);
    if (fem) { R(tx, 16 + T, tw, 7); R(tx + 2, 23 + T, tw - 4, 3); R(tx + 1, 26 + T, tw - 2, 1); R(tx, 27 + T, tw, 2); }
    else R(tx, 16 + T, tw, 13);
    if (P.shoulders) { R(tx - 1, 16 + T, tw + 2, 4); }
    if (P.belly) { R(tx - 1, 20 + T, tw + 2, 8); }
    C(topDark); R(tx, 27 + T, tw, 2); C(topLight); R(tx + 1, 17 + T, tw - 2, 2);
    if (F.topStyle === "blazer") { C(L.blazer); R(tx, 16 + T, tw, 13); C(shade(L.blazer, -30)); R(cx - 1, 16 + T, 2, 13); }
    else if (F.topStyle === "tank") { C(skin); R(tx, 16 + T, tw, 3); C(top); R(tx + 2, 16 + T, 2, 3); R(tx + tw - 4, 16 + T, 2, 3); }
    else if (suit) { C(topDark); R(tx + 3, 16 + T, tw - 6, 1); R(cx, 22 + T, 1, 7); }
    else if (F.topStyle === "shirt") { C(topLight); R(tx + 3, 16 + T, tw - 6, 2); }
    else if (F.topStyle === "polo") { C(topDark); R(tx + 3, 16 + T, tw - 6, 2); }
    else if (F.topStyle === "sweater") { C(topDark); R(tx + 3, 16 + T, tw - 6, 1); C(topMid); R(tx + 2, 19 + T, tw - 4, 1); R(tx + 2, 22 + T, tw - 4, 1); R(tx + 2, 25 + T, tw - 4, 1); }
    if (F.topStyle !== "dress" && !suit) { C("#33303a"); R(tx, 28 + T, tw, 1); }
    const swing = walking ? [0, 2, 0, -2][f] : 0;
    arm(axL, 17 + T + swing, 7, true); arm(axR, 17 + T - swing, 7, true);
    headBack();
  } else {
    // ---- side view, facing right ----
    const { sx, sw } = P;
    const step = walking ? [0, 2, 0, -2][f] : 0;
    const legB = 12, legF = 12 + lw - 2;
    if (!sitting) {
      if (sitFree) {
        C(clothColor); R(sx, 29, sw + 2, 5); C(clothDark); R(sx, 33, sw + 2, 1);
        if (legCloth) { C(bottom); R(legF + 2, 34, lw, 7); C(bottomDark); R(legF + 2, 34, 1, 7); } else { C(skin); R(legF + 2, 34, lw, 7); }
        shoe(legF + 2, 41, lw + 2, true);
      } else {
        const back = Math.max(0, -step), fwd = Math.max(0, step);
        if (pantsLike) {
          C(bottomDark); R(legB - back, 29, lw, 15 - back);
          C(bottom); R(legF + fwd, 29, lw, 15 - fwd);
          if (F.bottomStyle === "cargo") { C(bottomDark); R(legF + fwd + 1, 34, lw - 2, 1); R(legF + fwd + 1, 38, lw - 2, 1); C(bottomLight); R(legF + fwd + 1, 35, lw - 2, 3); }
          else if (F.bottomStyle === "joggers") { C(shade(bottom, 50)); R(legF + fwd + 1, 29, 1, 12 - fwd); C(bottomDark); R(legF + fwd, 41 - fwd, lw, 3); C(shade(bottom, -45)); R(legB - back, 41 - back, lw, 3); }
        } else if (F.bottomStyle === "shorts" || F.bottomStyle === "bermuda") {
          const ch = F.bottomStyle === "bermuda" ? 9 : 6;
          C(bottomDark); R(legB - back, 29, lw, ch); C(bottom); R(legF + fwd, 29, lw, ch);
          if (ch === 9) { C(bottomLight); R(legF + fwd + 1, 33, lw - 2, 2); }
          C(skinDark); R(legB - back, 29 + ch, lw, 15 - ch - back); C(skin); R(legF + fwd, 29 + ch, lw, 15 - ch - fwd);
        } else {
          const y0 = F.bottomStyle === "dress" ? 27 : 29;
          const hem = F.bottomStyle === "longskirt" ? 41 : 36;
          C(clothColor); R(sx - 1, y0, sw + 3, 4); R(sx - 2, y0 + 4, sw + 5, hem - y0 - 3);
          C(clothDark); R(sx - 2, hem, sw + 5, 1);
          C(skinDark); R(legB - back, hem + 1, lw, 43 - hem - back); C(skin); R(legF + fwd, hem + 1, lw, 43 - hem - fwd);
        }
        shoe(legB - back - 1, 44 - back, lw + 1, true); shoe(legF + fwd - 1, 44 - fwd, lw + 2, true);
      }
    }
    if (F.topStyle === "hoodie" && F.hat !== "hood") { C(topDark); R(sx - 4, 11 + H, 9, 7); }
    C(top);
    if (fem) { R(sx, 16 + T, sw, 7); R(sx + sw, 18 + T, 1, 4); R(sx + 1, 23 + T, sw - 2, 3); R(sx, 26 + T, sw, 3); }
    else R(sx, 16 + T, sw, 13);
    if (P.belly) { C(top); R(sx + sw, 20 + T, 2, 8); C(topLight); R(sx + sw - 2, 22 + T, 2, 3); }
    if (P.shoulders) { C(top); R(sx - 1, 16 + T, sw + 2, 4); }
    C(topDark); R(sx, 17 + T, 2, fem ? 6 : 11); R(sx, 27 + T, sw, 2); C(topLight); R(sx + 4, 17 + T, 3, 3);
    if (F.topStyle === "blazer") { C(L.blazer); R(sx, 16 + T, sw, 13); C(top); R(sx + sw - 3, 16 + T, 3, 6); }
    else if (F.topStyle === "hoodie") { C(topDark); R(sx + 3, 25 + T, 5, 3); C("#f5f5f5"); R(sx + sw - 3, 17 + T, 1, 4); }
    else if (F.topStyle === "tank") { C(skin); R(sx, 16 + T, sw, 2); C(top); R(sx + (sw >> 1) - 1, 16 + T, 2, 2); }
    else if (suit) { C("#f7f7f7"); R(sx + sw - 3, 16 + T, 3, 4); C(topDark); R(sx + sw - 4, 16 + T, 1, 5); R(sx + sw - 3, 20 + T, 3, 1); C(F.tie); R(sx + sw - 2, 17 + T, 1, 3); }
    else if (F.topStyle === "shirt") { C(topLight); R(sx + sw - 4, 16 + T, 4, 2); C(topDark); R(sx + sw - 1, 18 + T, 1, 10); }
    else if (F.topStyle === "polo") { C(topDark); R(sx + sw - 4, 16 + T, 4, 1); R(sx + sw - 2, 17 + T, 2, 1); }
    else if (F.topStyle === "sweater") { C(topDark); R(sx + 1, 16 + T, sw - 2, 1); C(topMid); R(sx + 1, 19 + T, sw - 2, 1); R(sx + 1, 22 + T, sw - 2, 1); R(sx + 1, 25 + T, sw - 2, 1); }
    if (F.topStyle !== "dress" && !suit) { C("#33303a"); R(sx, 28 + T, sw, 1); }
    C(skin); R(14, 14 + H, 4, 3);
    const ax = sx + Math.floor((sw - aw) / 2);
    if (o.anim === "drink") {
      C(sleeveC); R(ax + 1, 17 + T, aw, 5); C(skin); R(ax + 3, 21 + T, 3, 3);
      C("#f5f5f5"); R(ax + 4, 18 + T, 7, 8); C(e.color); R(ax + 6, 20 + T, 3, 4);
    } else if (o.anim === "read") {
      C(sleeveC); R(ax + 1, 17 + T, aw, 4); C("#f5f5f5"); R(ax + 2, 21 + T, 10, 8); C("#9aa"); R(ax + 4, 24 + T, 5, 1); R(ax + 4, 27 + T, 4, 1); C(skin); R(ax + 1, 24 + T, aw, 4);
    } else if (o.anim === "sitfree") {
      C(sleeveC); R(ax + 1, 17 + T, aw, 6); C(skin); R(ax + 2, 23 + T, aw, 4);
    } else {
      C(sleeveC); R(ax + step, 17 + T, aw, 7); if (suit) { C("#f7f7f7"); R(ax + step, 23 + T, aw, 1); } C(skin); R(ax + step, 24 + T, aw, 4);
    }
    C(skin);
    if (L.fem) { R(12, 3 + H, 10, 9); R(13, 12 + H, 9, 2); R(15, 14 + H, 6, 1); } else { R(12, 3 + H, 10, 10); R(13, 13 + H, 8, 2); }
    if (P.belly) { C(skin); R(22, 8 + H, 1, 6); R(12, 13 + H, 10, 2); }
    if (scalp) {
      C(skin); R(11, 1 + H, 11, 2); R(12, 0 + H, 9, 1); R(10, 3 + H, 2, 11);
      C(skinLight); R(13, 1 + H, 3, 1);
      if (hs === "balding") { C(hair); R(10, 3 + H, 4, 11); C(hairDark); R(10, 12 + H, 4, 2); }
    } else {
      C(hairBase); R(10, 1 + H, 13, 6); R(11, 0 + H, 10, 1); R(10, 7 + H, 4, 7);
      if (!SHAVED.includes(hs)) { C(hairLight); R(12, 2 + H, 5, 1); }
    }
    hairSide(b, ox, oy + H, L, C, hs);
    hatSide();
    if (!blink) { C("#1c1a20"); R(17, 8 + H, 2, 3); if (L.fem) R(17, 7 + H, 3, 1); C(F.eyes); R(18, 9 + H, 1, 1); C("#fff"); R(17, 8 + H, 1, 1); } else { C("#1c1a20"); R(17, 10 + H, 2, 1); }
    if (F.hat === "none") { C(hairDark); R(17, 6 + H, 3, 1); }
    C(skinDark); R(22, 9 + H, 1, 2);
    if (L.fem) { C("#d4607a"); R(19, 12 + H, 2, 1); } else { C(skinDark); R(19, 12 + H, 2, 1); }
    C(L.fem ? "#f0a0a8" : "#eaa5a0"); R(16, 11 + H, 1, 1);
    beardSide();
    if (F.glasses === "square") { C("#6b7482"); R(16, 11 + H, 4, 1); R(20, 8 + H, 1, 3); R(14, 8 + H, 3, 1); }
    if (F.glasses === "round") { C("#3a3f4a"); R(16, 7 + H, 4, 1); R(16, 11 + H, 4, 1); R(20, 8 + H, 1, 3); R(14, 8 + H, 2, 1); }
    if (F.glasses === "sun") { C("#1c1a20"); R(16, 8 + H, 5, 3); R(14, 8 + H, 2, 1); }
    if (L.accessory === "headphones") { C("#222"); R(10, 3 + H, 13, 2); R(10, 7 + H, 4, 6); C("#444"); R(11, 8 + H, 2, 4); }
    if (L.accessory === "headset") { C("#222"); R(10, 3 + H, 13, 2); R(10, 7 + H, 3, 5); R(13, 12 + H, 4, 1); R(17, 13 + H, 5, 2); }
  }
  if (flip) b.restore();
}

// Style-specific hair on top of the base cap (front view). `hs` is the normalized style.
function hairFront(b, ox, hy, L, C, hs) {
  const R = (x, y, w, h) => b.fillRect(ox + x, hy + y, w, h);
  const h = L.hair, hl = shade(h, 40), hd = shade(h, -28);
  C(h);
  switch (hs) {
    case "long":
      R(7, 5, 4, 19); R(21, 5, 4, 19); R(10, 6, 3, 2); R(19, 6, 3, 2);
      C(hd); R(7, 22, 4, 2); R(21, 22, 4, 2);
      C(hl); R(8, 8, 1, 6); R(22, 9, 1, 5);
      break;
    case "bun": R(12, -4, 8, 6); R(11, 6, 4, 2); R(19, 6, 3, 1); C(hl); R(14, -3, 3, 1); R(11, 2, 1, 3); break;
    case "ponytail": case "braid": R(10, 6, 5, 2); R(18, 6, 4, 1); C(hl); R(12, 2, 4, 1); R(11, 3, 1, 3); C(shade(h, -22)); R(17, 2, 1, 5); break;
    case "curly": R(8, 4, 1, 8); R(23, 4, 1, 8); R(11, -1, 3, 1); R(18, -1, 3, 1); R(15, -1, 2, 1); break;
    case "bald": case "balding": case "buzz": break;
    case "mohawk": R(14, -5, 4, 12); C(hl); R(15, -4, 1, 9); break;
    case "spiky": R(10, 6, 5, 2); R(10, -2, 2, 2); R(13, -3, 3, 3); R(17, -3, 3, 3); R(20, -2, 2, 2); C(hl); R(14, -2, 1, 2); R(18, -2, 1, 2); break;
    case "afro":
      R(8, -4, 16, 1); R(7, -3, 18, 1); R(6, -2, 20, 8); R(6, 6, 3, 4); R(23, 6, 3, 4); R(7, 10, 1, 1); R(24, 10, 1, 1);
      C(hd); R(7, 9, 2, 1); R(23, 9, 2, 1); R(8, -1, 1, 1); R(12, -2, 1, 1); R(16, -3, 1, 1); R(20, -2, 1, 1); R(23, -1, 1, 1); R(7, 3, 1, 1); R(24, 3, 1, 1);
      C(hl); R(10, -2, 1, 1); R(14, -2, 1, 1); R(18, -2, 1, 1); R(22, -2, 1, 1); R(9, 1, 1, 1); R(22, 1, 1, 1);
      break;
    case "bob": R(7, 4, 3, 11); R(22, 4, 3, 11); R(10, 6, 4, 2); R(18, 6, 4, 1); C(hd); R(7, 13, 3, 2); R(22, 13, 3, 2); C(hl); R(8, 6, 1, 5); R(23, 6, 1, 5); break;
    case "sidepart": R(9, 6, 8, 2); R(17, 6, 3, 1); C(hd); R(19, 1, 1, 6); C(hl); R(11, 2, 5, 1); break;
    default: R(10, 6, 5, 2); C(shade(h, -22)); R(16, 2, 1, 5);
  }
}

function hairSide(b, ox, hy, L, C, hs) {
  const R = (x, y, w, h) => b.fillRect(ox + x, hy + y, w, h);
  const h = L.hair, hl = shade(h, 40), hd = shade(h, -28);
  C(h);
  switch (hs) {
    case "long": R(7, 5, 7, 19); C(hd); R(7, 22, 7, 2); C(hl); R(9, 8, 1, 7); break;
    case "bun": R(7, -3, 8, 7); C(hl); R(9, -2, 3, 1); break;
    case "ponytail": R(5, 7, 6, 14); R(8, 4, 5, 4); C(hd); R(5, 12, 6, 2); C(hl); R(7, 8, 1, 6); break;
    case "braid": R(8, 4, 5, 4); R(6, 8, 5, 18); C(hd); R(6, 11, 5, 1); R(6, 15, 5, 1); R(6, 19, 5, 1); R(6, 23, 5, 1); R(7, 26, 3, 1); C(hl); R(7, 9, 1, 1); R(9, 13, 1, 1); R(7, 17, 1, 1); R(9, 21, 1, 1); break;
    case "curly": R(8, 4, 2, 9); R(12, -1, 3, 1); R(17, -1, 3, 1); break;
    case "bald": case "balding": case "buzz": break;
    case "mohawk": R(10, -5, 11, 6); R(9, 0, 3, 4); C(hl); R(12, -4, 7, 1); break;
    case "spiky": R(10, 6, 7, 2); R(11, -2, 2, 2); R(14, -3, 3, 3); R(18, -3, 3, 3); R(21, -2, 1, 2); C(hl); R(15, -2, 1, 2); break;
    case "afro":
      R(9, -4, 15, 1); R(8, -3, 17, 1); R(7, -2, 19, 8); R(7, 6, 3, 4); R(8, 10, 2, 1);
      C(hd); R(8, 9, 2, 1); R(9, -1, 1, 1); R(13, -2, 1, 1); R(17, -3, 1, 1); R(21, -2, 1, 1); R(24, -1, 1, 1); R(8, 3, 1, 1);
      C(hl); R(11, -2, 1, 1); R(15, -2, 1, 1); R(19, -2, 1, 1); R(23, -2, 1, 1);
      break;
    case "bob": R(7, 4, 7, 11); R(14, 6, 7, 2); C(hd); R(7, 13, 7, 2); C(hl); R(9, 6, 1, 6); break;
    case "sidepart": R(10, 6, 8, 2); R(17, 6, 4, 1); break;
    default: R(10, 6, 7, 2);
  }
}

function accessoryFront(b, ox, hy, L, C) {
  const R = (x, y, w, h) => b.fillRect(ox + x, hy + y, w, h);
  switch (L.accessory) {
    case "headphones":
      C("#222"); R(9, 2, 14, 2); R(8, 7, 2, 6); R(22, 7, 2, 6);
      C("#444"); R(8, 8, 1, 4); R(23, 8, 1, 4);
      break;
    case "headset":
      C("#222"); R(9, 2, 14, 2); R(22, 7, 2, 5); R(21, 12, 1, 1); R(18, 13, 4, 1);
      C("#555"); R(19, 13, 2, 1);
      break;
  }
}

function hexRgb(hex) { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }

function shade(hex, delta) {
  if (!hex || hex[0] !== "#") return hex;
  const c = (v) => Math.max(0, Math.min(255, v + delta));
  const [r, g, b] = hexRgb(hex);
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

// Blends two hex colors (t = 0 → a, 1 → b); returns hex so the result can be shaded again.
function mix(a, b, t) {
  if (!a || a[0] !== "#" || !b || b[0] !== "#") return a;
  const A = hexRgb(a), B = hexRgb(b);
  return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

function lum(hex) {
  if (!hex || hex[0] !== "#") return 128;
  const [r, g, b] = hexRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000;
}

// Head-and-shoulders portrait as a data URL; `full` renders the whole standing figure.
function portraitOf(e, scale = 3, full = false, dir = "down", anim = "stand", frame = 0) {
  const emp = { look: e.look || { skin: "#f1c9a5", hair: "#3b2a20", hairStyle: "short", top: e.color, bottom: "#2f3548" }, color: e.color || (e.look && e.look.top) || "#61afef", seed: 0 };
  const w = 34, h = full ? 55 : 27; // 5px of headroom for tall hair and hats
  const c = document.createElement("canvas");
  c.width = w * scale; c.height = h * scale;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  const tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  drawPerson(tmp.getContext("2d"), 1, 5, emp, { dir, anim, frame, t: 5000 });
  g.drawImage(tmp, 0, 0, c.width, c.height);
  return c.toDataURL();
}

window.Office = Office;
window.drawPerson = drawPerson;
window.portraitOf = portraitOf;
window.shoeDefault = shoeDefault;
