// Pixel-art office: 32px tiles, rooms with doors, BFS walking, detailed characters.
const TILE = 32;
const COLS = 30;
const ROWS = 17;
const LW = COLS * TILE;
const LH = ROWS * TILE;
const WALK_SPEED = 88;
const OUTLINE = "#1d1a1f";

const rand = (a, b) => a + Math.random() * (b - a);
const key = (x, y) => x + "," + y;

// Rooms: x0..x1, y0..y1 in tiles (inclusive)
const ROOM_NAMES = (window.PO && window.PO.strings && window.PO.strings.rooms) || {};
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

  // ---------- layout ----------
  buildStatic() {
    this.blocked.clear();
    this.doors.clear();
    this.decor = [];
    const block = (x, y) => this.blocked.add(key(x, y));
    const add = (x, y, draw) => this.decor.push({ y: (y + 1) * TILE, draw });

    for (let x = 0; x < COLS; x++) { block(x, 0); block(x, 1); }
    // interior walls with doors
    const doorTiles = [[7, 5], [7, 6], [22, 5], [22, 6], [3, 9], [4, 9], [25, 9], [26, 9], [7, 12], [7, 13], [22, 12], [22, 13]];
    for (const [x, y] of doorTiles) this.doors.add(key(x, y));
    for (let y = 2; y < ROWS; y++) { if (!this.doors.has(key(7, y))) block(7, y); if (!this.doors.has(key(22, y))) block(22, y); }
    for (let x = 0; x <= 6; x++) if (!this.doors.has(key(x, 9))) block(x, 9);
    for (let x = 23; x < COLS; x++) if (!this.doors.has(key(x, 9))) block(x, 9);

    // kitchen
    for (let x = 0; x <= 4; x++) block(x, 2);
    add(2, 2, (b, t) => drawKitchenCounter(b, 0, 2 * TILE, t));
    block(5, 2); add(5, 2, (b) => drawFridge(b, 5 * TILE, 2 * TILE));
    block(2, 6); block(3, 6); add(2, 6, (b) => drawRoundTable(b, 2 * TILE, 6 * TILE));
    add(1, 6, (b) => drawStool(b, 1 * TILE, 6 * TILE)); add(4, 6, (b) => drawStool(b, 4 * TILE, 6 * TILE));
    block(0, 8); add(0, 8, (b) => drawBin(b, 0, 8 * TILE));
    block(6, 8); add(6, 8, (b) => drawPlant(b, 6 * TILE, 8 * TILE, 1));

    // meeting room
    for (let x = 24; x <= 27; x++) for (let y = 4; y <= 5; y++) block(x, y);
    add(25, 5, (b) => drawMeetingTable(b, 24 * TILE, 4 * TILE));
    for (const [x, y, dir] of [[24, 3, "down"], [26, 3, "down"], [24, 6, "up"], [26, 6, "up"]]) {
      add(x, y, (b) => drawMeetingChair(b, x * TILE, y * TILE, dir, "back"));
      this.decor.push({ y: (y + 1) * TILE + 8, draw: (b) => drawMeetingChair(b, x * TILE, y * TILE, dir, "front") });
    }
    block(29, 2); add(29, 2, (b) => drawPlant(b, 29 * TILE, 2 * TILE, 2));
    block(23, 8); add(23, 8, (b) => drawPlant(b, 23 * TILE, 8 * TILE, 1));

    // lounge
    for (let x = 1; x <= 3; x++) block(x, 12);
    add(2, 12, (b) => drawSofa(b, 1 * TILE, 12 * TILE));
    for (let x = 1; x <= 3; x++) block(x, 14);
    add(2, 14, (b) => drawCoffeeTable(b, 1 * TILE, 14 * TILE));
    block(5, 11); add(5, 11, (b) => drawBookshelf(b, 5 * TILE, 11 * TILE));
    block(0, 10); add(0, 10, (b, t) => drawLamp(b, 0, 10 * TILE, t));
    block(6, 16); add(6, 16, (b) => drawPlant(b, 6 * TILE, 16 * TILE, 2));
    block(0, 16); add(0, 16, (b) => drawPlant(b, 0, 16 * TILE, 1));

    // archive
    for (let x = 23; x <= 25; x++) block(x, 10);
    add(24, 10, (b) => drawCabinets(b, 23 * TILE, 10 * TILE));
    block(28, 10); block(29, 10); add(28, 10, (b) => drawBoxes(b, 28 * TILE, 10 * TILE));
    block(27, 13); block(28, 13); add(27, 13, (b, t) => drawPrinter(b, 27 * TILE, 13 * TILE, t));
    block(23, 14); add(23, 14, (b) => drawCooler(b, 23 * TILE, 14 * TILE));
    block(29, 16); add(29, 16, (b) => drawPlant(b, 29 * TILE, 16 * TILE, 2));

    // open office extras
    block(8, 16); add(8, 16, (b) => drawPlant(b, 8 * TILE, 16 * TILE, 2));
    block(21, 16); add(21, 16, (b) => drawPlant(b, 21 * TILE, 16 * TILE, 2));
    block(8, 2); add(8, 2, (b, t) => drawCoffeeStation(b, 8 * TILE, 2 * TILE, t));
  }

  setEmployees(list) {
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
      return {
        ...e,
        look,
        status: e.status || "idle",
        seat,
        tx: seat.tx, ty: seat.ty,
        x: seat.tx * TILE, y: seat.ty * TILE,
        dir: "down", anim: "sit", path: [], walkDist: 0, spot: null,
        restUntil: performance.now() + rand(5000, 16000),
        bubble: null, unread: 0, seed: i * 977 + 13,
      };
    });
    this.labelsEl.innerHTML = "";
    this.labelEls.clear();
    this.roomEls = ROOMS.map((r) => {
      const el = document.createElement("div");
      el.className = "room-label";
      el.textContent = r.name;
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
    const ch = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 60;
    const raw = Math.min(cw / LW, ch / LH);
    this.scale = Math.max(0.4, Math.min(2, Math.floor(raw * 8) / 8));
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
    e.restUntil = now + rand(8000, 20000);
  }

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
    drawFloors(b);
    drawWalls(b, this.blocked, this.doors, t);
    const items = [];
    for (const d of this.decor) items.push({ y: d.y, draw: () => d.draw(b, t) });
    for (const e of this.emps) {
      const seatFeet = (e.seat.ty + 1) * TILE;
      items.push({ y: seatFeet - 24, draw: () => drawChair(b, e.seat.tx * TILE, seatFeet) });
      items.push({ y: seatFeet + TILE + 6, draw: () => drawDesk(b, e, t) });
      const frame = Math.floor(e.walkDist / 9) % 4;
      const seated = e.anim === "sit" || e.anim === "type" || e.anim === "wave" || e.anim === "slump";
      const sitFree = e.anim === "sitfree";
      const oy = e.y - 16 + (seated ? 14 : sitFree ? 6 : 0);
      items.push({
        y: e.y + TILE + (seated ? -4 : sitFree ? 4 : 1),
        draw: () => {
          const sel = e.id === this.selected, hov = e.id === this.hovered;
          if (sel || hov) drawRing(b, e.x + 16, e.y + TILE - 2, sel);
          drawPerson(b, e.x, oy, e, { dir: e.dir, anim: e.anim, frame, t, seed: e.seed });
        },
      });
    }
    items.sort((a, c) => a.y - c.y);
    for (const it of items) it.draw();
    const occupied = new Set(this.emps.filter((e) => e.spot && !e.path.length).map((e) => e.spot.key));
    for (const e of this.emps) drawOverhead(b, e, t, occupied);
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
function drawFloors(b) {
  for (const r of ROOMS) {
    const x = r.x0 * TILE, y = r.y0 * TILE, w = (r.x1 - r.x0 + 1) * TILE, h = (r.y1 - r.y0 + 1) * TILE;
    if (r.floor === "wood") drawWood(b, x, y, w, h);
    else if (r.floor === "tiles") drawTiles(b, x, y, w, h);
    else if (r.floor === "carpet") drawCarpet(b, x, y, w, h);
    else drawConcrete(b, x, y, w, h);
  }
  // door thresholds
  b.fillStyle = "#c9a273";
  for (const [x, y] of [[7, 5], [7, 6], [22, 5], [22, 6], [7, 12], [7, 13], [22, 12], [22, 13], [3, 9], [4, 9], [25, 9], [26, 9]]) b.fillRect(x * TILE, y * TILE, TILE, TILE);
  // lounge rug
  b.fillStyle = "#7d4a6b"; b.fillRect(8, 11 * TILE + 8, 144, 144);
  b.fillStyle = "#9a5d85"; b.fillRect(14, 11 * TILE + 14, 132, 132);
  b.fillStyle = "#7d4a6b"; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) b.fillRect(28 + i * 30, 11 * TILE + 28 + j * 30, 12, 12);
  b.fillStyle = "#e7c9dd"; for (let i = 0; i < 12; i++) { b.fillRect(16 + i * 11, 11 * TILE + 16, 5, 2); b.fillRect(16 + i * 11, 11 * TILE + 138, 5, 2); }
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

function drawWalls(b, blocked, doors, t) {
  // top wall face
  b.fillStyle = "#6f8896"; b.fillRect(0, 0, LW, 56);
  b.fillStyle = "#7f98a6"; b.fillRect(0, 0, LW, 3);
  b.fillStyle = "#5c7280"; b.fillRect(0, 48, LW, 8);
  b.fillStyle = "#43545f"; b.fillRect(0, 56, LW, 8);
  b.fillStyle = "#39474f"; b.fillRect(0, 62, LW, 2);
  // kitchen wall cabinets
  for (let i = 0; i < 4; i++) {
    const cx = 8 + i * 40;
    b.fillStyle = "#e9e4d8"; b.fillRect(cx, 8, 36, 34);
    b.fillStyle = "#cdc6b6"; b.fillRect(cx, 8, 36, 2); b.fillRect(cx, 40, 36, 2); b.fillRect(cx + 17, 8, 2, 34);
    b.fillStyle = "#5c5c5c"; b.fillRect(cx + 12, 24, 3, 6); b.fillRect(cx + 21, 24, 3, 6);
  }
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
      b.fillStyle = "rgba(255,255,255,.9)";
      const cx = wx + ((t / 90) % 140) - 40;
      b.fillRect(cx, 18, 22, 6); b.fillRect(cx + 5, 14, 12, 4); b.fillRect(cx + 40, 30, 16, 5); b.fillRect(cx + 44, 27, 8, 3);
      b.fillStyle = "#3f7f3f"; b.fillRect(wx, 42, 96, 6); b.fillStyle = "#5aa05a"; for (let i = 0; i < 12; i++) b.fillRect(wx + i * 8, 40 + (i % 2), 6, 3);
    }
    b.fillStyle = "#eef2f4"; b.fillRect(wx + 47, 8, 2, 40); b.fillRect(wx, 27, 96, 2);
    b.fillStyle = "rgba(240,240,236,.55)"; for (let i = 0; i < 4; i++) b.fillRect(wx, 9 + i * 4, 96, 2);
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
        b.fillStyle = "#3f4f5a"; b.fillRect(px + 7, py, 18, TILE);
        b.fillStyle = "#8ea3b0"; b.fillRect(px + 8, py, 16, TILE);
        b.fillStyle = "#a9bcc7"; b.fillRect(px + 8, py, 3, TILE);
        b.fillStyle = "#6f8896"; b.fillRect(px + 21, py, 3, TILE);
        if (!wallBelow) { b.fillStyle = "#5c7280"; b.fillRect(px + 8, py + TILE - 8, 16, 8); b.fillStyle = "#3f4f5a"; b.fillRect(px + 8, py + TILE - 2, 16, 2); }
      }
      if (horizontal) {
        b.fillStyle = "#3f4f5a"; b.fillRect(px, py + 7, TILE, 20);
        b.fillStyle = "#8ea3b0"; b.fillRect(px, py + 8, TILE, 12);
        b.fillStyle = "#a9bcc7"; b.fillRect(px, py + 8, TILE, 3);
        b.fillStyle = "#5c7280"; b.fillRect(px, py + 20, TILE, 6);
        b.fillStyle = "#3f4f5a"; b.fillRect(px, py + 25, TILE, 2);
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
  // mug
  outlineRect(b, x + 10, y + 3, 10, 11, e.color);
  b.fillStyle = "rgba(255,255,255,.35)"; b.fillRect(x + 12, y + 5, 2, 6);
  b.fillStyle = OUTLINE; b.fillRect(x + 20, y + 5, 4, 6); b.fillStyle = e.color; b.fillRect(x + 21, y + 6, 2, 4);
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

// ---------- characters (32x48 box, feet at oy+48, slim ~3.5 heads tall) ----------
function drawPerson(b, ox, oy, e, o) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) personShapes(b, ox + dx, oy + dy, e, o, OUTLINE);
  personShapes(b, ox, oy, e, o, null);
}

// Normalizes look fields (older configs used accessory: "glasses").
function outfit(L) {
  const glasses = L.glasses && L.glasses !== "none" ? L.glasses : L.accessory === "glasses" ? "square" : "none";
  const topStyle = L.blazer ? "blazer" : L.topStyle || "tshirt";
  const bottomStyle = topStyle === "dress" ? "dress" : L.bottomStyle || "pants";
  return { glasses, topStyle, bottomStyle, shoes: L.shoes || "dark", hat: L.hat && L.hat !== "none" ? L.hat : "none", hatColor: L.hatColor || "#3f51b5" };
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
  const skin = L.skin, hair = L.hair, top = L.top, bottom = L.bottom || "#2f3548";
  const topDark = shade(top, -40), topLight = shade(top, 28);
  const hairLight = shade(hair, 38), hairDark = shade(hair, -28);
  const skinDark = shade(skin, -30), bottomDark = shade(bottom, -26);
  const hatDark = shade(F.hatColor, -35), hatLight = shade(F.hatColor, 30);
  const sitting = ["sit", "type", "wave", "slump"].includes(o.anim);
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
  const fem = L.fem && F.topStyle !== "blazer" && F.topStyle !== "hoodie" && !P.belly && !P.shoulders;

  // ---- shoes (front/back), origin = top-left; width w ----
  const shoe = (x, y, w = lw + 1) => {
    switch (F.shoes) {
      case "sneakers": C("#f2f2f2"); R(x, y, w, 4); C(e.color || top); R(x + 1, y + 1, w - 2, 1); C("#9a9a9a"); R(x, y + 3, w, 1); break;
      case "boots": C("#5a3a22"); R(x, y - 3, w, 7); C("#2b1d14"); R(x, y + 3, w, 1); C("#8a5a32"); R(x + 2, y - 2, 1, 4); break;
      case "heels": C("#1c1a20"); R(x + 1, y + 1, w - 1, 3); R(x, y + 2, 1, 2); C("#4a4650"); R(x + 2, y + 1, w - 3, 1); break;
      default: C("#26222a"); R(x, y, w, 4); C("#4a4650"); R(x + 1, y, w - 2, 1);
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
      if (F.bottomStyle === "pants") { C(bottom); R(lxL, 34, lw, 7); R(lxR, 34, lw, 7); C(bottomDark); R(lxL + lw - 2, 34, 2, 7); R(lxR + lw - 2, 34, 2, 7); }
      else { C(skin); R(lxL, 34, lw, 7); R(lxR, 34, lw, 7); C(skinDark); R(lxL + lw - 2, 34, 2, 7); R(lxR + lw - 2, 34, 2, 7); }
      shoe(lxL - 1, 41); shoe(lxR, 41);
      return;
    }
    const lift = walking ? [0, 2, 0, -2][f] : 0;
    const lL = Math.max(0, lift), lR = Math.max(0, -lift);
    if (F.bottomStyle === "pants") {
      C(bottom); R(lxL, 29, lw, 15 - lL); R(lxR, 29, lw, 15 - lR);
      C(bottomDark); R(lxL + lw - 2, 29, 2, 15 - lL); R(lxR + lw - 2, 29, 2, 15 - lR);
    } else if (F.bottomStyle === "shorts") {
      C(bottom); R(lxL, 29, lw, 6); R(lxR, 29, lw, 6); C(bottomDark); R(lxL + lw - 2, 29, 2, 6); R(lxR + lw - 2, 29, 2, 6); R(lxL, 34, lxR + lw - lxL, 1);
      C(skin); R(lxL, 35, lw, 9 - lL); R(lxR, 35, lw, 9 - lR); C(skinDark); R(lxL + lw - 2, 35, 2, 9 - lL); R(lxR + lw - 2, 35, 2, 9 - lR);
    } else {
      const y0 = F.bottomStyle === "dress" ? 27 : 29;
      C(clothColor); R(tx - 1, y0, tw + 2, 4); R(tx - 2, y0 + 4, tw + 4, 37 - y0);
      C(clothDark); R(tx - 2, 36, tw + 4, 1); R(tx + tw - 1, y0 + 2, 3, 35 - y0);
      C(skin); R(lxL, 37, lw, 7 - lL); R(lxR, 37, lw, 7 - lR); C(skinDark); R(lxL + lw - 2, 37, 2, 7 - lL); R(lxR + lw - 2, 37, 2, 7 - lR);
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
    } else {
      C(skinDark); R(cx - 2, 16 + T, 4, 1);
    }
    if (F.topStyle !== "dress") { C("#33303a"); R(P.belly ? tx - 1 : tx, 28 + T, P.belly ? tw + 2 : tw, 1); }
    C(skin); R(14, 14 + H, 4, 3); // neck
    if (P.belly) { C(skin); R(13, 14 + H, 6, 3); }
  };

  const arm = (x, y, sleeve, hand) => { C(top); R(x, y, aw, sleeve); if (hand) { C(skin); R(x, y + sleeve, aw, 4); } if (P.shoulders) { C(topDark); R(x, y + 3, aw, 1); } };

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
        C(top); R(axR, 6 + H, aw, 12);
        C(skin); R(axR + (Math.floor(o.t / 250) % 2), 2 + H, aw + 1, 4);
        break;
      }
      case "drink": {
        const sip = Math.floor(o.t / 1500) % 4 === 0;
        arm(axL, 17 + T, 7, true);
        const my = sip ? 8 + H : 20 + T;
        C(top); R(axR, 17 + T, aw, sip ? 3 : 6);
        C(skin); R(axR - 1, my + 4, 4, 3);
        C("#f5f5f5"); R(axR - 1, my, 8, 8);
        C(e.color); R(axR + 1, my + 2, 4, 4);
        break;
      }
      case "think": {
        arm(axL, 17 + T, 7, true);
        C(top); R(axR, 17 + T, aw, 5);
        C(skin); R(19, 11 + H, 5, 4);
        break;
      }
      case "read": {
        C(top); R(axL, 17 + T, aw, 5); R(axR, 17 + T, aw, 5);
        C("#f5f5f5"); R(cx - 8, 21 + T, 16, 9);
        C("#33303a"); R(cx - 1, 21 + T, 2, 9);
        C("#9aa"); R(cx - 6, 24 + T, 4, 1); R(cx - 6, 27 + T, 4, 1); R(cx + 2, 24 + T, 4, 1); R(cx + 2, 27 + T, 3, 1);
        C(skin); R(axL, 25 + T, aw, 4); R(axR, 25 + T, aw, 4);
        break;
      }
      case "slump": arm(axL, 19 + T, 7, true); arm(axR, 19 + T, 7, true); break;
      case "sitfree": arm(axL, 17 + T, 7, true); arm(axR, 17 + T, 7, true); break;
      default: arm(axL, 17 + T + swing, 7, true); arm(axR, 17 + T - swing, 7, true);
    }
  };

  const hatFront = () => {
    if (F.hat === "cap") {
      C(F.hatColor); R(8, 0 + H, 16, 6); R(9, -1 + H, 14, 1);
      C(hatLight); R(10, 1 + H, 5, 1);
      C(hatDark); R(7, 6 + H, 18, 2); R(15, 0 + H, 1, 6);
    } else if (F.hat === "beanie") {
      C(F.hatColor); R(8, -1 + H, 16, 8); R(9, -2 + H, 14, 1);
      C(hatDark); R(8, 5 + H, 16, 2);
      C(hatLight); R(13, -4 + H, 6, 2); R(10, 0 + H, 4, 1);
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

  const headFront = () => {
    C(skin);
    if (L.fem) { R(10, 3 + H, 12, 9); R(11, 12 + H, 10, 2); R(13, 14 + H, 6, 1); }
    else { R(10, 3 + H, 12, 10); R(11, 13 + H, 10, 2); }
    if (P.belly) { C(skin); R(9, 8 + H, 1, 6); R(22, 8 + H, 1, 6); R(10, 13 + H, 12, 2); }
    C(skinDark); R(20, 6 + H, 2, L.fem ? 6 : 7);
    C(hair); R(9, 1 + H, 14, 6); R(10, 0 + H, 12, 1); R(9, 7 + H, 2, 3); R(21, 7 + H, 2, 3);
    C(hairLight); R(12, 2 + H, 4, 1);
    hairFront(b, ox, oy + H, L, C);
    hatFront();
    if (!blink) {
      C("#1c1a20"); R(12, 8 + H, 2, 3); R(18, 8 + H, 2, 3);
      if (L.fem) { C("#1c1a20"); R(11, 7 + H, 3, 1); R(18, 7 + H, 3, 1); R(11, 8 + H, 1, 1); R(20, 8 + H, 1, 1); }
      C("#ffffff"); R(12, 8 + H, 1, 1); R(18, 8 + H, 1, 1);
      if (L.fem) { C("#4a9de0"); R(13, 9 + H, 1, 1); R(19, 9 + H, 1, 1); }
    } else { C("#1c1a20"); R(12, 10 + H, 2, 1); R(18, 10 + H, 2, 1); if (L.fem) { R(11, 10 + H, 1, 1); R(20, 10 + H, 1, 1); } }
    if (F.hat === "none") { C(hairDark); R(12, 6 + H, 2, 1); R(18, 6 + H, 2, 1); }
    if (L.fem) { C("#d4607a"); R(15, 12 + H, 2, 1); C("#e98aa0"); R(15, 12 + H, 1, 1); }
    else { C(skinDark); R(15, 12 + H, 2, 1); }
    C(L.fem ? "#f0a0a8" : "#eaa5a0"); R(11, 11 + H, 1, 1); R(20, 11 + H, 1, 1);
    if (L.fem && L.hairStyle !== "long") { C("#f2c14e"); R(9, 10 + H, 1, 2); R(22, 10 + H, 1, 2); }
    if (L.beard) { C(hair); R(10, 11 + H, 2, 3); R(20, 11 + H, 2, 3); R(11, 13 + H, 10, 2); C(skinDark); R(15, 12 + H, 2, 1); }
    glassesFront();
    accessoryFront(b, ox, oy + H, L, C);
  };

  const headBack = () => {
    C(hair); R(9, 1 + H, 14, 13); R(10, 0 + H, 12, 1);
    C(hairLight); R(12, 2 + H, 5, 1);
    C(hairDark); R(9, 12 + H, 14, 2);
    C(skin); R(14, 14 + H, 4, 3);
    switch (L.hairStyle) {
      case "long": C(hair); R(8, 8 + H, 16, 17); C(hairDark); R(8, 23 + H, 16, 2); C(hairLight); R(11, 10 + H, 1, 9); break;
      case "ponytail": C(hairDark); R(14, 10 + H, 4, 3); C(hair); R(13, 12 + H, 6, 15); C(hairDark); R(13, 25 + H, 6, 2); C(hairLight); R(14, 14 + H, 1, 8); break;
      case "bun": C(hair); R(12, -4 + H, 8, 6); C(hairLight); R(14, -3 + H, 3, 1); break;
      case "curly": C(hair); R(8, 4 + H, 1, 8); R(23, 4 + H, 1, 8); R(11, -1 + H, 3, 1); R(18, -1 + H, 3, 1); break;
    }
    if (F.hat === "cap") { C(F.hatColor); R(8, 0 + H, 16, 6); R(9, -1 + H, 14, 1); C(hatDark); R(8, 5 + H, 16, 2); R(13, 4 + H, 6, 2); }
    if (F.hat === "beanie") { C(F.hatColor); R(8, -1 + H, 16, 8); R(9, -2 + H, 14, 1); C(hatDark); R(8, 5 + H, 16, 2); C(hatLight); R(13, -4 + H, 6, 2); }
    if (F.topStyle === "hoodie") { C(topDark); R(cx - 8, 12 + T, 16, 7); C(top); R(cx - 7, 13 + T, 14, 5); }
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
    if (F.topStyle !== "dress") { C("#33303a"); R(tx, 28 + T, tw, 1); }
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
        if (F.bottomStyle === "pants") { C(bottom); R(legF + 2, 34, lw, 7); C(bottomDark); R(legF + 2, 34, 1, 7); } else { C(skin); R(legF + 2, 34, lw, 7); }
        shoe(legF + 2, 41, lw + 2);
      } else {
        const back = Math.max(0, -step), fwd = Math.max(0, step);
        if (F.bottomStyle === "pants") {
          C(bottomDark); R(legB - back, 29, lw, 15 - back);
          C(bottom); R(legF + fwd, 29, lw, 15 - fwd);
        } else if (F.bottomStyle === "shorts") {
          C(bottomDark); R(legB - back, 29, lw, 6); C(bottom); R(legF + fwd, 29, lw, 6);
          C(skinDark); R(legB - back, 35, lw, 9 - back); C(skin); R(legF + fwd, 35, lw, 9 - fwd);
        } else {
          const y0 = F.bottomStyle === "dress" ? 27 : 29;
          C(clothColor); R(sx - 1, y0, sw + 3, 4); R(sx - 2, y0 + 4, sw + 5, 37 - y0);
          C(clothDark); R(sx - 2, 36, sw + 5, 1);
          C(skinDark); R(legB - back, 37, lw, 7 - back); C(skin); R(legF + fwd, 37, lw, 7 - fwd);
        }
        shoe(legB - back - 1, 44 - back, lw + 1); shoe(legF + fwd - 1, 44 - fwd, lw + 2);
      }
    }
    if (F.topStyle === "hoodie") { C(topDark); R(sx - 4, 11 + H, 9, 7); }
    C(top);
    if (fem) { R(sx, 16 + T, sw, 7); R(sx + sw, 18 + T, 1, 4); R(sx + 1, 23 + T, sw - 2, 3); R(sx, 26 + T, sw, 3); }
    else R(sx, 16 + T, sw, 13);
    if (P.belly) { C(top); R(sx + sw, 20 + T, 2, 8); C(topLight); R(sx + sw - 2, 22 + T, 2, 3); }
    if (P.shoulders) { C(top); R(sx - 1, 16 + T, sw + 2, 4); }
    C(topDark); R(sx, 17 + T, 2, fem ? 6 : 11); R(sx, 27 + T, sw, 2); C(topLight); R(sx + 4, 17 + T, 3, 3);
    if (F.topStyle === "blazer") { C(L.blazer); R(sx, 16 + T, sw, 13); C(top); R(sx + sw - 3, 16 + T, 3, 6); }
    if (F.topStyle === "hoodie") { C(topDark); R(sx + 3, 25 + T, 5, 3); C("#f5f5f5"); R(sx + sw - 3, 17 + T, 1, 4); }
    if (F.topStyle !== "dress") { C("#33303a"); R(sx, 28 + T, sw, 1); }
    C(skin); R(14, 14 + H, 4, 3);
    const ax = sx + Math.floor((sw - aw) / 2);
    if (o.anim === "drink") {
      C(top); R(ax + 1, 17 + T, aw, 5); C(skin); R(ax + 3, 21 + T, 3, 3);
      C("#f5f5f5"); R(ax + 4, 18 + T, 7, 8); C(e.color); R(ax + 6, 20 + T, 3, 4);
    } else if (o.anim === "read") {
      C(top); R(ax + 1, 17 + T, aw, 4); C("#f5f5f5"); R(ax + 2, 21 + T, 10, 8); C("#9aa"); R(ax + 4, 24 + T, 5, 1); R(ax + 4, 27 + T, 4, 1); C(skin); R(ax + 1, 24 + T, aw, 4);
    } else if (o.anim === "sitfree") {
      C(top); R(ax + 1, 17 + T, aw, 6); C(skin); R(ax + 2, 23 + T, aw, 4);
    } else {
      C(top); R(ax + step, 17 + T, aw, 7); C(skin); R(ax + step, 24 + T, aw, 4);
    }
    C(skin);
    if (L.fem) { R(12, 3 + H, 10, 9); R(13, 12 + H, 9, 2); R(15, 14 + H, 6, 1); } else { R(12, 3 + H, 10, 10); R(13, 13 + H, 8, 2); }
    if (P.belly) { C(skin); R(22, 8 + H, 1, 6); R(12, 13 + H, 10, 2); }
    C(hair); R(10, 1 + H, 13, 6); R(11, 0 + H, 10, 1); R(10, 7 + H, 4, 7);
    C(hairLight); R(12, 2 + H, 5, 1);
    hairSide(b, ox, oy + H, L, C);
    if (F.hat === "cap") { C(F.hatColor); R(9, 0 + H, 14, 6); R(10, -1 + H, 12, 1); C(hatDark); R(17, 5 + H, 9, 2); C(hatLight); R(11, 1 + H, 4, 1); }
    if (F.hat === "beanie") { C(F.hatColor); R(9, -1 + H, 14, 8); R(10, -2 + H, 12, 1); C(hatDark); R(9, 5 + H, 14, 2); C(hatLight); R(11, -4 + H, 5, 2); }
    if (!blink) { C("#1c1a20"); R(17, 8 + H, 2, 3); if (L.fem) R(17, 7 + H, 3, 1); C("#fff"); R(17, 8 + H, 1, 1); } else { C("#1c1a20"); R(17, 10 + H, 2, 1); }
    if (F.hat === "none") { C(hairDark); R(17, 6 + H, 3, 1); }
    C(skinDark); R(22, 9 + H, 1, 2);
    if (L.fem) { C("#d4607a"); R(19, 12 + H, 2, 1); } else { C(skinDark); R(19, 12 + H, 2, 1); }
    C(L.fem ? "#f0a0a8" : "#eaa5a0"); R(16, 11 + H, 1, 1);
    if (L.beard) { C(hair); R(14, 12 + H, 8, 3); }
    if (F.glasses === "square") { C("#6b7482"); R(16, 11 + H, 4, 1); R(20, 8 + H, 1, 3); R(14, 8 + H, 3, 1); }
    if (F.glasses === "round") { C("#3a3f4a"); R(16, 7 + H, 4, 1); R(16, 11 + H, 4, 1); R(20, 8 + H, 1, 3); R(14, 8 + H, 2, 1); }
    if (F.glasses === "sun") { C("#1c1a20"); R(16, 8 + H, 5, 3); R(14, 8 + H, 2, 1); }
    if (L.accessory === "headphones") { C("#222"); R(10, 3 + H, 13, 2); R(10, 7 + H, 4, 6); C("#444"); R(11, 8 + H, 2, 4); }
    if (L.accessory === "headset") { C("#222"); R(10, 3 + H, 13, 2); R(10, 7 + H, 3, 5); R(13, 12 + H, 4, 1); R(17, 13 + H, 5, 2); }
  }
  if (flip) b.restore();
}

function hairFront(b, ox, hy, L, C) {
  const R = (x, y, w, h) => b.fillRect(ox + x, hy + y, w, h);
  C(L.hair);
  switch (L.hairStyle) {
    case "long":
      R(7, 5, 4, 19); R(21, 5, 4, 19); R(10, 6, 3, 2); R(19, 6, 3, 2);
      C(shade(L.hair, -28)); R(7, 22, 4, 2); R(21, 22, 4, 2);
      C(shade(L.hair, 40)); R(8, 8, 1, 6); R(22, 9, 1, 5);
      break;
    case "bun": R(12, -4, 8, 6); R(11, 6, 4, 2); R(19, 6, 3, 1); C(shade(L.hair, 40)); R(14, -3, 3, 1); R(11, 2, 1, 3); break;
    case "ponytail": R(10, 6, 5, 2); R(18, 6, 4, 1); C(shade(L.hair, 40)); R(12, 2, 4, 1); R(11, 3, 1, 3); C(shade(L.hair, -22)); R(17, 2, 1, 5); break;
    case "curly": R(8, 4, 1, 8); R(23, 4, 1, 8); R(11, -1, 3, 1); R(18, -1, 3, 1); R(15, -1, 2, 1); break;
    default: R(10, 6, 5, 2); C(shade(L.hair, -22)); R(16, 2, 1, 5);
  }
}

function hairSide(b, ox, hy, L, C) {
  const R = (x, y, w, h) => b.fillRect(ox + x, hy + y, w, h);
  C(L.hair);
  switch (L.hairStyle) {
    case "long": R(7, 5, 7, 19); C(shade(L.hair, -28)); R(7, 22, 7, 2); C(shade(L.hair, 40)); R(9, 8, 1, 7); break;
    case "bun": R(7, -3, 8, 7); C(shade(L.hair, 40)); R(9, -2, 3, 1); break;
    case "ponytail": R(5, 7, 6, 14); R(8, 4, 5, 4); C(shade(L.hair, -28)); R(5, 12, 6, 2); C(shade(L.hair, 40)); R(7, 8, 1, 6); break;
    case "curly": R(8, 4, 2, 9); R(12, -1, 3, 1); R(17, -1, 3, 1); break;
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

function shade(hex, delta) {
  if (!hex || hex[0] !== "#") return hex;
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, v + delta));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

// Head-and-shoulders portrait as a data URL; `full` renders the whole standing figure.
function portraitOf(e, scale = 3, full = false, dir = "down", anim = "stand", frame = 0) {
  const emp = { look: e.look || { skin: "#f1c9a5", hair: "#3b2a20", hairStyle: "short", top: e.color, bottom: "#2f3548" }, color: e.color || (e.look && e.look.top) || "#61afef", seed: 0 };
  const w = 34, h = full ? 52 : 24;
  const c = document.createElement("canvas");
  c.width = w * scale; c.height = h * scale;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  const tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  drawPerson(tmp.getContext("2d"), 1, 2, emp, { dir, anim, frame, t: 5000 });
  g.drawImage(tmp, 0, 0, c.width, c.height);
  return c.toDataURL();
}

window.Office = Office;
window.drawPerson = drawPerson;
window.portraitOf = portraitOf;
