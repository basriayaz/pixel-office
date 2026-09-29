// Pixel-art office: 32px tiles, rooms with doors, BFS walking, detailed characters.
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)");
const TILE = 32;
const { COLS, ROWS, ENTRANCE } = POLayout; // the room grid and the entrance doormat; furniture, spots and desks come from web/layout.js
const LW = COLS * TILE;
const LH = ROWS * TILE;
const WALK_SPEED = 88;
const CONFETTI = ["#ff3b3b", "#ffd166", "#4ade80", "#61afef", "#c678dd", "#ff8c42", "#f4f4f4"];
const OUTLINE = "#1d1a1f";

const rand = (a, b) => a + Math.random() * (b - a);
const key = (x, y) => x + "," + y;

// Rooms: x0..x1, y0..y1 in tiles (inclusive)
const ROOM_NAMES = (window.PO && window.PO.strings && window.PO.strings.rooms) || {};
const roomName = (theme, key) => (ROOM_NAMES[theme] && ROOM_NAMES[theme][key]) || ROOM_NAMES[key] || key.toUpperCase();
const ROOMS = POLayout.ROOMS.map((r) => ({ ...r, name: ROOM_NAMES[r.key] || (r.key === "office" ? "OPEN OFFICE" : r.key.toUpperCase()) }));

// Furniture is data (web/layout.js: items {id, type, tx, ty, dir?}); the hangout spots {key, tx, ty, dir, anim, via?}, the meeting places,
// the blocked tiles, the desks and the event tiles are all derived from those records and live on the Office (this.spots, this.meetingSpots,
// this.blocked, this.scene). `via` = the tile a character must step in from (so nobody climbs over a sofa back or a table).

// Which PROPS slot draws a piece; `t` = the animation clock is handed to it, `kind` = the plant variant.
const ITEM_DRAW = {
  counter: { prop: "kitchenCounter", t: true }, fridge: { prop: "fridge" }, roundTable: { prop: "roundTable" }, stool: { prop: "stool" }, bin: { prop: "bin" },
  plant: { prop: "plant", kind: true }, meetingTable: { prop: "meetingTable" }, sofa: { prop: "sofa" }, coffeeTable: { prop: "coffeeTable" },
  bookshelf: { prop: "bookshelf" }, lamp: { prop: "lamp", t: true }, cabinets: { prop: "cabinets" }, boxes: { prop: "boxes" },
  printer: { prop: "printer", t: true }, cooler: { prop: "cooler" }, coffeeStation: { prop: "coffeeStation", t: true },
};

// The draw entries of one piece (depth = the row of its feet, like the old hard-coded list).
function itemDecor(theme, it, out) {
  const P = (name) => prop(it.skin || theme, name); // (a piece may wear another theme's look)
  const x = it.tx * TILE, y = it.ty * TILE;
  const sy = (it.ty + (POLayout.TYPES[it.type].sort || 0) + 1) * TILE;
  if (it.type === "meetingChair") {
    const dir = it.dir || "down";
    out.push({ id: it.id, y: sy, draw: (b) => P("meetingChair")(b, x, y, dir, "back") });
    out.push({ id: it.id, y: sy + 8, draw: (b) => P("meetingChair")(b, x, y, dir, "front") });
    return;
  }
  const d = ITEM_DRAW[it.type];
  if (!d) return;
  if (d.t) out.push({ id: it.id, y: sy, draw: (b, t) => P(d.prop)(b, x, y, t) });
  else if (d.kind) out.push({ id: it.id, y: sy, draw: (b) => P(d.prop)(b, x, y, it.v || 1) });
  else out.push({ id: it.id, y: sy, draw: (b) => P(d.prop)(b, x, y) });
}

// Blocked tiles, doors and depth-sorted draw entries for a theme and a list of furniture (default: the classic layout without desks).
function buildStaticFor(theme, items = POLayout.defaultItems()) {
  const built = POLayout.build(items);
  const doors = new Set(POLayout.DOORS.map(([x, y]) => key(x, y)));
  const decor = [];
  for (const it of items) if (it.type !== "desk") itemDecor(theme, it, decor);
  // entrance doormat (walkable)
  decor.push({ y: ENTRANCE.ty * TILE + 2, draw: (b) => { const x = ENTRANCE.tx * TILE + 2, y = ENTRANCE.ty * TILE + 14; outlineRect(b, x, y, 28, 16, "#6b4a2b"); b.fillStyle = "#8a6a3b"; for (let i = 0; i < 6; i++) b.fillRect(x + 2, y + 2 + i * 2.5, 24, 1); b.fillStyle = "#c9a781"; b.fillRect(x + 8, y + 6, 12, 4); } });
  return { blocked: built.blocked, doors, decor, build: built };
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
    this.layoutDoc = null;      // the saved furniture layout (null = the classic one)
    this.scene = null;          // resolved layout: items, derived build, who sits at which desk
    this.spots = [];            // hangout spots derived from the furniture
    this.meetingSpots = [];     // meeting chairs first, then standing places
    this.freeSeats = new Set(); // seat tiles of desks nobody sits at
    this.rosterIds = [];
    this.editing = false;
    this.theme = "default";
    this.particles = [];
    this.last = performance.now();
    this.labelEls = new Map();
    this.roomEls = [];
    canvas.addEventListener("mousemove", (e) => { if (!this.editing) this.onMove(e); });
    canvas.addEventListener("mouseleave", () => { this.hovered = null; canvas.classList.remove("hover"); });
    canvas.addEventListener("click", (e) => {
      if (this.editing) return; // the layout editor owns the pointer
      const id = this.hitTest(e);
      if (id) this.react(id); // little hop / wave + balloon; never blocks the panel below
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
    for (const { r, el } of this.roomEls) el.textContent = roomName(this.theme, r.key);
    this.labelsEl.classList.toggle("dark", !!(THEMES[this.theme] || {}).dark);
  }

  // ---------- layout ----------
  // Everything static comes from the furniture records: blocked tiles, decor draw list, spots, meeting places, desks.
  buildStatic() {
    const sc = POLayout.scene(this.layoutDoc, this.rosterIds, this.theme, this.progress || 0);
    const st = buildStaticFor(this.theme, sc.items);
    this.scene = sc;
    this.wallItems = POLayout.wallOf(sc.items); // the wall decor
    this.rugItems = sc.items.filter((it) => it.type === "rug");
    this.blocked = st.blocked;
    this.doors = st.doors;
    this.baseDecor = st.decor;
    this.decor = st.decor;
    // spots that did not change keep their object (people standing at them are undisturbed)
    const pool = new Map([...this.spots, ...this.meetingSpots].map((s) => [s.key, s]));
    const same = (a, c) => a.tx === c.tx && a.ty === c.ty && a.dir === c.dir && a.anim === c.anim && a.group === c.group && a.wk === c.wk && JSON.stringify(a.via) === JSON.stringify(c.via);
    const fix = (s) => { const o = pool.get(s.key); return o && same(o, s) ? o : s; };
    this.spots = sc.build.spots.map(fix);
    this.meetingSpots = sc.build.meetingSpots.map(fix);
    const seated = new Set(sc.assign.values());
    this.freeSeats = new Set(sc.build.desks.filter((d) => !seated.has(d.id)).map((d) => key(d.tx, d.ty)));
  }

  // Wall pieces unlocked by finished work (an office whose decor is not stored yet shows them at once; a stored one gets them in the
  // market's depot): rebuilt only when the count changes.
  setProgress(n) {
    n = Math.max(0, Math.min(5, Math.floor(Number(n)) || 0));
    if (n === (this.progress || 0)) return;
    this.progress = n;
    if (this.scene) this.buildStatic();
  }

  // The seat of a colleague: the tile in front of their desk. Without a desk (nothing fits) a free tile near the entrance with just a chair.
  seatFor(id) {
    const sc = this.scene, deskId = sc.assign.get(id);
    const d = deskId && sc.build.desks.find((x) => x.id === deskId);
    if (d) return { tx: d.tx, ty: d.ty, desk: d.id };
    const taken = new Set([...this.emps.filter((e) => e.id !== id && e.seat).map((e) => key(e.seat.tx, e.seat.ty)), ...sc.build.spots.map((s) => key(s.tx, s.ty))]);
    const [tx, ty] = POLayout.nearestFree(sc.build, [ENTRANCE.tx, ENTRANCE.ty - 1], taken) || [ENTRANCE.tx, ENTRANCE.ty - 1];
    return { tx, ty, desk: null, none: true };
  }

  setEmployees(list, entering = null) {
    const seated = list.slice(0, POLayout.MAX_EMP);
    this.rosterIds = seated.map((e) => e.id);
    this.buildStatic();
    const prev = new Map(this.emps.map((e) => [e.id, e]));
    this.emps = seated.map((e, i) => {
      const seat = this.seatFor(e.id);
      const look = e.look || { skin: "#f1c9a5", hair: "#3b2a20", hairStyle: "short", top: e.color, bottom: "#2f3548" };
      const old = prev.get(e.id);
      if (old && old.seat.tx === seat.tx && old.seat.ty === seat.ty) {
        old.seat = seat;
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
    // already ill when the page loaded: head for the sofa like a fresh case would
    for (const e of this.emps) if (e.status === "sick" && !e.spot && !e.entering) this.restOnSofa(e);
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
      el.textContent = e.name; // names and roles are the boss's free text: never markup
      const small = document.createElement("small");
      small.textContent = e.role;
      el.appendChild(small);
      this.labelsEl.appendChild(el);
      this.labelEls.set(e.id, el);
    }
    this.placeRoomLabels();
    this.warnDesks();
  }

  // ---------- layout changes (the editor, another browser, a new hire) ----------
  // Stored only: setEmployees builds the scene right after (switching offices).
  setLayoutDoc(doc) { this.layoutDoc = doc || null; }

  // A new furniture layout while the office is running.
  applyLayout(doc) {
    this.layoutDoc = doc || null;
    this.relayout();
  }

  // Rebuild everything derived from the furniture, then make sure every colleague still has somewhere valid to be:
  // spots that vanished or moved are let go, walkers whose path is now blocked are re-routed, anybody standing where a piece
  // now stands is set down on the nearest free tile, and a moved desk is walked to.
  relayout() {
    const now = performance.now();
    const oldSeats = new Map(this.emps.map((e) => [e.id, e.seat]));
    this.rosterIds = this.emps.map((e) => e.id);
    const atEvent = new Set(this.emps.filter((e) => e.spot && e.spot.evt));
    if (this.evt && this.evt.kind !== "blackout") this.endEvent(now); // its table / printer may be gone
    this.buildStatic();
    const alive = new Set([...this.spots, ...this.meetingSpots]);
    const redo = [];
    for (const e of this.emps) {
      const seat = this.seatFor(e.id), was = oldSeats.get(e.id);
      let dirty = !was || was.tx !== seat.tx || was.ty !== seat.ty;
      e.seat = seat;
      if (atEvent.has(e)) { e.path = []; dirty = true; } // on their way to the (now ended) event: head back
      if (e.spot && !e.spot.evt && !alive.has(e.spot)) { e.spot = null; dirty = true; }
      if (e.napSpot && !alive.has(e.napSpot)) e.napSpot = null;
      if (e.errand && this.blocked.has(key(e.errand.tx, e.errand.ty))) { e.errand = null; dirty = true; }
      if (this.standsOnFurniture(e)) { this.setDown(e); dirty = true; }
      else if (e.path.length && this.pathBroken(e)) { e.path = []; dirty = true; }
      if (dirty) { e.spotTalk = null; e.lifeSpot = null; this.endAct(e, now, false); redo.push(e); }
    }
    for (const e of redo) this.resume(e, now);
    if (this.meetingOn) this.assignMeetingSpots();
    this.warnDesks();
  }

  // On furniture, or shut in a pocket that no walkway leads to any more.
  standsOnFurniture(e) {
    if (e.ty >= ROWS || e.tx < 0 || e.ty < 0 || e.tx >= COLS) return false; // still outside, walking in
    const k = key(e.tx, e.ty);
    if (e.spot && e.spot.tx === e.tx && e.spot.ty === e.ty) return false; // sitting on the sofa is fine
    if (this.blocked.has(k)) return true;
    const b = this.scene.build;
    if (b.soft.has(k) && !e.path.length && !(e.seat && e.seat.tx === e.tx && e.seat.ty === e.ty)) return true; // resting on a chair / stool / desk seat that is not theirs
    if (b.reach.size < 40 || b.reach.has(k)) return false; // (an entrance walled in by the classic 11+ desk grid: no way to tell)
    return !(e.seat && e.seat.tx === e.tx && e.seat.ty === e.ty) && !(b.soft.has(k) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => b.reach.has(key(e.tx + dx, e.ty + dy))));
  }

  pathBroken(e) {
    const goal = e.spot ? key(e.spot.tx, e.spot.ty) : key(e.seat.tx, e.seat.ty);
    return e.path.some((p, i) => {
      const k = key(p.tx, p.ty);
      return (this.blocked.has(k) || this.freeSeats.has(k)) && !(i === e.path.length - 1 && k === goal);
    });
  }

  // Put somebody on the nearest free, reachable tile.
  setDown(e) {
    const taken = new Set(this.emps.filter((o) => o !== e).map((o) => key(o.tx, o.ty)));
    const [x, y] = POLayout.nearestFree(this.scene.build, [e.tx, e.ty], taken) || [ENTRANCE.tx, ENTRANCE.ty];
    Object.assign(e, { tx: x, ty: y, x: x * TILE, y: y * TILE, path: [], spot: null, napSpot: null, dir: "down", anim: "stand", restUntil: performance.now() + rand(800, 2500) });
  }

  // Back to what they should be doing after their surroundings changed.
  resume(e, now) {
    if (e.spot && !e.spot.evt) {
      if (e.tx === e.spot.tx && e.ty === e.spot.ty && !e.path.length) return;
      if (this.goToSpot(e, e.spot)) return;
      e.spot = null; e.napSpot = null;
    }
    if (e.meet) return; // assignMeetingSpots gives them a place
    if (e.status === "sick") { this.restOnSofa(e); return; }
    if (this.atSeat(e)) return;
    if (!this.goTo(e, e.seat.tx, e.seat.ty)) { this.setDown(e); this.goTo(e, e.seat.tx, e.seat.ty); }
    e.restUntil = Math.max(e.restUntil, now + 1000);
  }

  // Says so once when somebody has no desk to sit at (nothing fits any more).
  warnDesks() {
    const miss = this.scene ? this.scene.missing.join(",") : "";
    if (miss && miss !== this.warnedDesks && typeof toast === "function" && typeof t === "function") toast(t("ui.layout.noDesk"));
    this.warnedDesks = miss;
  }

  placeRoomLabels() {
    for (const { r, el } of this.roomEls) {
      el.style.left = ((r.x0 + r.x1 + 1) / 2) * TILE * this.scale + "px";
      el.style.top = (r.y1 + 1) * TILE * this.scale - 14 * this.scale + "px";
    }
  }

  setTool(id, kind) {
    const e = this.emps.find((x) => x.id === id);
    if (e) e.tool = { kind, t0: performance.now() };
  }

  // Life at the desk: how long the colleague has been at it (deep focus) and idle micro moves
  // (stretch / glance at the watch / check the phone) on a timer like the mug sip.
  deskLife(e, now) {
    if (e.status === "working") { if (!e.workSince) e.workSince = now; } else e.workSince = 0;
    if (REDUCED_MOTION.matches || e.anim !== "sit" || e.status !== "idle") { e.micro = null; return; }
    if (e.micro) {
      if (now - e.micro.t0 > MICRO_MS[e.micro.kind]) { e.micro = null; e.microAt = now + rand(10000, 26000); }
      else if (e.micro.kind === "giggle") {
        // snickering at the phone: two short bursts of laughter, sometimes with a remark in a balloon
        const m = e.micro;
        if (!m.g) { m.g = [m.t0 + 900, m.t0 + 2400]; m.talk = Math.random() < 0.7; }
        if (m.g.length && now >= m.g[0]) {
          m.g.shift();
          this.startLaugh(e, now, 1100, { v: "giggle", amp: 0.7, text: false });
          if (m.talk && !m.g.length) { const g = lifePick(lifeStrings().giggle); if (g) this.say(e, g, lifeMs(g)); }
        }
      }
    } else if (e.microAt == null) e.microAt = now + rand(6000, 18000);
    else if (now > e.microAt) e.micro = { kind: MICRO_KINDS[Math.floor(Math.random() * MICRO_KINDS.length)], t0: now };
  }

  setStatus(id, status, reason) {
    const e = this.emps.find((x) => x.id === id);
    if (!e || e.status === status) return;
    const prev = e.status;
    e.status = status;
    e.tool = null;
    e.sayLater = null;
    this.endAct(e, performance.now(), false);
    e.pulse = { t0: performance.now(), col: status === "working" ? "#4ade80" : status === "error" ? "#f87171" : status === "waiting" ? "#ffd166" : "#ffffff" };
    const now = performance.now();
    if (e.meet) { e.bubble = null; return; } // in a meeting: stays in the room whatever the status
    if (status === "working" || status === "waiting" || status === "error") {
      e.spot = null;
      e.bubble = null;
      if (!this.atSeat(e)) this.goTo(e, e.seat.tx, e.seat.ty);
    } else if (status === "sick") {
      e.bubble = null;
      this.restOnSofa(e);
    } else if (status === "idle" && reason === "interrupted") {
      e.bubble = null;
      e.restUntil = now + rand(6000, 15000);
    } else if (status === "idle" && (prev === "working" || prev === "waiting")) {
      e.bubble = { kind: "done", until: now + 4000 };
      e.restUntil = now + rand(9000, 22000);
      this.celebrateDone(e, now);
    }
    if (status === "error") this.comfort(e, now);
  }

  // Off to the lounge sofa (or any free seat) to rest until it passes; stays at the desk if nothing is free.
  restOnSofa(e) {
    const taken = new Set(this.emps.filter((o) => o !== e && o.spot).map((o) => o.spot.key));
    const s = this.spots.find((x) => x.group === "sofa" && !taken.has(x.key)) || this.spots.find((x) => x.anim === "sitfree" && !taken.has(x.key));
    if (s && this.goToSpot(e, s)) e.spot = s;
    else { e.spot = null; this.goTo(e, e.seat.tx, e.seat.ty); }
  }

  // Meeting on: participants gather in the meeting room; `hands` = ids with a raised hand. null ends it.
  setMeeting(ids, hands = []) {
    const inRoom = new Set(ids || []);
    const raised = new Set(hands);
    this.meetingOn = inRoom.size > 0;
    const now = performance.now();
    for (const e of this.emps) {
      e.hand = raised.has(e.id);
      if (inRoom.has(e.id)) {
        if (e.meet) continue;
        e.meet = true;
        e.bubble = null;
        e.spot = null;
      } else if (e.meet) {
        e.meet = false;
        e.spot = null;
        this.goTo(e, e.seat.tx, e.seat.ty);
        e.restUntil = now + rand(9000, 22000);
      } else if (this.meetingOn && e.spot && e.spot.meet) {
        // somebody idling in the meeting room makes way
        e.spot = null;
        this.goTo(e, e.seat.tx, e.seat.ty);
        e.restUntil = now + rand(9000, 22000);
      }
    }
    this.assignMeetingSpots();
  }

  // Everybody in the meeting without a place takes the first free chair / standing spot (chairs come first).
  assignMeetingSpots() {
    for (const e of this.emps) {
      if (!e.meet || e.spot) continue;
      const taken = new Set(this.emps.filter((o) => o !== e && o.spot).map((o) => o.spot.key));
      const s = this.meetingSpots.find((x) => !taken.has(x.key));
      if (s && this.goToSpot(e, s)) e.spot = s;
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
    const bar = stage.querySelector(".layout-bar"); // the layout editor's palette under the office
    const barH = bar && !bar.hidden ? bar.offsetHeight + 12 : 0;
    const ch = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - rosterH - barH;
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
    if (this.freeSeats.has(key(x, y))) return true; // the chair of an empty desk
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
    const options = this.spots.filter((s) => !taken.has(s.key) && !(this.meetingOn && s.meet));
    return options.length ? this.pickSpot(e, options) : null;
  }

  update(dt, now) {
    this.tickEvents(now);
    if (this.particles.length) {
      for (const p of this.particles) { p.vy += 260 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.98; p.life -= dt; p.rot += p.vr * dt; }
      this.particles = this.particles.filter((p) => p.life > 0 && p.y < LH + 8);
    }
    this.updateLife(now);
    for (const e of this.emps) {
      if (e.bubble && now > e.bubble.until) e.bubble = null;
      if (this.lifeTick(e, now)) continue;
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
        e.anim = e.status === "working" ? "type" : e.status === "waiting" ? "wave" : e.status === "error" || e.status === "sick" ? "slump" : "sit";
        // idle at the desk: now and then pick up the mug and take a sip
        if (e.anim === "sit") {
          if (e.sipping && now - e.sipping < 2600) e.anim = "sip";
          else if (e.sipping) { e.sipping = 0; e.sipAt = now + rand(12000, 32000); }
          else if (now > (e.sipAt ?? 0)) { e.sipping = now; e.anim = "sip"; }
        } else e.sipping = 0;
        this.deskLife(e, now);
      } else if (e.spot) {
        e.dir = e.spot.dir;
        e.anim = e.spot.anim;
      } else {
        e.anim = "stand";
      }
      this.lifeApply(e, now);
      this.lifeTalk(e, now);
      if (e.meet) continue;
      if (e.status === "idle" && now > e.restUntil) this.decideIdle(e, now);
      if (e.status !== "idle" && e.status !== "sick" && !this.atSeat(e)) this.goTo(e, e.seat.tx, e.seat.ty);
    }
  }

  arrived(e, now) {
    if (this.atSeat(e)) { e.dir = "down"; e.spot = null; }
    if (e.entering && this.atSeat(e)) { e.entering = false; this.burst(e.x + 16, e.y + 8, 60); e.bubble = { kind: "party", until: now + 4000 }; }
    e.restUntil = now + rand(8000, 20000);
    this.arrivedExtra(e, now);
  }

  // Confetti burst at a logical point.
  burst(x, y, n = 40) {
    if (REDUCED_MOTION.matches) return;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4, sp = 90 + Math.random() * 170;
      this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, life: 1.6 + Math.random() * 1.2, col: CONFETTI[i % CONFETTI.length], w: 2 + Math.floor(Math.random() * 3), h: 2 + Math.floor(Math.random() * 3), rot: Math.random() * 6, vr: (Math.random() - 0.5) * 12 });
    }
  }
  celebrate(id) { const e = this.emps.find((x) => x.id === id); if (e) this.burst(e.x + 16, e.y + 8, 60); }

  decideIdle(e, now) {
    if (this.tryNap(e, now)) return;
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
      requestAnimationFrame(loop);
      if (document.hidden) { this.last = now; return; }
      if (REDUCED_MOTION.matches && now - this.last < 200) return;
      this.last = now;
      this.update(dt, now);
      this.draw(now);
    };
    requestAnimationFrame(loop);
  }

  draw(t) {
    const b = this.b;
    const dim = this.editing ? this.editorDim : null; // the piece being dragged stays faded where it was
    drawFloors(b, this.theme, this.rugItems, dim);
    drawWalls(b, this.blocked, this.doors, t, this.theme, this.wallItems, dim);
    const items = [];
    const faded = (id, fn) => (dim && id === dim ? () => { b.save(); b.globalAlpha = 0.3; fn(); b.restore(); } : fn);
    for (const d of this.decor) items.push({ y: d.y, draw: faded(d.id, () => d.draw(b, t)) });
    // every desk is drawn (an empty one too); the colleague at it is the one whose seat points at it
    const sitting = new Map(this.emps.filter((e) => e.seat.desk).map((e) => [e.seat.desk, e]));
    for (const d of this.scene.build.desks) {
      const feet = (d.ty + 1) * TILE;
      const who = sitting.get(d.id) || deskStub(d);
      items.push({ y: feet - 24, draw: faded(d.id, () => drawChair(b, d.tx * TILE, feet)) });
      items.push({ y: feet + TILE + 6, draw: faded(d.id, () => drawDesk(b, who, t)) });
    }
    for (const e of this.emps) {
      if (e.seat.none) { const feet = (e.seat.ty + 1) * TILE; items.push({ y: feet - 24, draw: () => drawChair(b, e.seat.tx * TILE, feet) }); }
      const frame = Math.floor(e.walkDist / 9) % 4;
      const seated = e.anim === "sit" || e.anim === "type" || e.anim === "wave" || e.anim === "slump" || e.anim === "sip" || LIFE_SEATED.includes(e.anim);
      const sitFree = e.anim === "sitfree" || e.anim === "dozefree";
      const lv = this.lifeVis(e, t);
      const oy = e.y - 16 + (seated ? 14 : sitFree ? 6 : 0) + lv.lift;
      items.push({
        y: e.y + TILE + (seated ? -4 : sitFree ? 4 : 1),
        draw: () => {
          const sel = e.id === this.selected, hov = e.id === this.hovered;
          if (sel || hov) drawRing(b, e.x + 16, e.y + TILE - 2, sel);
          if (e.pulse) {
            const p = (performance.now() - e.pulse.t0) / 900;
            if (p >= 1 || REDUCED_MOTION.matches) e.pulse = null;
            else { b.save(); b.globalAlpha = 1 - p; b.strokeStyle = e.pulse.col; b.lineWidth = 2; b.beginPath(); b.ellipse(e.x + 16, e.y + TILE - 1, 12 + p * 14, 4 + p * 6, 0, 0, Math.PI * 2); b.stroke(); b.restore(); }
          }
          drawPerson(b, e.x, oy, e, { dir: e.dir, anim: e.anim, frame, t, seed: e.seed, sipT: e.sipping ? performance.now() - e.sipping : 0, ...deskLifeOpts(e, t), talk: lv.talk, laugh: lv.laugh, lk: lv.lk, lt: lv.lt });
        },
      });
    }
    for (const it of this.eventItems(t)) items.push(it);
    items.sort((a, c) => a.y - c.y);
    for (const it of items) it.draw(b);
    if (this.editing && this.editorDraw) this.editorDraw(b, t);
    const occupied = new Map(this.emps.filter((e) => e.spot && !e.path.length).map((e) => [e.spot.key, e.spot.group || e.spot.key]));
    for (const e of this.emps) { drawOverhead(b, e, t, occupied); drawLifeOverhead(b, e, t); }
    for (const e of this.emps) if (this.isNapping(e)) drawZzz(b, e, t);
    drawDayNight(b, t, this.evt);
    for (const p of this.particles) { b.save(); b.translate(p.x, p.y); b.rotate(p.rot); b.globalAlpha = Math.min(1, p.life); b.fillStyle = p.col; b.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); b.restore(); }
    if (this.offline) { b.fillStyle = "rgba(10,12,20,.55)"; b.fillRect(0, 0, LW, LH); }
    this.ctx.drawImage(this.buf, 0, 0, this.canvas.width, this.canvas.height);
    flushBalloonText(this.ctx, this.canvas.width / LW);
    for (const e of this.emps) {
      const el = this.labelEls.get(e.id);
      if (!el) continue;
      el.style.left = (e.x + 16) * this.scale + "px";
      el.style.top = (e.y + TILE + (this.atSeat(e) ? 30 : 2)) * this.scale + "px";
      el.classList.toggle("selected", e.id === this.selected);
    }
  }
}

// ---------- idle life: personalities, small acts, chats, reactions ----------
// e.act = { kind, anim, hold, t0, until, ... }: `hold` acts take the character over (chat, hop, cheer, clap, pat);
// the others (stretch, yawn, doze, paper) only override the pose while the character stays put.
const LIFE_SEATED = ["stretch", "yawn", "doze", "clapsit"]; // seated poses at the desk
const TRAITS = ["coffee", "nightowl", "social", "perfectionist", "green", "dreamer"];
// spots: spot-weight multipliers; chat / doze: probability multipliers
const TRAIT_LIFE = {
  coffee: { spots: { coffee: 4, brew: 5, fridge: 1.5 }, chat: 1, doze: 0.7 },
  nightowl: { spots: { sofaL: 2, sofaR: 2, window: 1.5 }, chat: 0.9, doze: 2.5 },
  social: { spots: { coffee: 2, fridge: 2, water: 2.5, stoolL: 1.5, stoolR: 1.5 }, chat: 2.5, doze: 0.6 },
  perfectionist: { spots: { printer: 4, books: 3 }, chat: 0.7, doze: 0.3 },
  green: { spots: { plantK: 5, plantM: 5 }, chat: 1.1, doze: 1 },
  dreamer: { spots: { window: 4, window2: 4, books: 2 }, chat: 0.6, doze: 1.4 },
};
const STAND_ANIMS = ["stand", "drink", "think", "read", "brew", "gaze", "water"];

// Deterministic trait from the employee id (FNV-1a), cached on the object.
function traitOf(e) {
  if (!e.trait) {
    let h = 2166136261;
    const s = String(e.id ?? e.name ?? "");
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    e.trait = TRAITS[h % TRAITS.length];
  }
  return e.trait;
}
const lifeStrings = () => (window.PO && window.PO.strings && window.PO.strings.ui && window.PO.strings.ui.life) || {};
function lifePick(arr, fallback = "") { return Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : fallback; }
// how long a balloon stays up: longer sentences need longer to read
const lifeMs = (text) => Math.min(5200, 1600 + String(text || "").length * 55);
const shuffled = (arr) => { const a = Array.isArray(arr) ? arr.filter((x) => typeof x === "string" && x) : []; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const firstName = (e) => String((e && e.name) || "").trim().split(/\s+/)[0] || "";
// {me} / {you} -> first names; tidy up what is left when a name is missing
function fillNames(text, me, you) {
  return String(text).replace(/\{me\}/g, me).replace(/\{you\}/g, you).replace(/\s+/g, " ").replace(/\s+([,.!?;:])/g, "$1").replace(/^[\s,;:]+/, "").trim();
}
// spot key -> key of ui.life.spot
const SPOT_LINE = { coffee: "coffee", fridge: "fridge", stoolL: "stool", stoolR: "stool", sofaL: "sofa", sofaR: "sofa", books: "books", printer: "printer", water: "water", window: "window", window2: "window", brew: "brew", plantK: "plant", plantM: "plant" };
const LAUGH_POSE = ["stand", "chat", "sit", "sitfree", "think", "gaze", "brew"]; // poses whose arms give way to a laughing pose
const LAUGH_AT = 1300; // a laugh after a joke lasts this long (added to the line's time)
function dayPeriod() {
  const h = poHour();
  return h >= 5 && h < 11 ? "morning" : h >= 11 && h < 15 ? "noon" : h >= 15 && h < 21 ? "evening" : "night";
}
function faceDir(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.abs(dx) > 6 ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
}
const lifeNight = () => { const h = new Date().getHours(); return h >= 20 || h < 6; };
function dozeChance(e) {
  const k = TRAIT_LIFE[traitOf(e)].doze;
  return traitOf(e) === "nightowl" ? k * (lifeNight() ? 0.15 : 1) : k * (lifeNight() ? 1.3 : 1);
}

Object.assign(Office.prototype, {
  // weighted pick: the personality decides where somebody likes to hang out
  pickSpot(e, options) {
    const w = TRAIT_LIFE[traitOf(e)].spots;
    const ws = options.map((s) => w[s.wk || s.key] || 1);
    let r = Math.random() * ws.reduce((a, c) => a + c, 0);
    for (let i = 0; i < options.length; i++) { r -= ws[i]; if (r <= 0) return options[i]; }
    return options[options.length - 1];
  },

  say(e, text, ms) { if (text) e.say = { text, until: performance.now() + (ms || lifeMs(text)) }; },

  // Laugh for `ms` with a fade in / out. Poses differ for standing and seated people; `v` forces a variant.
  startLaugh(e, now, ms, o = {}) {
    if (!e) return;
    const pool = e.anim === "sit" ? ["mouth", "tear", "slap"] : e.anim === "sitfree" ? ["mouth", "belly", "slap", "tear"] : ["arms", "belly", "knee", "tear"];
    e.laughing = { t0: now, ms, amp: o.amp == null ? 1 : o.amp, v: o.v || lifePick(pool) };
    if (o.text !== false) this.say(e, lifePick(lifeStrings().laugh), ms); // picked once per laugh, so it never flickers
  },

  endAct(e, now, restore = true) {
    e.errand = null;
    const a = e.act;
    if (!a) return;
    e.act = null;
    if (a.kind === "chat") {
      if (e.laughing) e.laughing = null;
      e.chatCool = now + rand(15000, 30000);
      if (restore && a.path && a.path.length && !e.path.length) e.path = a.path;
      else if (!e.path.length && !e.spot && !this.atSeat(e)) e.restUntil = now + rand(1200, 4500);
      const p = this.emps.find((x) => x.id === a.partner);
      if (p && p.act && p.act.kind === "chat" && p.act.partner === e.id) this.endAct(p, now, restore);
    } else if (a.kind === "pat") {
      const v = this.emps.find((x) => x.id === a.victim);
      if (v && v.status === "error" && a.reply) this.say(v, a.reply.text);
      if (!e.path.length && !e.spot && !this.atSeat(e)) e.restUntil = now + rand(800, 2500);
    }
  },

  // Two idle colleagues who end up near each other stop for a standing chat.
  updateLife(now) {
    if (now - (this.lifeCheck || 0) < 350) return;
    this.lifeCheck = now;
    const ready = this.emps.filter((e) => this.chatReady(e, now));
    for (let i = 0; i < ready.length; i++) {
      for (let j = i + 1; j < ready.length; j++) {
        const a = ready[i], b = ready[j];
        if (a.act || b.act || Math.hypot(a.x - b.x, a.y - b.y) > 64) continue;
        const p = Math.min(0.9, 0.35 * TRAIT_LIFE[traitOf(a)].chat * TRAIT_LIFE[traitOf(b)].chat);
        if (Math.random() < p) this.startChat(a, b, now);
      }
    }
  },

  chatReady(e, now) {
    if (e.status !== "idle" || e.meet || e.entering || e.act || e.errand || e.sipping || (e.chatCool || 0) > now) return false;
    if (e.path.length) return true;
    if (this.atSeat(e)) return false;
    return !e.spot || STAND_ANIMS.includes(e.spot.anim);
  },

  // Picks a conversation from ui.life.convos: not one of the pair's last ~15, nor of the last ones anywhere.
  // Returns the script { ev: [{ at, k: "say" | "laugh", spk, txt, ms }], i, total }, or null without content.
  convoFor(a, b, wantLaugh) {
    const all = lifeStrings().convos;
    if (!Array.isArray(all) || !all.length) return null;
    const has = (c, re) => c.some((x) => typeof x === "string" && re.test(x.trim()));
    const ok = (c) => Array.isArray(c) && has(c, /./) && (!wantLaugh || has(c, /^~/));
    const pk = [a.id, b.id].sort().join("|");
    const pair = this.convoPair || (this.convoPair = new Map());
    const rec = pair.get(pk) || [], glob = this.convoGlobal || (this.convoGlobal = []);
    const n = all.length, kp = Math.min(15, n - 1), kg = Math.min(30, n >> 1);
    const pr = kp > 0 ? rec.slice(-kp) : [], gl = kg > 0 ? glob.slice(-kg) : [];
    let pick = -1;
    for (const strict of [true, false]) {
      for (let i = 0; i < 80 && pick < 0; i++) {
        const j = Math.floor(Math.random() * n);
        if (ok(all[j]) && !pr.includes(j) && (!strict || !gl.includes(j))) pick = j;
      }
      if (pick >= 0) break;
    }
    if (pick < 0) pick = all.findIndex(ok);
    if (pick < 0) return null;
    rec.push(pick); if (rec.length > 40) rec.shift(); pair.set(pk, rec);
    glob.push(pick); if (glob.length > 60) glob.shift();
    const names = [firstName(a), firstName(b)];
    const ev = []; let at = 300;
    all[pick].forEach((raw, i) => {
      if (typeof raw !== "string" || !raw.trim()) return;
      const laugh = raw.trim().startsWith("~"), spk = i % 2;
      const txt = fillNames(raw.trim().replace(/^~\s*/, ""), names[spk], names[1 - spk]);
      if (!txt) return;
      const speech = 1800 + txt.length * 55;
      ev.push({ at, k: "say", spk, txt, ms: speech - 100 });
      if (laugh) ev.push({ at: at + speech, k: "laugh", spk });
      at += speech + (laugh ? LAUGH_AT : 0) + 150;
    });
    return ev.length ? { ev, i: 0, total: at + 300 } : null;
  },

  startChat(a, b, now, opts = {}) {
    let c = this.convoFor(a, b, opts.laugh);
    if (!c) c = { ev: [0, 1, 0, 1].map((spk, i) => ({ at: 300 + i * 2000, k: "say", spk, txt: "...", ms: 1800 })), i: 0, total: 8600 }; // no content: dots
    for (const [x, y, lead] of [[a, b, true], [b, a, false]]) {
      x.act = { kind: "chat", anim: "chat", hold: true, t0: now, until: now + c.total, partner: y.id, path: x.path, lead, convo: c };
      x.path = [];
      x.dir = faceDir(x, y);
    }
  },

  // One step of a conversation script (run by the leader): a line in the speaker's balloon, or the laugh after a joke.
  convoStep(a, b, ev, c, now) {
    const sp = ev.spk === 0 ? a : b, li = ev.spk === 0 ? b : a;
    if (ev.k === "say") {
      this.say(sp, ev.txt, ev.ms);
      li.say = null;
      c.speaker = sp.id; c.speakUntil = now + ev.ms;
      return;
    }
    c.speaker = null;
    this.startLaugh(li, now, LAUGH_AT, { amp: 1 });
    const r = Math.random(); // the joker laughs along, or only a little, or keeps a straight face
    if (r < 0.55) this.startLaugh(sp, now, LAUGH_AT, { amp: 0.9, text: Math.random() < 0.4 });
    else if (r < 0.85) this.startLaugh(sp, now, LAUGH_AT, { amp: 0.4, text: false });
  },

  // Runs before movement. Returns true when an act fully controls the character this frame.
  lifeTick(e, now) {
    if (e.laughing && now > e.laughing.t0 + e.laughing.ms) e.laughing = null;
    if (e.errand) {
      const er = e.errand, v = this.emps.find((x) => x.id === er.victim);
      if (!v || v.status !== "error" || e.status !== "idle" || now > er.until || e.act) { e.errand = null; e.restUntil = now + rand(800, 2500); }
      else if (!e.path.length) {
        e.errand = null;
        if (e.tx === er.tx && e.ty === er.ty) {
          const pr = lifePick(lifeStrings().comfortPairs, null), c1 = pr && typeof pr[0] === "string" ? pr[0] : "", c2 = pr && typeof pr[1] === "string" ? pr[1] : "";
          const m1 = c1 ? lifeMs(c1) : 0, m2 = c2 ? lifeMs(c2) : 0;
          e.act = { kind: "pat", anim: "pat", hold: true, t0: now, until: now + Math.max(3000, m1 + m2 + 600), victim: v.id, dir: faceDir(e, v), reply: c2 ? { at: now + m1 + 150, text: c2 } : null };
          this.say(e, c1, m1);
        } else e.restUntil = now + rand(800, 2500);
      }
    }
    const a = e.act;
    if (!a) return false;
    if (!a.hold) {
      if (e.path.length || now > a.until) this.endAct(e, now);
      return false;
    }
    if (now < a.t0) return false;
    if (now > a.until) { this.endAct(e, now); return false; }
    if (a.kind === "chat") {
      const p = this.emps.find((x) => x.id === a.partner);
      if (!p || !p.act || p.act.kind !== "chat" || p.status !== "idle") { this.endAct(e, now); return false; }
      e.dir = faceDir(e, p);
      const c = a.convo;
      if (a.lead && c) while (c.i < c.ev.length && now - a.t0 >= c.ev[c.i].at) this.convoStep(e, p, c.ev[c.i++], c, now);
    } else if (a.dir) e.dir = a.dir;
    if (a.kind === "pat" && a.reply && now >= a.reply.at) {
      const v = this.emps.find((x) => x.id === a.victim);
      if (v && v.status === "error") this.say(v, a.reply.text);
      a.reply = null;
    }
    e.anim = a.anim;
    return true;
  },

  // Runs after the normal pose was chosen: ambient acts at the desk / sofa / printer.
  lifeApply(e, now) {
    if (e.status !== "idle" || e.meet) { if (e.act && !e.act.hold) this.endAct(e, now); return; }
    let a = e.act;
    if (a && !a.hold) {
      if (e.sipping || a.spot !== (e.spot || null) || now > a.until) { this.endAct(e, now); a = null; }
      else { if (a.dir) e.dir = a.dir; e.anim = a.anim === "doze" && e.anim === "sitfree" ? "dozefree" : a.anim; return; }
    }
    if (a || e.errand) return;
    const trait = traitOf(e);
    if (trait === "coffee" && e.anim === "sit" && e.sipAt - now > 18000) e.sipAt = now + rand(5000, 15000);
    // printer: pick up the page and read it
    if (e.spot && e.spot.wk === "printer" && e.lifeSpot !== e.spot) {
      e.lifeSpot = e.spot;
      if (Math.random() < (trait === "perfectionist" ? 1 : 0.7)) { e.act = { kind: "paper", anim: "paper", dir: "down", t0: now, until: now + rand(5000, 8500), spot: e.spot }; return; }
    }
    if (e.spot === null || e.spot === undefined) e.lifeSpot = null;
    if (e.lifeAt == null) e.lifeAt = now + rand(6000, 18000);
    if (now < e.lifeAt || e.sipping) return;
    e.lifeAt = now + rand(9000, 24000);
    let kind = null;
    if (e.anim === "sit") {
      const opts = [["stretch", 3], ["yawn", 3], ["doze", 2 * dozeChance(e)]];
      let r = Math.random() * opts.reduce((s, o) => s + o[1], 0);
      for (const [k, w] of opts) { r -= w; if (r <= 0) { kind = k; break; } }
    } else if (e.anim === "sitfree" && Math.random() < 0.6 * dozeChance(e)) kind = "doze";
    if (!kind) return;
    const dur = kind === "doze" ? rand(7000, 12000) : kind === "yawn" ? 1900 : 2300;
    e.act = { kind, anim: kind === "doze" && e.anim === "sitfree" ? "dozefree" : kind, t0: now, until: now + dur, spot: e.spot || null };
    e.anim = e.act.anim;
  },

  // Small talk to oneself: delayed lines (applause, events), a mutter on reaching a spot, the odd greeting for the time of day.
  lifeTalk(e, now) {
    if (e.status !== "idle" || e.meet || e.entering) return;
    const S = lifeStrings();
    if (e.sayLater && now >= e.sayLater.at) { const s = e.sayLater; e.sayLater = null; if (!e.say) this.say(e, s.text); }
    if (e.say || e.act || e.errand || e.path.length || e.sipping) return;
    const sp = e.spot;
    if (!sp) e.spotTalk = null;
    else if (!sp.evt && e.napSpot !== sp) {
      // at most two tries per stay, ~35% each
      if (!e.spotTalk || e.spotTalk.spot !== sp) e.spotTalk = { spot: sp, n: 0, at: now + rand(1500, 4500) };
      const st = e.spotTalk;
      if (st.n < 2 && now >= st.at) {
        st.n++; st.at = now + rand(6000, 14000);
        if (Math.random() < 0.35) this.say(e, lifePick((S.spot || {})[SPOT_LINE[sp.wk || sp.key]]));
      }
      return;
    }
    if (e.timeAt == null) e.timeAt = now + rand(40000, 120000);
    if (now >= e.timeAt) {
      e.timeAt = now + rand(120000, 300000);
      if (Math.random() < 0.6) this.say(e, lifePick((S.time || {})[dayPeriod()]));
    }
  },

  // A line about the office event: each person draws a different one from a shuffled deck.
  eventLine(kind) {
    const ev = this.evt;
    if (!ev) return "";
    const deck = ev.deck || (ev.deck = {});
    if (!deck[kind] || !deck[kind].length) deck[kind] = shuffled(((lifeStrings().event || {})[kind]));
    return deck[kind].pop() || "";
  },

  // per-frame visual modifiers for drawing: hop offset, who is talking, laugh intensity (0 = none .. 1), its variant and age
  lifeVis(e, t) {
    const a = e.act, v = { lift: 0, talk: false, laugh: 0, lk: "", lt: 0 };
    const L = e.laughing;
    if (L && t >= L.t0 && e.anim !== "walk") {
      const p = (t - L.t0) / L.ms;
      if (p < 1) {
        const env = REDUCED_MOTION.matches ? 1 : p < 0.15 ? p / 0.15 : p > 0.7 ? (1 - p) / 0.3 : 1; // builds up, holds, dies down
        v.laugh = env * L.amp < 0.05 ? 0 : env * L.amp;
        v.lk = L.v; v.lt = t - L.t0;
        if (v.laugh > 0.5 && L.v === "arms" && !REDUCED_MOTION.matches) v.lift = -(Math.floor(t / 110) % 2);
      }
    }
    if (!a || t < a.t0) return v;
    if (a.kind === "chat") {
      const c = a.convo;
      v.talk = !!c && c.speaker === e.id && t < c.speakUntil && !v.laugh;
    } else if (!REDUCED_MOTION.matches) {
      const el = t - a.t0;
      if (a.kind === "hop" && a.anim === "hop") v.lift = -Math.round(Math.abs(Math.sin(el / 130)) * 7);
      else if (a.kind === "cheer") v.lift = -Math.round(Math.abs(Math.sin(el / 160)) * 6);
    }
    return v;
  },

  // Somebody clicked a character: a hop / wave and a short line in the personality's voice.
  react(id) {
    const e = this.emps.find((x) => x.id === id);
    if (!e) return;
    const now = performance.now();
    const S = lifeStrings();
    this.say(e, lifePick((S.lines || {})[traitOf(e)], lifePick(S.click)));
    if (e.status !== "idle" || e.meet || e.path.length || e.act || e.errand) return;
    const seat = this.atSeat(e);
    if (seat) { e.sipping = 0; e.act = { kind: "hop", anim: "wave", hold: true, t0: now, until: now + 1500, dir: "down" }; }
    else if (!e.spot || e.spot.anim !== "sitfree") e.act = { kind: "hop", anim: "hop", hold: true, t0: now, until: now + 1500, dir: "down" };
  },

  // Job finished: victory pose at the desk, nearby idle colleagues applaud.
  celebrateDone(e, now) {
    if (e.path.length || !this.atSeat(e) || e.act) return;
    e.act = { kind: "cheer", anim: "cheer", hold: true, t0: now, until: now + 2400, dir: "down" };
    e.restUntil = Math.max(e.restUntil, now + 3000);
    this.burst(e.x + 16, e.y - 4, 14);
    this.say(e, lifePick(lifeStrings().done));
    const claps = shuffled(lifeStrings().applause);
    for (const o of this.emps) {
      if (o === e || o.status !== "idle" || o.meet || o.act || o.errand || o.path.length || o.sipping) continue;
      if (Math.hypot(o.x - e.x, o.y - e.y) > 230) continue;
      const seat = this.atSeat(o);
      if (!seat && o.spot && o.spot.anim === "sitfree") continue;
      const start = now + rand(200, 800), until = start + 2000 + rand(0, 600);
      o.act = { kind: "clap", anim: seat ? "clapsit" : "clap", hold: true, t0: start, until, dir: seat ? "down" : faceDir(o, e) };
      o.restUntil = Math.max(o.restUntil, until + 500);
      if (claps.length && Math.random() < 0.6) o.sayLater = { at: start + rand(300, 900), text: claps.pop() };
    }
  },

  // A task failed: the nearest idle colleague walks over and puts a hand on the shoulder.
  comfort(e, now) {
    let best = null, bd = 1e9;
    for (const o of this.emps) {
      if (o === e || o.status !== "idle" || o.meet || o.entering || o.act || o.errand || o.path.length || o.sipping) continue;
      const d = Math.hypot(o.x - e.x, o.y - e.y);
      if (d < bd) { best = o; bd = d; }
    }
    if (!best) return;
    for (const dx of [1, -1]) {
      const tx = e.seat.tx + dx, ty = e.seat.ty;
      if (this.isBlocked(tx, ty, best)) continue;
      const spot = best.spot;
      if (this.goTo(best, tx, ty)) { best.spot = null; best.errand = { victim: e.id, tx, ty, until: now + 30000 }; return; }
      best.spot = spot;
    }
  },
});

// Small pixel "Z" for the snoring overlay.
function pixelZ(b, x, y, s) {
  b.fillRect(x, y, s, 1); b.fillRect(x, y + s - 1, s, 1);
  for (let i = 1; i < s - 1; i++) b.fillRect(x + s - 1 - i, y + i, 1, 1);
}
function lifeBubble(b, cx, top, w, h, fill = "#fff") {
  b.fillStyle = OUTLINE; b.fillRect(cx - w / 2 - 1, top - h - 1, w + 2, h + 2); b.fillRect(cx - 3, top, 6, 3);
  b.fillStyle = fill; b.fillRect(cx - w / 2, top - h, w, h); b.fillRect(cx - 2, top, 4, 2);
}
// Word-wraps a balloon text to at most two lines of ~24 characters (the rest becomes an ellipsis).
function wrapBalloon(text, max = 24) {
  const out = [];
  let cur = "";
  for (let w of String(text).split(/\s+/).filter(Boolean)) {
    while (w.length > max) { if (cur) { out.push(cur); cur = ""; } out.push(w.slice(0, max)); w = w.slice(max); }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= max) cur += " " + w;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  if (out.length > 2) { out.length = 2; out[1] = out[1].slice(0, max - 1).replace(/[\s,.;:!?]+$/, "") + "…"; }
  return out;
}
const BALLOON_FONT = (px) => `bold ${px}px "IBM Plex Mono", ui-monospace, monospace`;
// Balloon text is queued while the scene is drawn on the logical canvas and painted after it is scaled up,
// at the real screen resolution: the boxes stay crisp pixel art and the letters stay sharp.
const balloonTexts = [];
function flushBalloonText(ctx, k) {
  if (!balloonTexts.length) return;
  ctx.save();
  ctx.font = BALLOON_FONT(8 * k); ctx.textBaseline = "middle"; ctx.textAlign = "center"; ctx.fillStyle = "#2b2b2b";
  for (const q of balloonTexts) ctx.fillText(q.text, q.x * k, q.y * k, q.w * k);
  ctx.restore();
  balloonTexts.length = 0;
}
// layouts are cached per text: measuring the text is not something to do every frame
const balloonCache = new Map();
function balloonLayout(b, text) {
  let c = balloonCache.get(text);
  if (c) return c;
  b.font = BALLOON_FONT(8); // widths scale linearly, so one measurement at 8px serves every zoom level
  const lines = wrapBalloon(text);
  const w = Math.min(124, Math.ceil(Math.max(0, ...lines.map((l) => b.measureText(l).width))) + 8);
  c = { lines, w, h: 4 + 9 * lines.length };
  if (balloonCache.size > 400) balloonCache.clear();
  balloonCache.set(text, c);
  return c;
}
// Speech balloon above a head: 1 or 2 lines; `top` is where the tail touches, the balloon grows upwards.
function lifeBalloon(b, cx, top, text) {
  const { lines, w, h } = balloonLayout(b, text);
  if (!lines.length) return;
  top = Math.max(top, h + 2); // never above the canvas
  b.save();
  const x = Math.max(w / 2 + 1, Math.min(LW - w / 2 - 1, cx));
  const tail = Math.max(x - w / 2 + 4, Math.min(x + w / 2 - 4, cx));
  b.fillStyle = OUTLINE; b.fillRect(x - w / 2 - 1, top - h - 1, w + 2, h + 2); b.fillRect(tail - 3, top, 6, 3);
  b.fillStyle = "#fff"; b.fillRect(x - w / 2, top - h, w, h); b.fillRect(tail - 2, top, 4, 2);
  lines.forEach((ln, i) => balloonTexts.push({ text: ln, x, y: top - h + 7 + i * 9, w: w - 6 }));
  b.restore();
}

// Overlays for the idle-life acts: Zzz, brewing / gazing icons, chat balloons, click lines, applause sparks.
function drawLifeOverhead(b, e, t) {
  const cx = e.x + 16;
  let top = e.y - 22;
  if (e.unread > 0) top -= 26;
  const bob = Math.floor(t / 300) % 2 ? -1 : 0;
  const a = e.act;
  const busy = e.status !== "idle" || e.bubble || e.unread > 0 || e.meet;
  if (a && t >= a.t0) {
    if (a.kind === "doze") {
      const by = top + (a.anim === "dozefree" ? 12 : 10);
      b.save();
      for (let i = 0; i < 3; i++) {
        const p = REDUCED_MOTION.matches ? i / 3 : ((t / 1100 + i / 3) % 1);
        b.globalAlpha = 1 - p * 0.7; b.fillStyle = OUTLINE; pixelZ(b, cx + 7 + p * 8 + i, by - p * 16 - 1, 5 + (i > 1 ? 1 : 0));
        b.fillStyle = "#e8f1ff"; pixelZ(b, cx + 8 + p * 8 + i, by - p * 16, 4 + (i > 1 ? 1 : 0));
      }
      b.restore();
    } else if (a.kind === "clap") {
      if (Math.floor(t / 150) % 2) {
        const y = e.y + (a.anim === "clapsit" ? 6 : -6);
        b.fillStyle = "#ffd166"; b.fillRect(cx - 10, y, 2, 2); b.fillRect(cx + 9, y + 3, 2, 2); b.fillRect(cx - 12, y + 6, 1, 1);
      }
    }
  } else if (!e.act && !busy && e.spot && !e.path.length) {
    if (e.anim === "brew") {
      lifeBubble(b, cx, top, 20, 16);
      b.fillStyle = "#7b4a2a"; b.fillRect(cx - 5, top - 9, 8, 7); b.fillRect(cx + 3, top - 8, 2, 4);
      b.fillStyle = "#c9a074"; b.fillRect(cx - 4, top - 9, 6, 1);
      b.fillStyle = "#9aa"; const w = Math.floor(t / 400) % 2; b.fillRect(cx - 3 + w, top - 13, 1, 3); b.fillRect(cx + w, top - 14, 1, 3);
    } else if (e.anim === "gaze" && Math.floor(t / 1200) % 3 !== 0) {
      lifeBubble(b, cx, top, 20, 14, "#cfe8fa");
      b.fillStyle = "#fff"; b.fillRect(cx - 6, top - 6, 12, 4); b.fillRect(cx - 4, top - 9, 6, 3); b.fillRect(cx, top - 8, 5, 3);
    }
  }
  if (e.say) {
    if (t > e.say.until) e.say = null;
    else lifeBalloon(b, cx, top - (busy ? 20 : 0), e.say.text);
  }
}

// ---------- floors & walls ----------
// A rug in the look of a theme with its top-left tile at (tx, ty). (The artwork was drawn for the lounge: tile 0, 11.)
function drawRug(b, look, tx, ty) {
  const T = THEMES[look] || THEMES.default;
  b.save(); b.translate(tx * TILE, (ty - 11) * TILE);
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
  } else if (T.rug === "moon") {
    drawMoonRug(b, 8, 11 * TILE + 8);
  } else if (T.rug === "round") {
    b.fillStyle = "#e9c4d3"; b.fillRect(30, 11 * TILE + 30, 100, 100); b.fillRect(20, 11 * TILE + 46, 120, 68); b.fillRect(46, 11 * TILE + 20, 68, 120);
    b.fillStyle = "#f4dbe5"; b.fillRect(40, 11 * TILE + 40, 80, 80); b.fillRect(32, 11 * TILE + 52, 96, 56); b.fillRect(52, 11 * TILE + 32, 56, 96);
    b.fillStyle = "#e9c4d3"; b.fillRect(70, 11 * TILE + 70, 20, 20);
  }
  b.restore();
}

function drawFloors(b, theme = "default", rugs = [POLayout.defaultRug()], dim = null) {
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
    else if (floor === "clouds") drawClouds(b, x, y, w, h);
    else if (floor === "dreamwood") drawDreamWood(b, x, y, w, h);
    else if (floor === "starCarpet") drawStarCarpet(b, x, y, w, h);
    else if (floor === "nightTiles") drawNightTiles(b, x, y, w, h);
    else drawConcrete(b, x, y, w, h);
  }
  // door thresholds
  b.fillStyle = "#c9a273";
  for (const [x, y] of [[7, 5], [7, 6], [22, 5], [22, 6], [7, 12], [7, 13], [22, 12], [22, 13], [3, 9], [4, 9], [25, 9], [26, 9]]) b.fillRect(x * TILE, y * TILE, TILE, TILE);
  // the rugs (movable pieces; the classic one lies in the lounge)
  for (const r of rugs) {
    if (dim && r.id === dim) { b.save(); b.globalAlpha = 0.3; drawRug(b, r.skin || theme, r.tx, r.ty); b.restore(); } else drawRug(b, r.skin || theme, r.tx, r.ty);
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

// Current hour of the day (0..24). `?hour=23` in the URL pins it, to look at the night without waiting for it.
function poHour() {
  if (window.__poHour >= 0 && window.__poHour < 24) return window.__poHour; // set by the ?debug panel
  try { const o = parseFloat(new URLSearchParams(location.search).get("hour")); if (o >= 0 && o < 24) return o; } catch {}
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}

// Sky behind the windows: night, dawn, morning, noon, afternoon, dusk. `sun` (0..1 across the pane) is set from 6 to 20.
function skyColors() {
  const h = poHour();
  const sun = h >= 6 && h <= 20 ? (h - 6) / 14 : null;
  if (h < 5.5 || h >= 20.5) return { top: "#0c1330", bot: "#1f3260", stars: true, sun: null };
  if (h < 7.5) return { top: "#5a4a8a", bot: "#f2a35e", stars: false, sun };
  if (h < 10) return { top: "#6ab4ec", bot: "#f6dcb0", stars: false, sun };
  if (h < 16) return { top: "#4aa3ea", bot: "#c4e6f8", stars: false, sun };
  if (h < 18) return { top: "#5fb0ea", bot: "#f8e2b4", stars: false, sun };
  return { top: "#3d4a8a", bot: "#f0834d", stars: false, sun };
}

// How dark the office is, 0 (daylight) .. 0.32 (deep night); ramps over dawn and dusk.
function nightDarkness() {
  const h = poHour();
  if (h >= 21 || h < 5) return 0.32;
  if (h < 7) return 0.32 * (7 - h) / 2;
  if (h >= 19) return 0.32 * (h - 19) / 2;
  return 0;
}
const isNight = () => nightDarkness() >= 0.25;

function drawWalls(b, blocked, doors, t, theme = "default", wall = POLayout.defaultWall(theme), dim = null) {
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
      if (sky.sun != null) {
        const sx = wx + 6 + sky.sun * 80, sy = 38 - Math.sin(sky.sun * Math.PI) * 26, low = Math.sin(sky.sun * Math.PI) < 0.35;
        b.fillStyle = low ? "#ffb35a" : "#ffe27a"; b.fillRect(sx - 4, sy - 4, 8, 8); b.fillRect(sx - 6, sy - 2, 12, 4); b.fillRect(sx - 2, sy - 6, 4, 12);
      }
      b.restore();
      b.fillStyle = "#3f7f3f"; b.fillRect(wx, 42, 96, 6); b.fillStyle = "#5aa05a"; for (let i = 0; i < 12; i++) b.fillRect(wx + i * 8, 40 + (i % 2), 6, 3);
    }
    b.fillStyle = "#eef2f4"; b.fillRect(wx + 47, 8, 2, 40); b.fillRect(wx, 27, 96, 2);
    b.fillStyle = "rgba(240,240,236,.55)"; for (let i = 0; i < 4; i++) b.fillRect(wx, 9 + i * 4, 96, 2);
  }
  // ambient decor spanning the wall goes under the pieces ("under") or over them ("over"); the piece being dragged in the editor stays faded
  const layer = (over) => { for (const it of wall) { const w = POLayout.TYPES[it.type].wall; if (w.ambient && (w.layer === "over") === over && WALL_ART[it.type]) WALL_ART[it.type](b, t, 0); } };
  layer(false);
  for (const it of wall) {
    const art = WALL_ART[it.type];
    if (!art || POLayout.TYPES[it.type].wall.ambient) continue;
    if (dim && it.id === dim) { b.save(); b.globalAlpha = 0.3; art(b, t, it.tx * TILE); b.restore(); } else art(b, t, it.tx * TILE);
  }
  layer(true);

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


// ---------- wall decor ----------
// The movable wall decor: WALL_ART["<theme>_<piece>"](b, t, x0) draws a piece with the left edge of its first tile at x0 (sizes and default
// tiles: POLayout.WALL). The artwork is each theme's original wall decor; wallAt(tile, fn, nudge) runs code written for a fixed spot at any
// tile (nudge: a pixel or two, for a piece that overhung its tiles). Ambient decor that spans the wall (string lights, stained glass ...)
// is a piece too (width 0 in POLayout.WALL): it takes no tiles and is drawn with x0 = 0, under or over the other pieces.
const WALL_ART = {};
const wallAt = (tile, fn, nudge = 0) => (b, t, x0) => { b.save(); b.translate(x0 - tile * TILE + nudge, 0); fn(b, t); b.restore(); };
const wallClock = (b, t, x0) => drawClock(b, x0 + 16, 28);
WALL_ART.default_cabinets = wallAt(0, (b) => {
  for (let i = 0; i < 4; i++) {
    const cx = 8 + i * 40;
    b.fillStyle = "#e9e4d8"; b.fillRect(cx, 8, 36, 34);
    b.fillStyle = "#cdc6b6"; b.fillRect(cx, 8, 36, 2); b.fillRect(cx, 40, 36, 2); b.fillRect(cx + 17, 8, 2, 34);
    b.fillStyle = "#5c5c5c"; b.fillRect(cx + 12, 24, 3, 6); b.fillRect(cx + 21, 24, 3, 6);
  }
});
WALL_ART.default_poster = wallAt(13, (b) => {
  b.fillStyle = "#2b2b2b"; b.fillRect(13 * TILE + 4, 10, 30, 38);
  b.fillStyle = "#ffd166"; b.fillRect(13 * TILE + 7, 13, 24, 32);
  b.fillStyle = "#2b2b2b"; b.fillRect(13 * TILE + 12, 20, 14, 12); b.fillRect(13 * TILE + 10, 36, 18, 2); b.fillRect(13 * TILE + 13, 40, 12, 2);
  b.fillStyle = "#ffd166"; b.fillRect(13 * TILE + 16, 24, 6, 4);
}, -3);
WALL_ART.default_clock = wallClock;
WALL_ART.default_shelf = wallAt(20, (b) => {
  const shx = 20 * TILE + 12;
  b.fillStyle = "#5c3d22"; b.fillRect(shx - 2, 36, 50, 5);
  b.fillStyle = "#8a5a32"; b.fillRect(shx - 2, 36, 50, 1);
  ["#d9534f", "#3f7cc9", "#ffd166", "#3a9d5d", "#c678dd", "#e07b39"].forEach((c, i) => { b.fillStyle = c; b.fillRect(shx + 2 + i * 7, 14 + (i % 2) * 3, 5, 22 - (i % 2) * 3); b.fillStyle = "rgba(0,0,0,.25)"; b.fillRect(shx + 2 + i * 7, 14 + (i % 2) * 3, 1, 22 - (i % 2) * 3); });
});
WALL_ART.default_tv = wallAt(24, (b, t) => {
  const tx = 24 * TILE + 8;
  b.fillStyle = "#1c1e24"; b.fillRect(tx, 8, 112, 42);
  b.fillStyle = "#0f2a3a"; b.fillRect(tx + 4, 12, 104, 34);
  const bars = [10, 16, 12, 22, 18, 26, 20];
  bars.forEach((h, i) => { b.fillStyle = i === 5 ? "#ffd166" : "#4fc3f7"; b.fillRect(tx + 10 + i * 14, 44 - h, 9, h); });
  b.fillStyle = "#fff"; b.fillRect(tx + 8, 16, 30, 2); b.fillRect(tx + 8, 20, 18, 2);
  b.fillStyle = Math.floor(t / 900) % 2 ? "#4ade80" : "#1c1e24"; b.fillRect(tx + 106, 46, 3, 2);
});
WALL_ART.default_whiteboard = wallAt(28, (b) => {
  b.fillStyle = "#c9ced3"; b.fillRect(28 * TILE + 4, 10, 52, 36);
  b.fillStyle = "#fbfbf8"; b.fillRect(28 * TILE + 7, 13, 46, 30);
  b.fillStyle = "#3f7cc9"; b.fillRect(28 * TILE + 11, 18, 30, 2); b.fillRect(28 * TILE + 11, 24, 22, 2);
  b.fillStyle = "#d9534f"; b.fillRect(28 * TILE + 11, 31, 14, 6); b.fillStyle = "#3a9d5d"; b.fillRect(28 * TILE + 30, 30, 18, 8);
});

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

// ---------- working animations & desk micro moves ----------
const MICRO_KINDS = ["stretch", "clock", "phone", "giggle"];
const MICRO_MS = { stretch: 2400, clock: 1900, phone: 3800, giggle: 4200 };
const DEEP_FOCUS_MS = 60000;   // this long on the job: headphones + energy drink
const TOOL_FRESH_MS = 25000;   // a tool call shapes the pose this long, then back to plain typing

// Tool kind that shapes the pose right now (null = plain typing).
function workKind(e, t) {
  if (e.status !== "working" || !e.tool || !TOOL_ICONS[e.tool.kind] || e.tool.kind === "other") return null;
  return t - e.tool.t0 < TOOL_FRESH_MS ? e.tool.kind : null;
}
function isDeepFocus(e) { return e.status === "working" && !!e.workSince && performance.now() - e.workSince > DEEP_FOCUS_MS; }
// Extra options for drawPerson: what to act out while sitting at the desk.
function deskLifeOpts(e, t) {
  if (e.anim === "type") return { tool: workKind(e, t), deep: isDeepFocus(e) };
  if (e.anim === "sit" && e.micro) return { micro: e.micro.kind, microT: performance.now() - e.micro.t0 };
  return null;
}
// Head offset on top of the idle bob: nods while writing pauses, tilts back to stretch, looks down at watch/phone.
function headNod(o) {
  if (REDUCED_MOTION.matches) return 0;
  if (o.micro === "stretch") return -1;
  if (o.micro === "clock" || o.micro === "phone" || o.micro === "giggle") return 1;
  if (o.anim === "chat" && !o.talk && !o.laugh) { const ph = (o.t + (o.seed || 0)) % 2600; if (ph < 320) return 1; } // listener nods
  if (o.tool === "write" && o.anim === "type") { const ph = o.t % 3200; if (ph > 2300 && ph < 3000) return Math.floor(o.t / 200) % 2; }
  return 0;
}

// Monitor content per tool kind (26x18 screen at sx,sy); false = not handled, caller draws the default.
function drawWorkScreen(b, e, t, sx, sy) {
  const kind = workKind(e, t);
  if (!kind) return false;
  const tt = REDUCED_MOTION.matches ? 0 : t;
  const hash = (n) => ((n * 2654435761) >>> 0) % 1000;
  switch (kind) {
    case "bash": {
      b.fillStyle = "#06110c"; b.fillRect(sx, sy, 26, 18);
      const s = Math.floor(tt / 110);
      for (let r = 0; r < 8; r++) { // green lines streaming up the screen
        const h = hash(r + s + 7);
        b.fillStyle = r === 7 ? "#b8ffd8" : h % 3 ? "#3fd985" : "#22a862";
        b.fillRect(sx + 2 + (h % 3), sy + 1 + r * 2, 3 + (h % 17), 1);
      }
      b.fillStyle = "#b8ffd8"; b.fillRect(sx + 2, sy + 16, 2, 1);
      if (Math.floor(tt / 300) % 2) b.fillRect(sx + 6, sy + 15, 2, 2);
      b.fillStyle = "rgba(92,242,165,.16)"; b.fillRect(sx - 8, sy + 16, 42, 12);
      break;
    }
    case "read": {
      b.fillStyle = "#e8edf4"; b.fillRect(sx, sy, 26, 18);
      b.fillStyle = "#61afef"; b.fillRect(sx + 3, sy + 2, 12, 2);
      const s = Math.floor(tt / 500);
      for (let r = 0; r < 6; r++) { const h = hash(r + s); b.fillStyle = "#8a93a3"; b.fillRect(sx + 3, sy + 6 + r * 2, 12 + (h % 9), 1); }
      b.fillStyle = "#c9d3e0"; b.fillRect(sx + 20, sy + 2, 4, 5);
      b.fillStyle = "rgba(232,237,244,.2)"; b.fillRect(sx - 8, sy + 16, 42, 12);
      break;
    }
    case "write": {
      b.fillStyle = "#1e2230"; b.fillRect(sx, sy, 26, 18);
      b.fillStyle = "#2c3245"; b.fillRect(sx, sy, 4, 18);
      const n = 3 + (Math.floor(tt / 700) % 5);
      const cols = ["#e5a02d", "#98c379", "#61afef", "#c678dd"];
      for (let r = 0; r < n; r++) {
        b.fillStyle = "#59617a"; b.fillRect(sx + 1, sy + 2 + r * 3, 2, 1);
        const h = hash(r + 3);
        b.fillStyle = cols[h % 4]; b.fillRect(sx + 6, sy + 2 + r * 3, 3 + (h % 5), 1);
        b.fillStyle = "#d5d9e4"; b.fillRect(sx + 10 + (h % 5), sy + 2 + r * 3, 3 + ((h >> 3) % 8), 1);
      }
      if (Math.floor(tt / 250) % 2) { b.fillStyle = "#fff"; b.fillRect(sx + 6 + (Math.floor(tt / 120) % 12), sy + 2 + (n - 1) * 3, 1, 2); }
      break;
    }
    case "search": {
      b.fillStyle = "#17142a"; b.fillRect(sx, sy, 26, 18);
      b.fillStyle = "#f2f2f8"; b.fillRect(sx + 2, sy + 2, 22, 3);
      b.fillStyle = "#c678dd"; b.fillRect(sx + 3, sy + 3, 2 + (Math.floor(tt / 200) % 8), 1);
      const hot = Math.floor(tt / 650) % 3;
      for (let r = 0; r < 3; r++) {
        if (r === hot) { b.fillStyle = "rgba(198,120,221,.3)"; b.fillRect(sx + 1, sy + 6 + r * 4, 24, 4); }
        b.fillStyle = "#7aa7ff"; b.fillRect(sx + 3, sy + 7 + r * 4, 10, 1);
        b.fillStyle = "#6a6f86"; b.fillRect(sx + 3, sy + 9 + r * 4, 16, 1);
      }
      break;
    }
    case "web": {
      b.fillStyle = "#0c1e2c"; b.fillRect(sx, sy, 26, 18);
      const cx = sx + 13, cy = sy + 9, ph = tt / 700;
      for (let dy = -6; dy <= 6; dy++) {
        const w = Math.floor(Math.sqrt(36 - dy * dy));
        b.fillStyle = "#2a7fb8"; b.fillRect(cx - w, cy + dy, w * 2 + 1, 1);
        for (let k = 0; k < 6; k++) { // meridians turning around the globe
          const a = ph + (k * Math.PI) / 3;
          if (Math.cos(a) < 0) continue;
          b.fillStyle = k % 3 === 0 ? "#5fbf6a" : "#8fd3f4";
          b.fillRect(cx + Math.round(w * Math.sin(a)), cy + dy, 1, 1);
        }
      }
      b.fillStyle = "#8fd3f4"; b.fillRect(cx - 6, cy, 13, 1);
      const arcs = 1 + (Math.floor(tt / 350) % 3); // wifi bars filling up in the corner
      for (let i = 0; i < 3; i++) { b.fillStyle = i < arcs ? "#56b6c2" : "#24505a"; b.fillRect(sx + 20 + i * 2, sy + 4 - i, 1, 1 + i); }
      break;
    }
  }
  return true;
}

// Things on the desk that come with the work: a paper stack for reading, an energy drink in deep focus.
function drawWorkDeskProps(b, e, t, x, y) {
  const tt = REDUCED_MOTION.matches ? 0 : t;
  if (workKind(e, t) === "read") {
    outlineRect(b, x + 74, y + 5, 12, 8, "#f5f5f5");
    b.fillStyle = "#9aa"; b.fillRect(x + 76, y + 7, 7, 1); b.fillRect(x + 76, y + 9, 5, 1);
    if (tt % 2400 < 300) { b.fillStyle = "#fff"; b.fillRect(x + 78, y + 3, 8, 3); }
  }
  if (isDeepFocus(e)) {
    outlineRect(b, x + 86, y - 2, 6, 11, "#2a9d8f");
    b.fillStyle = "#e9c46a"; b.fillRect(x + 87, y + 2, 4, 2);
    b.fillStyle = "rgba(255,255,255,.45)"; b.fillRect(x + 88, y, 1, 4);
    if (!REDUCED_MOTION.matches) { b.fillStyle = "rgba(255,255,255,.5)"; b.fillRect(x + 89, y - 5 - (Math.floor(t / 350) % 3), 1, 2); }
  }
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
  if (status === "working" && drawWorkScreen(b, e, t, sx, sy)) {
    // tool-specific screen drawn by drawWorkScreen
  } else if (status === "working") {
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
  drawWorkDeskProps(b, e, t, x, y);
  if (e.seed % 2) { b.fillStyle = "#3a9d5d"; b.fillRect(x + 78, y + 2, 8, 6); b.fillStyle = "#b4593a"; b.fillRect(x + 79, y + 8, 6, 4); }
}

function drawRing(b, cx, y, strong) {
  b.fillStyle = strong ? "rgba(255,209,102,.45)" : "rgba(255,255,255,.3)";
  b.fillRect(cx - 16, y - 5, 32, 8);
  b.fillStyle = strong ? "#ffd166" : "#fff";
  b.fillRect(cx - 16, y - 5, 32, 2); b.fillRect(cx - 16, y + 1, 32, 2);
}

// 10x10 pixel icons: # = ink, o = accent
const TOOL_ICONS = {
  read: ["..........", ".########.", ".#oo##oo#.", ".#oo##oo#.", ".#oo##oo#.", ".#oo##oo#.", ".#oo##oo#.", ".########.", "..........", ".........."],
  write: [".......##.", "......#oo#", ".....#oo#.", "....#oo#..", "...#oo#...", "..#oo#....", ".#oo#.....", ".##.......", ".########.", ".........."],
  bash: ["##########", "#oooooooo#", "#o#oooooo#", "#oo#ooooo#", "#o#oooooo#", "#oooo###o#", "#oooooooo#", "##########", "..........", ".........."],
  search: ["..####....", ".#oooo#...", "#oo..oo#..", "#o....o#..", "#oo..oo#..", ".#oooo##..", "..####.##.", ".......###", "........##", ".........."],
  web: ["..######..", ".#o#oo#o#.", "#oo#oo#oo#", "##########", "#oo#oo#oo#", "#oo#oo#oo#", "##########", "#oo#oo#oo#", ".#o#oo#o#.", "..######.."],
  other: ["..........", "....##....", "...####...", "..##oo##..", ".##oooo##.", "..##oo##..", "...####...", "....##....", "..........", ".........."],
};
const TOOL_ACCENT = { read: "#61afef", write: "#e5a02d", bash: "#4ade80", search: "#c678dd", web: "#56b6c2", other: "#98a2b3" };

function drawToolIcon(b, kind, x, y) {
  const rows = TOOL_ICONS[kind];
  for (let j = 0; j < rows.length; j++) for (let i = 0; i < rows[j].length; i++) {
    const c = rows[j][i];
    if (c === ".") continue;
    b.fillStyle = c === "#" ? "#2b2b2b" : TOOL_ACCENT[kind];
    b.fillRect(x + i, y + j, 1, 1);
  }
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
  if (e.meet && e.hand) {
    // raised hand: palm and four fingers on a white card
    bubble(20, 20, "#fff");
    const hx = cx - 5, hy = top - 17 + bob;
    b.fillStyle = "#e0a030"; b.fillRect(hx, hy + 5, 10, 9); b.fillRect(hx - 2, hy + 8, 2, 4);
    for (let i = 0; i < 4; i++) b.fillRect(hx + i * 3, hy + (i === 0 || i === 3 ? 2 : 0), 2, 6);
    b.fillStyle = "#ffd166"; b.fillRect(hx + 1, hy + 6, 8, 7); for (let i = 0; i < 4; i++) b.fillRect(hx + i * 3, hy + (i === 0 || i === 3 ? 3 : 1), 1, 4);
  } else if (e.meet && e.status === "working" && !e.path.length) {
    // speaking in the meeting
    bubble(28, 16, "#fff");
    b.fillStyle = "#2b2b2b";
    const n = Math.floor(t / 350) % 4;
    for (let i = 0; i < 3; i++) b.fillRect(cx - 10 + i * 8, top - 10 + bob + (i < n ? -2 : 0), 4, 4);
  } else if (e.meet) {
    // listening: nothing over the head
  } else if (e.status === "working" && (e.anim === "type" || e.anim === "walk") && e.tool && t - e.tool.t0 < 8000 && TOOL_ICONS[e.tool.kind]) {
    bubble(20, 18, "#fff");
    drawToolIcon(b, e.tool.kind, cx - 5, top - 14 + bob);
  } else if (e.status === "working" && (e.anim === "type" || e.anim === "walk")) {
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
  } else if (e.status === "sick") {
    // first-aid sign: red cross on a white card, plus a slow sweat drop
    bubble(20, 18, "#fff");
    b.fillStyle = "#e11d48"; b.fillRect(cx - 2, top - 15 + bob, 4, 12); b.fillRect(cx - 6, top - 11 + bob, 12, 4);
    if (Math.floor(t / 700) % 2) { b.fillStyle = "#7dd3fc"; b.fillRect(e.x + 24, e.y - 14 + (Math.floor(t / 250) % 5), 2, 3); }
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
  } else if ((e.anim === "chat" && e.spot && !e.act) || (e.anim === "sitfree" && e.spot && ["meet", "sofa", "stool"].includes(e.spot.group) && e.napSpot !== e.spot)) {
    const group = e.spot.group || e.spot.key;
    const others = [...occupied].filter(([k, g]) => k !== e.spot.key && g === group);
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
WALL_ART.football_pennants = (b) => { // pennant string across the open office
  b.fillStyle = "#f4f4f4"; b.fillRect(8 * TILE, 6, 14 * TILE, 1);
  const cols = ["#d9534f", "#ffd166", "#2c62c9", "#f4f4f4", "#4ade80"];
  for (let i = 0; i < 14; i++) { const px = 8 * TILE + 8 + i * 32; b.fillStyle = cols[i % cols.length]; b.fillRect(px, 7, 12, 4); b.fillRect(px + 2, 11, 8, 4); b.fillRect(px + 4, 15, 4, 3); }
};
WALL_ART.football_scoreboard = wallAt(24, (b, t) => {
  const sx = 24 * TILE + 8; outlineRect(b, sx, 8, 112, 42, "#1c1e24");
  b.fillStyle = "#0a0c10"; b.fillRect(sx + 4, 12, 104, 34);
  const led = (x, y, digit) => { const seg = { 0: [1,1,1,1,1,1,0], 1: [0,1,1,0,0,0,0], 2: [1,1,0,1,1,0,1], 3: [1,1,1,1,0,0,1] }[digit]; b.fillStyle = "#ff3b3b"; if (seg[0]) b.fillRect(x + 1, y, 6, 2); if (seg[1]) b.fillRect(x + 6, y + 1, 2, 6); if (seg[2]) b.fillRect(x + 6, y + 8, 2, 6); if (seg[3]) b.fillRect(x + 1, y + 13, 6, 2); if (seg[4]) b.fillRect(x, y + 8, 2, 6); if (seg[5]) b.fillRect(x, y + 1, 2, 6); if (seg[6]) b.fillRect(x + 1, y + 7, 6, 2); };
  led(sx + 30, 22, 2); led(sx + 74, 22, 1); b.fillStyle = "#ff3b3b"; b.fillRect(sx + 54, 26, 3, 3); b.fillRect(sx + 54, 33, 3, 3);
  b.fillStyle = "#ffd166"; b.fillRect(sx + 10, 14, 24, 3); b.fillRect(sx + 78, 14, 24, 3);
  b.fillStyle = Math.floor(t / 1000) % 2 ? "#4ade80" : "#0a0c10"; b.fillRect(sx + 48, 40, 16, 3);
});
WALL_ART.football_jersey = wallAt(13, (b) => {
  outlineRect(b, 13 * TILE + 2, 12, 36, 36, "#3a3f4a"); b.fillStyle = "#f4f4f4"; b.fillRect(13 * TILE + 8, 20, 24, 22); b.fillRect(13 * TILE + 4, 22, 5, 8); b.fillRect(13 * TILE + 31, 22, 5, 8); b.fillStyle = "#d9534f"; b.fillRect(13 * TILE + 8, 20, 24, 3);
  b.fillStyle = "#1c1a20"; b.fillRect(13 * TILE + 14, 28, 2, 10); b.fillRect(13 * TILE + 19, 28, 2, 10); b.fillRect(13 * TILE + 21, 28, 5, 2); b.fillRect(13 * TILE + 21, 36, 5, 2); b.fillRect(13 * TILE + 25, 28, 2, 10);
});
WALL_ART.football_trophies = wallAt(20, (b) => {
  b.fillStyle = "#5c3d22"; b.fillRect(20 * TILE + 10, 40, 52, 4);
  for (let i = 0; i < 3; i++) { const tx = 20 * TILE + 14 + i * 17; b.fillStyle = i === 1 ? "#ffd166" : "#c0c0c0"; b.fillRect(tx, 14 + (i === 1 ? -4 : 0), 10, 10); b.fillRect(tx + 3, 24, 4, 8); b.fillRect(tx + 1, 32, 8, 4); b.fillStyle = "#fff3b0"; b.fillRect(tx + 2, 16 + (i === 1 ? -4 : 0), 2, 3); }
});
WALL_ART.football_clock = wallClock;
WALL_ART.football_banner = wallAt(0, (b) => { // GOL banner
  outlineRect(b, 16, 10, 150, 30, "#d9534f"); b.fillStyle = "#f4f4f4"; for (const [gx, gw] of [[40, 18], [70, 18], [100, 18]]) b.fillRect(gx, 16, gw, 18); b.fillStyle = "#d9534f"; b.fillRect(45, 21, 8, 8); b.fillRect(75, 21, 8, 8); b.fillRect(105, 16, 13, 12); b.fillRect(100, 21, 6, 8);
});
WALL_ART.football_tactics = wallAt(28, (b) => { // pitch diagram
  b.fillStyle = "#c9ced3"; b.fillRect(28 * TILE + 4, 10, 52, 36); b.fillStyle = "#fbfbf8"; b.fillRect(28 * TILE + 7, 13, 46, 30);
  b.fillStyle = "#3a9d5d"; b.fillRect(28 * TILE + 10, 16, 40, 24); b.fillStyle = "#fbfbf8"; b.fillRect(28 * TILE + 29, 16, 1, 24); b.fillStyle = "#d9534f"; b.fillRect(28 * TILE + 14, 22, 3, 3); b.fillRect(28 * TILE + 20, 30, 3, 3); b.fillStyle = "#2c62c9"; b.fillRect(28 * TILE + 38, 20, 3, 3); b.fillRect(28 * TILE + 42, 32, 3, 3);
});

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
WALL_ART.fashion_lights = (b, t) => { // string lights across the open office
  b.fillStyle = "#3a3f4a"; b.fillRect(8 * TILE, 6, 14 * TILE, 1);
  for (let i = 0; i < 14; i++) { const on = Math.floor(t / 600 + i) % 3 !== 0; b.fillStyle = on ? "#fff3b0" : "#8a8060"; b.fillRect(8 * TILE + 12 + i * 32, 7, 3, 4); if (on) { b.fillStyle = "rgba(255,240,180,.25)"; b.fillRect(8 * TILE + 10 + i * 32, 6, 7, 7); } }
};
WALL_ART.fashion_moodboard = wallAt(6, (b) => {
  b.fillStyle = "#c9a781"; b.fillRect(198, 3, 70, 22); b.fillStyle = "#f7efe7"; b.fillRect(200, 5, 66, 18);
  ["#e06c75", "#f78fb3", "#c678dd", "#61afef", "#ffd166", "#98c379"].forEach((c, i) => { b.fillStyle = c; b.fillRect(204 + i * 10, 8 + (i % 2) * 3, 7, 8); b.fillStyle = "#1c1a20"; b.fillRect(207 + i * 10, 7 + (i % 2) * 3, 1, 1); });
});
WALL_ART.fashion_poster = wallAt(13, (b) => { // dress poster
  outlineRect(b, 13 * TILE + 2, 8, 30, 42, "#2b2b2b"); b.fillStyle = "#f7efe7"; b.fillRect(13 * TILE + 5, 11, 24, 36);
  b.fillStyle = "#e06c75"; b.fillRect(13 * TILE + 14, 14, 6, 4); b.fillRect(13 * TILE + 12, 18, 10, 8); b.fillRect(13 * TILE + 9, 26, 16, 16); b.fillStyle = "#c95c86"; b.fillRect(13 * TILE + 9, 40, 16, 2);
}, -1);
WALL_ART.fashion_atelier = wallAt(0, (b) => { // ATELIER sign
  outlineRect(b, 16, 10, 150, 28, "#f7efe7"); b.fillStyle = "#c95c86"; for (let i = 0; i < 7; i++) b.fillRect(28 + i * 18, 17, 12, 14); b.fillStyle = "#f7efe7"; for (let i = 0; i < 7; i++) b.fillRect(32 + i * 18, 21, 4, 6);
});
WALL_ART.fashion_mirror = wallAt(24, (b) => {
  b.fillStyle = "#c9a781"; b.fillRect(24 * TILE + 8, 6, 112, 46); b.fillStyle = "#cfe6f2"; b.fillRect(24 * TILE + 12, 10, 104, 38); b.fillStyle = "rgba(255,255,255,.6)"; b.fillRect(24 * TILE + 20, 14, 3, 30); b.fillRect(24 * TILE + 26, 12, 1, 14);
});
WALL_ART.fashion_clock = wallClock;
WALL_ART.fashion_hats = wallAt(20, (b) => {
  b.fillStyle = "#c9a781"; b.fillRect(20 * TILE + 10, 40, 52, 4); ["#d9534f", "#2b2b2b", "#ffd166"].forEach((c, i) => { const hx = 20 * TILE + 12 + i * 17; b.fillStyle = OUTLINE; b.fillRect(hx - 1, 33, 18, 3); b.fillRect(hx + 3, 26, 10, 8); b.fillStyle = c; b.fillRect(hx, 34, 16, 1); b.fillRect(hx + 4, 27, 8, 7); });
});

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
  default: { plant: drawPlant, counter: drawKitchenCounter, fridge: drawFridge, roundTable: drawRoundTable, stool: drawStool, bin: drawBin, meetingTable: drawMeetingTable, meetingChair: drawMeetingChair, sofa: drawSofa, coffeeTable: drawCoffeeTable, bookshelf: drawBookshelf, lamp: drawLamp, cabinets: drawCabinets, boxes: drawBoxes, printer: drawPrinter, cooler: drawCooler, coffeeStation: drawCoffeeStation },
  football: { counter: drawSnackBar, fridge: drawVending, roundTable: drawBallTable, meetingTable: drawTacticsTable, sofa: drawBench, coffeeTable: drawBallRack, bookshelf: drawTrophyCase, lamp: drawFloodlight, cabinets: drawLockers, boxes: drawCones, printer: drawJerseyRack, cooler: drawBottleCrate, coffeeStation: drawDrinksCooler },
  fashion: { counter: drawCuttingTable, fridge: drawMannequin, roundTable: drawSwatchTable, meetingTable: drawDesignTable, sofa: drawVelvetSofa, coffeeTable: drawShoeDisplay, bookshelf: drawClothesRack, lamp: drawMirror, cabinets: drawWardrobe, boxes: drawFabricRolls, printer: drawIroning, cooler: drawHatStand, coffeeStation: drawSmallMannequin },
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
WALL_ART.gothic_glass = (b, t) => {
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
};
WALL_ART.gothic_cobwebs = (b) => { // cobwebs in the corners
  b.fillStyle = "rgba(255,255,255,.35)"; for (let i = 0; i < 8; i++) { b.fillRect(0, i * 3, 24 - i * 3, 1); b.fillRect(i * 3, 0, 1, 24 - i * 3); b.fillRect(LW - 24 + i * 3, i * 3, 1, 1); b.fillRect(LW - 1 - i * 3, 0, 1, 24 - i * 3); }
};
WALL_ART.gothic_chandelier = wallAt(14, (b, t) => {
  const cx = 14 * TILE + 16;
  b.fillStyle = "#3a3a40"; b.fillRect(cx - 1, 0, 2, 14); b.fillRect(cx - 22, 14, 44, 3); b.fillRect(cx - 24, 17, 4, 8); b.fillRect(cx + 20, 17, 4, 8); b.fillRect(cx - 2, 17, 4, 8);
  for (const px of [cx - 22, cx, cx + 22]) { b.fillStyle = "#f4ecd8"; b.fillRect(px - 1, 20, 2, 6); drawCandleFlame(b, px - 1, 20, t, px); }
}, 16);
WALL_ART.gothic_torch = (b, t, x0) => { // (one tile wide; the old torches stood at 30, 120, 26 tiles and 28 tiles + 20)
  const px = x0 + 16;
  b.fillStyle = OUTLINE; b.fillRect(px, 22, 4, 22); b.fillStyle = "#6b4a2b"; b.fillRect(px + 1, 24, 2, 18); b.fillStyle = "#ffb347"; b.fillRect(px - 2, 12 + (Math.floor((t + px) / 150) % 2), 8, 10); b.fillStyle = "#fff0a0"; b.fillRect(px, 15, 4, 5); b.fillStyle = "rgba(255,180,80,.12)"; b.fillRect(px - 10, 6, 24, 40);
};
WALL_ART.gothic_portrait = wallAt(13, (b, t) => { // portrait with watching eyes
  outlineRect(b, 13 * TILE + 2, 8, 30, 40, "#8a6a1f"); b.fillStyle = "#2b2730"; b.fillRect(13 * TILE + 6, 12, 22, 32);
  b.fillStyle = "#c9a781"; b.fillRect(13 * TILE + 12, 16, 10, 10); b.fillRect(13 * TILE + 9, 26, 16, 14); b.fillStyle = "#1c1c20"; b.fillRect(13 * TILE + 10, 14, 14, 4);
  const look = Math.floor(t / 1500) % 3; b.fillStyle = "#1c1c20"; b.fillRect(13 * TILE + 13 + look, 20, 2, 2); b.fillRect(13 * TILE + 18 + look, 20, 2, 2);
}, -1);
WALL_ART.gothic_moon = wallAt(20, (b) => {
  b.fillStyle = "#f4ecd8"; b.fillRect(20 * TILE + 10, 10, 12, 12); b.fillStyle = THEMES.gothic.wall.face; b.fillRect(20 * TILE + 15, 8, 10, 10);
});
WALL_ART.gothic_clock = wallClock;
PROPS.gothic = { counter: drawGothicCounter, fridge: drawArmor, roundTable: drawGothicTable, meetingTable: drawGothicMeeting, sofa: drawThrone, coffeeTable: drawChest, bookshelf: drawTomeShelf, lamp: drawCandleStand, cabinets: drawBarrels, boxes: drawBones, printer: drawLectern, cooler: drawGargoyle, coffeeStation: drawCauldronSmall };
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
WALL_ART.music_foam = wallAt(0, (b) => { // acoustic foam
  for (let i = 0; i < 6; i++) for (let j = 0; j < 2; j++) { const px = 8 + i * 22, py = 8 + j * 18; b.fillStyle = "#1f1f27"; b.fillRect(px, py, 20, 16); b.fillStyle = "#2b2b35"; for (let k = 0; k < 4; k++) b.fillRect(px + 2 + k * 5, py + 2 + (k % 2) * 6, 3, 6); }
});
WALL_ART.music_speaker = (b, t, x0) => { // (one tile wide; the old speakers flanked the windows)
  const px = x0 + 6;
  outlineRect(b, px, 10, 20, 34, "#1c1c22"); disc(b, px + 10, 20, 4, "#3a3a48"); disc(b, px + 10, 34, 6, "#3a3a48"); disc(b, px + 10, 34, 2 + (Math.floor(t / 150) % 2), "#4c4c5c");
};
WALL_ART.music_plaque = wallAt(13, (b, t) => { // YouTube plaque + floating notes
  drawYtLogo(b, 13 * TILE + 2, 12, 40, 28);
  b.fillStyle = "#ffffff"; b.fillRect(13 * TILE + 4, 44, 36, 1);
  for (let i = 0; i < 3; i++) { const ph = ((t / 900) + i / 3) % 1; drawMusicNote(b, 13 * TILE + 46 + i * 6 + Math.round(Math.sin(ph * 6 + i) * 2), 40 - Math.round(ph * 28), ["#ffd166", "#ff3b3b", "#61afef"][i]); }
});
WALL_ART.music_onair = wallAt(15, (b, t) => {
  const on = Math.floor(t / 800) % 2 === 0;
  outlineRect(b, 15 * TILE + 2, 12, 52, 20, on ? "#5a0f14" : "#26262e"); b.fillStyle = on ? "#ff3b3b" : "#4a2a2a";
  // "ON AIR" in 3x5 pixel letters
  const glyph = { O: ["111", "101", "101", "101", "111"], N: ["101", "111", "111", "111", "101"], A: ["010", "101", "111", "101", "101"], I: ["111", "010", "010", "010", "111"], R: ["110", "101", "110", "101", "101"] };
  let gx = 15 * TILE + 6; for (const ch of "ON AIR") { if (ch !== " ") { const g = glyph[ch]; for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (g[r][c] === "1") b.fillRect(gx + c * 2, 17 + r * 2, 2, 2); } gx += ch === " " ? 4 : 8; }
  if (on) { b.fillStyle = "rgba(255,59,59,.10)"; b.fillRect(15 * TILE - 6, 4, 68, 40); }
});
WALL_ART.music_awards = wallAt(23, (b) => { // creator award plaques (silver, gold, diamond)
  for (let i = 0; i < 3; i++) { const px = 23 * TILE + 1 + i * 32; outlineRect(b, px, 10, 28, 36, "#3a3a48"); b.fillStyle = "#1a1a22"; b.fillRect(px + 2, 12, 24, 32); drawYtLogo(b, px + 6, 18, 16, 12, ["#c0c0c0", "#ffd166", "#bfe8ff"][i]); b.fillStyle = "#e8e6e0"; b.fillRect(px + 6, 36, 16, 1); b.fillRect(px + 9, 39, 10, 1); }
});
WALL_ART.music_counter = wallAt(26, (b, t) => { // subscriber counter
  const sx = 26 * TILE + 14; outlineRect(b, sx, 12, 108, 30, "#0a0c10"); b.fillStyle = "#ff3b3b"; b.fillRect(sx + 4, 16, 24, 5); b.fillStyle = "#e8e6e0"; b.fillRect(sx + 32, 17, 40, 3);
  const digits = ["1", ".", "2", "M"]; let dx = sx + 8;
  const seg7 = { 1: [0, 1, 1, 0, 0, 0, 0], 2: [1, 1, 0, 1, 1, 0, 1] };
  for (const d of digits) {
    if (d === ".") { b.fillStyle = "#ff3b3b"; b.fillRect(dx, 36, 2, 2); dx += 6; continue; }
    if (d === "M") { b.fillStyle = "#ff3b3b"; b.fillRect(dx, 25, 2, 13); b.fillRect(dx + 8, 25, 2, 13); b.fillRect(dx + 2, 27, 2, 3); b.fillRect(dx + 6, 27, 2, 3); b.fillRect(dx + 4, 30, 2, 3); dx += 14; continue; }
    const s = seg7[d]; b.fillStyle = "#ff3b3b"; if (s[0]) b.fillRect(dx + 1, 24, 6, 2); if (s[1]) b.fillRect(dx + 6, 25, 2, 6); if (s[2]) b.fillRect(dx + 6, 32, 2, 6); if (s[3]) b.fillRect(dx + 1, 37, 6, 2); if (s[4]) b.fillRect(dx, 32, 2, 6); if (s[5]) b.fillRect(dx, 25, 2, 6); if (s[6]) b.fillRect(dx + 1, 31, 6, 2); dx += 12;
  }
  drawVu(b, sx + 60, 38, 11, t, 3);
});
WALL_ART.music_clock = wallClock;
PROPS.music = { counter: drawStudioBar, fridge: drawSpeakerStack, roundTable: drawDrumKit, meetingTable: drawMixingConsole, sofa: drawStudioCouch, coffeeTable: drawSynth, bookshelf: drawVinylShelf, lamp: drawMicStand, cabinets: drawGuitarRack, boxes: drawAmpStack, printer: drawCameraRig, cooler: drawRingLight, coffeeStation: drawHeadphoneStand };
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
WALL_ART.travel_bunting = wallAt(0, (b) => { // bunting flags + world clocks
  b.fillStyle = "#f4efe1"; b.fillRect(8, 8, 200, 1);
  const flags = [["#d9534f", "#f4efe1"], ["#3b8bc9", "#ffd166"], ["#4ade80", "#f4efe1"], ["#ff8c42", "#f4efe1"], ["#c678dd", "#ffd166"], ["#2f6f8f", "#d9534f"], ["#ffd166", "#3b8bc9"], ["#f4efe1", "#d9534f"]];
  for (let i = 0; i < 8; i++) { const px = 12 + i * 25; b.fillStyle = flags[i][0]; b.fillRect(px, 9, 14, 8); b.fillStyle = flags[i][1]; b.fillRect(px, 13, 14, 2); b.fillStyle = flags[i][0]; b.fillRect(px + 4, 17, 6, 3); }
  drawClockOffset(b, 40, 36, 3, "#d9534f"); drawClockOffset(b, 100, 36, 1, "#3b8bc9"); drawClockOffset(b, 160, 36, -4, "#ffd166");
});
WALL_ART.travel_poster = wallAt(7, (b) => { // Footyprint poster (footprint icon)
  outlineRect(b, 8 * TILE - 2, 10, 26, 36, "#2f6f8f"); b.fillStyle = "#3f8fb0"; b.fillRect(8 * TILE, 12, 22, 32);
  const fx = 8 * TILE + 6, fy = 16; b.fillStyle = "#f4efe1"; b.fillRect(fx + 2, fy + 8, 8, 12); b.fillRect(fx + 3, fy + 20, 6, 4); b.fillRect(fx + 1, fy + 3, 3, 4); b.fillRect(fx + 5, fy + 2, 2, 3); b.fillRect(fx + 8, fy + 3, 2, 3); b.fillRect(fx + 11, fy + 5, 2, 3);
  b.fillStyle = "#ffd166"; b.fillRect(fx + 2, fy + 26, 10, 1); b.fillRect(fx + 4, fy + 28, 6, 1);
});
WALL_ART.travel_map = wallAt(12, (b, t) => { // world map with blinking pins + a plane on its route
  const mx = 9 * TILE + 102, my = 8; outlineRect(b, mx, my, 148, 44, "#2f6f8f"); b.fillStyle = "#3b8bc9"; b.fillRect(mx + 2, my + 2, 144, 40);
  b.fillStyle = "#6fc276";
  for (const [ox, oy, w, h] of [[8, 6, 24, 14], [14, 20, 12, 16], [40, 4, 30, 10], [44, 14, 14, 8], [70, 6, 44, 14], [84, 20, 12, 10], [118, 26, 16, 8], [96, 30, 8, 4], [128, 8, 14, 10]]) b.fillRect(mx + 2 + ox, my + 2 + oy, w, h);
  b.fillStyle = "#3f9d4f"; for (const [ox, oy] of [[12, 10], [44, 7], [76, 10], [132, 12]]) b.fillRect(mx + 2 + ox, my + 2 + oy, 5, 2);
  const pins = [[20, 12], [50, 9], [80, 12], [124, 28]];
  b.fillStyle = "#f4efe1"; for (let i = 0; i < pins.length - 1; i++) { const [ax, ay] = pins[i], [bx, by] = pins[i + 1]; for (let k = 0; k < 10; k += 2) b.fillRect(mx + 2 + Math.round(ax + (bx - ax) * k / 10), my + 2 + Math.round(ay + (by - ay) * k / 10), 1, 1); }
  pins.forEach(([px, py], i) => { const on = Math.floor(t / 500) % pins.length === i; b.fillStyle = on ? "#ffd166" : "#d9534f"; b.fillRect(mx + 1 + px, my + 1 + py, 3, 3); if (on) { b.fillStyle = "rgba(255,209,102,.25)"; b.fillRect(mx - 1 + px, my - 1 + py, 7, 7); } });
  const seg = Math.floor(t / 2000) % (pins.length - 1), f = (t % 2000) / 2000; const [ax, ay] = pins[seg], [bx, by] = pins[seg + 1];
  drawPlaneIcon(b, mx + 2 + Math.round(ax + (bx - ax) * f) - 5, my + 2 + Math.round(ay + (by - ay) * f) - 6, "#f4efe1", 1);
});
WALL_ART.travel_departures = wallAt(23, (b, t) => {
  const dx = 23 * TILE + 4; outlineRect(b, dx, 8, 200, 42, "#1c1e24"); b.fillStyle = "#0a0c10"; b.fillRect(dx + 3, 11, 194, 36);
  b.fillStyle = "#ffd166"; b.fillRect(dx + 8, 14, 44, 3); drawPlaneIcon(b, dx + 180, 12, "#ffd166", 1);
  const rows = 4; for (let r = 0; r < rows; r++) { const flip = Math.floor((t / 900 + r * 0.7)) % 6; const y = 21 + r * 6; b.fillStyle = "#e8e6e0"; b.fillRect(dx + 8, y, 20 + ((r * 7 + flip) % 3) * 6, 2); b.fillRect(dx + 60, y, 24 + ((r * 5 + flip) % 4) * 5, 2); b.fillStyle = flip === r ? "#4ade80" : (r === 2 && flip === 5 ? "#d9534f" : "#ffd166"); b.fillRect(dx + 120, y, 16, 2); b.fillStyle = "#8fa7b8"; b.fillRect(dx + 150, y, 10 + ((r + flip) % 3) * 4, 2); }
});
WALL_ART.travel_clock = wallClock;
PROPS.travel = { counter: drawTravelCafe, fridge: drawGlobe, roundTable: drawCafeTable, meetingTable: drawMapTable, sofa: drawBeachSofa, coffeeTable: drawBambooTable, bookshelf: drawBrochureRack, lamp: drawPalm, cabinets: drawLuggageShelf, boxes: drawLuggageCart, printer: drawCheckinKiosk, cooler: drawSignpost, coffeeStation: drawCarryOn };
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
  for (const it of items) it.draw(b);
  const out = document.createElement("canvas");
  out.width = width; out.height = Math.round(width * LH / LW);
  const g = out.getContext("2d");
  g.imageSmoothingEnabled = true;
  g.drawImage(buf, 0, 0, out.width, out.height);
  return out.toDataURL();
}
window.renderThemePreview = renderThemePreview;

// Does this theme draw a floor piece its own way? (Otherwise it would only repeat the classic look, so the market does not list it twice.)
function themeHasSkin(theme, type) {
  if (theme === "default" || type === "rug") return true; // (every theme has its own rug)
  const d = ITEM_DRAW[type];
  return !!(d && PROPS[theme] && PROPS[theme][PROP_ALIAS[d.prop] || d.prop]);
}
window.themeHasSkin = themeHasSkin;
window.THEME_COLORS = (theme) => { const w = (THEMES[theme] || THEMES.default).wall; return [w.face, w.top]; }; // (a theme's wall colours: the swatch of its collection)

// A small picture of one piece for the layout editor's market (drawn with `skin`'s props, or the theme's own when there is no skin).
const itemThumbs = new Map();
function renderItemThumb(theme, type, skin) {
  const k = theme + ":" + type + ":" + (skin || "");
  if (itemThumbs.has(k)) return itemThumbs.get(k);
  const T = POLayout.TYPES[type];
  const look = skin || theme;
  let url;
  if (T.wall) { // wall decor: the piece on a bit of its theme's wall (ambient decor: the stretch of wall it covers)
    const cv = document.createElement("canvas");
    cv.width = (T.wall.w || 6) * TILE; cv.height = 60;
    const g = cv.getContext("2d");
    const W = (THEMES[T.wall.theme] || THEMES[theme] || THEMES.default).wall; // the wall band as it is in the office: face, top edge, baseboard
    g.fillStyle = W.face; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = W.top; g.fillRect(0, 0, cv.width, 3);
    g.fillStyle = W.base; g.fillRect(0, 48, cv.width, 8); g.fillStyle = W.base2; g.fillRect(0, 56, cv.width, 4);
    if (WALL_ART[type]) {
      if (T.wall.ambient) { g.save(); g.translate(type === "gothic_cobwebs" ? 0 : -8 * TILE, 0); WALL_ART[type](g, 0, 0); g.restore(); } else WALL_ART[type](g, 0, 0);
    }
    url = cv.toDataURL();
  } else if (type === "rug") { // a rug on a dark floor
    const cv = document.createElement("canvas");
    cv.width = 5 * TILE; cv.height = 5 * TILE;
    const g = cv.getContext("2d");
    g.fillStyle = "#2a2c38"; g.fillRect(0, 0, cv.width, cv.height);
    drawRug(g, look, 0, 0);
    url = cv.toDataURL();
  } else {
    const it = { id: "thumb", type, tx: 4, ty: 4, dir: POLayout.DEFAULT_DIR[type], v: 1, ...(skin ? { skin } : {}) };
    const tiles = POLayout.tilesOf(it);
    const x0 = Math.min(...tiles.map((q) => q[0])), x1 = Math.max(...tiles.map((q) => q[0]));
    const y0 = Math.min(...tiles.map((q) => q[1])), y1 = Math.max(...tiles.map((q) => q[1]));
    const up = (T.up || 0) + 6;
    const cv = document.createElement("canvas");
    cv.width = (x1 - x0 + 1) * TILE + 16; cv.height = (y1 - y0 + 1) * TILE + up + 10;
    const b = cv.getContext("2d");
    b.translate(8 - x0 * TILE, up - y0 * TILE);
    const list = [];
    if (type === "desk") {
      const feet = (it.ty + 1) * TILE;
      list.push({ y: feet - 24, draw: () => drawChair(b, it.tx * TILE, feet) }, { y: feet + TILE + 6, draw: () => drawDesk(b, deskStub({ tx: it.tx, ty: it.ty }), 0) });
    } else itemDecor(theme, it, list);
    list.sort((a, c) => a.y - c.y);
    for (const d of list) d.draw(b, 0);
    url = cv.toDataURL();
  }
  itemThumbs.set(k, url);
  return url;
}
window.renderItemThumb = renderItemThumb;
// what an empty desk is drawn with
const deskStub = (seat) => ({ seat, tx: -1, ty: -1, path: [], status: "idle", color: "#8b8f9e", look: {}, seed: 0, anim: "stand" });
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
  const sitting = ["sit", "type", "wave", "slump", "sip", ...LIFE_SEATED].includes(o.anim);
  const sitFree = o.anim === "sitfree" || o.anim === "dozefree";
  const dozing = o.anim === "doze" || o.anim === "dozefree";
  const walking = o.anim === "walk";
  const f = walking ? o.frame : 0;
  const bob = walking ? (f === 1 || f === 3 ? 1 : 0) : (Math.floor(o.t / 1200) % 2 === 0 ? 1 : 0);
  // laughing: lau = intensity 0..1, lk = variant, lt = ms since it began. Shakes stop under reduced motion, the pose stays.
  const lau = o.laugh || 0, lk = o.lk || "arms", lt = o.lt || 0, still = REDUCED_MOTION.matches;
  const lauPose = lau > 0 && LAUGH_POSE.includes(o.anim);
  const jig = lau > 0.3 && !still ? Math.floor(lt / 85) % 2 : 0;          // shoulders shaking
  const nod = lau > 0.4 && !still ? Math.floor(lt / 130) % 2 : 0;         // head bobbing
  const throwBack = lau > 0.6 && (lk === "arms" || lk === "mouth" || lk === "slap") ? -1 : 0; // head thrown back
  const bend = lau > 0.5 && (lk === "belly" || lk === "knee") ? 2 : 0;     // doubled over
  const blink = dozing || lau > 0 || o.anim === "yawn" || Math.floor((o.t + (o.seed || 0)) / 3400) % 18 === 0;
  const slump = o.anim === "slump" ? 3 : 0;
  const H = bob + slump + headNod(o) + (dozing ? 2 : 0) + (lau ? throwBack + bend + nod : 0); // head offset
  const T = bob + (lau ? jig + (bend ? 1 : 0) : 0);         // torso offset
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
    if (F.topStyle === "crop") {
      // bare midriff: skin from the hem down to the belt, waist follows the body shape
      C(skin);
      if (fem) { R(tx + 2, 23 + T, tw - 4, 3); R(tx + 1, 26 + T, tw - 2, 1); R(tx, 27 + T, tw, 1); }
      else R(P.belly ? tx - 1 : tx, 23 + T, P.belly ? tw + 2 : tw, 5);
      C(skinDark); R(tx + tw - (fem ? 4 : 2), 23 + T, 2, 3); R(tx + tw - 2, 26 + T, 2, 2); R(cx, 26 + T, 1, 1);
      C(topDark); R(tx, 22 + T, tw, 1);
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

  // tool-shaped working poses (o.tool) and idle desk micro moves (o.micro); false = not handled
  const workArms = () => {
    const t = REDUCED_MOTION.matches ? 0 : o.t;
    switch (o.tool) {
      case "read": {
        // holds a sheet up in both hands and flips it now and then
        const ph = t % 2400;
        arm(axL, 17 + T, 5, false); arm(axR, 17 + T, 5, false);
        C("#f5f5f5"); R(cx - 6, 20 + T, 12, 9);
        C("#9aa"); R(cx - 4, 22 + T, 8, 1); R(cx - 4, 24 + T, 6, 1); R(cx - 4, 26 + T, 7, 1);
        if (ph < 260) { C("#dfe6ee"); R(cx + 5 - Math.round((ph / 260) * 10), 20 + T, 2, 9); }
        C(skin); R(cx - 8, 24 + T, 3, 4); R(cx + 5, 24 + T, 3, 4);
        return true;
      }
      case "write": {
        // fast typing, then a pause (the head nods, see headNod)
        const pause = t % 3200 > 2300 && t % 3200 < 3000;
        const tap = pause ? 0 : Math.floor(t / 90) % 2;
        arm(axL, 17 + T, 6, false); arm(axR, 17 + T, 6, false);
        C(skin); R(axL + 1, 23 + T + tap, 5, 3); R(axR - 3, 24 + T - tap, 5, 3);
        return true;
      }
      case "bash": {
        // hammering the keys: hands lift high and slam down
        const hit = Math.floor(t / 100) % 2;
        arm(axL, 17 + T, 5 + hit, false); arm(axR, 17 + T, 6 - hit, false);
        C(skin); R(axL + 1, 22 + T + hit * 3, 5, 3); R(axR - 3, 25 + T - hit * 3, 5, 3);
        return true;
      }
      case "search": {
        // right hand holds a magnifying glass out beside the head and sweeps it about, left hand rests
        const sw = Math.round(Math.sin(t / 450) * 2);
        arm(axL, 19 + T, 7, true);
        C(sleeveC); R(axR, 14 + T, aw, 5);
        C(skin); R(axR + sw, 11 + T, aw, 3);
        C(OUTLINE); R(axR + 2 + sw, 2 + T, 9, 9);
        C("rgba(200,225,255,.85)"); R(axR + 3 + sw, 3 + T, 7, 7);
        C("#fff"); R(axR + 4 + sw, 4 + T, 2, 1);
        C("#6b4a2a"); R(axR + 1 + sw, 10 + T, 2, 2);
        return true;
      }
      case "web": {
        // one hand on the mouse, clicking around; the other types
        const tap = Math.floor(t / 300) % 2;
        arm(axL, 17 + T, 6, false); arm(axR, 17 + T, 6, false);
        C(skin); R(axL + 1, 23 + T + tap, 5, 3); R(axR - 1, 25 + T + (Math.floor(t / 700) % 2), 4, 3);
        return true;
      }
    }
    switch (o.micro) {
      case "stretch": {
        // both arms up and out, drifting apart and back
        const sp = Math.round(Math.sin(Math.min(1, (o.microT || 0) / 2400) * Math.PI) * 3);
        C(sleeveC); R(axL - sp, 3 + H, aw, 15 + T - H); R(axR + sp, 3 + H, aw, 15 + T - H);
        C(skin); R(axL - sp, -1 + H, aw, 4); R(axR + sp, -1 + H, aw, 4);
        return true;
      }
      case "clock": {
        // lifts the left wrist, glances at the watch, lowers it again
        const up = (o.microT || 0) < 1500 ? 1 : 0;
        arm(axR, 19 + T, 7, true);
        C(sleeveC); R(axL, 17 + T, aw, up ? 4 : 6);
        C(skin); R(axL, (up ? 21 : 23) + T, aw, 3);
        if (up) { C("#c9d1d9"); R(axL, 20 + T, aw, 1); C("#4a6a9c"); R(axL + 1, 20 + T, 1, 1); }
        return true;
      }
      case "phone": case "giggle": {
        // both hands hold a phone at chest height, thumb scrolling
        arm(axL, 17 + T, 5, false); arm(axR, 17 + T, 5, false);
        C(OUTLINE); R(cx - 3, 19 + T, 7, 10);
        C("#8ecaff"); R(cx - 2, 20 + T, 5, 8);
        C("#ffffff"); R(cx - 1, 21 + T + (Math.floor((o.microT || 0) / 400) % 4) * 2, 3, 1);
        C(skin); R(cx - 5, 24 + T, 3, 4); R(cx + 3, 24 + T, 3, 4);
        return true;
      }
    }
    return false;
  };

  // laughing poses (front view): arms up, hands on the belly, slapping the knee / desk, wiping a tear, hand over the mouth
  const laughArms = () => {
    if (!lauPose) return false;
    const fl = still ? 0 : Math.floor(lt / 110) % 2;
    switch (lk) {
      case "belly":
        arm(axL, 17 + T, 6, false); arm(axR, 17 + T, 6, false);
        C(sleeveC); R(cx - 6, 23 + T, 12, 3); C(skin); R(cx - 6, 23 + T, 3, 3); R(cx + 3, 23 + T, 3, 3);
        return true;
      case "knee":
        arm(axL, 17 + T, 7, true);
        C(sleeveC); R(axR, 17 + T, aw, 8); C(skin); R(axR - 2, 25 + T + fl * 2, 5, 4);
        return true;
      case "tear": {
        const wipe = still ? 0 : Math.floor(lt / 200) % 2;
        arm(axL, 19 + T, 7, true);
        C(sleeveC); R(axR, 12 + T, aw, 7); C(skin); R(axR - 3 + wipe, 8 + H, 5, 4);
        return true;
      }
      case "mouth":
        arm(axL, 19 + T, 7, true);
        C(sleeveC); R(axR, 13 + T, aw, 6); C(skin); R(axR - 5, 11 + H, 6, 3);
        return true;
      case "slap":
        arm(axL, 17 + T, 6, false); arm(axR, 17 + T, 6, false);
        C(skin); R(axL + 1, 22 + T + fl * 2, 5, 3); R(axR - 3, 24 + T - fl * 2, 5, 3);
        return true;
      default:
        C(sleeveC); R(axL - 3, 3 + H, aw, 15); R(axR + 2, 3 + H, aw, 15);
        C(skin); R(axL - 3, -1 + H + fl, aw, 4); R(axR + 2, -1 + H + fl, aw, 4);
        return true;
    }
  };

  const armsFront = () => {
    const swing = walking ? [0, 2, 0, -2][f] : 0;
    if ((o.tool || o.micro) && workArms()) return;
    if (laughArms()) return;
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
      case "sitfree": case "dozefree": arm(axL, 17 + T, 7, true); arm(axR, 17 + T, 7, true); break;
      case "stretch": case "cheer": {
        // both arms thrown up (stretch = lazy, cheer = victory V)
        const up = Math.floor(o.t / (o.anim === "cheer" ? 180 : 500)) % 2;
        const sp = o.anim === "cheer" ? 2 : 0;
        C(sleeveC); R(axL - 2 - sp, 3 + H, aw, 15); R(axR + 1 + sp, 3 + H, aw, 15);
        C(skin); R(axL - 2 - sp, -1 + H + up, aw, 4); R(axR + 1 + sp, -1 + H + up, aw, 4);
        break;
      }
      case "yawn": arm(axL, 17 + T, 7, true); C(sleeveC); R(axR, 15 + T, aw, 4); C(skin); R(14, 12 + H, 9, 3); break;
      case "hop": {
        arm(axL, 17 + T, 7, true);
        C(sleeveC); R(axR, 6 + H, aw, 12);
        C(skin); R(axR + (Math.floor(o.t / 250) % 2), 2 + H, aw + 1, 4);
        break;
      }
      case "paper": {
        const lift = Math.floor(o.t / 900) % 2;
        C(sleeveC); R(axL, 17 + T, aw, 5); R(axR, 17 + T, aw, 5);
        C(OUTLINE); R(cx - 8, 15 + T - lift, 16, 12);
        C("#f5f5f5"); R(cx - 7, 16 + T - lift, 14, 10);
        C("#9aa"); for (let i = 0; i < 4; i++) R(cx - 5, 18 + T - lift + i * 2, 10 - (i === 3 ? 4 : 0), 1);
        C(skin); R(axL, 21 + T, aw, 3); R(axR, 21 + T, aw, 3);
        break;
      }
      case "brew": {
        arm(axL, 17 + T, 6, false); arm(axR, 17 + T, 6, false);
        C(sleeveC); R(cx - 6, 23 + T, 12, 3); C(skin); R(cx - 6, 23 + T, 3, 3); R(cx + 3, 23 + T, 3, 3);
        break;
      }
      case "water": {
        arm(axL, 17 + T, 7, true);
        C(sleeveC); R(axR, 17 + T, aw, 5); C(skin); R(axR, 22 + T, 4, 3);
        C("#4a90b8"); R(axR - 3, 19 + T, 9, 6); C("#7bbbe0"); R(axR - 2, 20 + T, 3, 1); C("#4a90b8"); R(axR - 8, 20 + T, 5, 2); R(axR - 9, 19 + T, 2, 2);
        C("#7dd3fc"); for (let i = 0; i < 3; i++) R(axR - 9 + (i % 2), 22 + T + ((Math.floor(o.t / 110) + i * 3) % 9), 1, 2);
        break;
      }
      case "chat": {
        // one talks with a raised, gesturing hand; the other listens
        arm(axL, 17 + T, 7, true);
        if (o.talk) {
          const ph = Math.floor(o.t / 220 + (o.seed || 0)) % 2;
          C(sleeveC); R(axR, 11 + T + ph, aw, 7); C(skin); R(axR - 1, 8 + T + ph, 5, 4);
        } else arm(axR, 17 + T, 7, true);
        break;
      }
      case "clap": case "clapsit": {
        const p = Math.floor(o.t / 140) % 2;
        C(sleeveC); R(axL, 17 + T, aw, 6); R(axR, 17 + T, aw, 6);
        C(skin); R(cx - 5 + p * 2, 21 + T, 4, 4); R(cx + 1 - p * 2, 21 + T, 4, 4);
        break;
      }
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
    } else if (lau) { // happy squint: ^ ^
      C("#1c1a20"); R(12, 10 + H, 1, 1); R(13, 9 + H, 2, 1); R(14, 10 + H, 1, 1); R(18, 10 + H, 1, 1); R(19, 9 + H, 2, 1); R(20, 10 + H, 1, 1);
    } else { C("#1c1a20"); R(12, 10 + H, 2, 1); R(18, 10 + H, 2, 1); if (L.fem) { R(11, 10 + H, 1, 1); R(20, 10 + H, 1, 1); } }
    if (F.hat === "none") { C(hairDark); R(12, 6 + H, 2, 1); R(18, 6 + H, 2, 1); }
    if (lau) {
      // wide open laughing mouth: teeth on top, tongue at the bottom; a chuckle is smaller
      const big = lau > 0.55 && (still || Math.floor(lt / 110) % 3 !== 2);
      const mw = lau > 0.55 ? 6 : 4, mx = 16 - (mw >> 1);
      C("#4a1522"); R(mx, 12 + H, mw, big ? 3 : 2);
      C("#ffffff"); R(mx, 12 + H, mw, 1);
      if (big) { C("#e0607a"); R(mx + 1, 14 + H, mw - 2, 1); }
      if (lau > 0.5 && (still || Math.floor(lt / 260) % 4 === 1 || Math.floor(lt / 260) % 4 === 2)) { // tear
        C("#8fd3ff"); const dy = still ? 0 : Math.floor(lt / 260) % 4 - 1; R((o.seed || 0) % 2 ? 12 : 19, 11 + H + dy, 1, 2);
      }
    } else if (o.talk) {
      if (Math.floor((o.t + (o.seed || 0)) / 140) % 2) { C("#4a1522"); R(14, 12 + H, 3, 2); } else { C(L.fem ? "#d4607a" : skinDark); R(15, 12 + H, 2, 1); }
    } else if (L.fem) { C("#d4607a"); R(15, 12 + H, 2, 1); C("#e98aa0"); R(15, 12 + H, 1, 1); }
    else { C(skinDark); R(15, 12 + H, 2, 1); }
    C(L.fem ? "#f0a0a8" : "#eaa5a0"); R(11, 11 + H, 1, 1); R(20, 11 + H, 1, 1);
    if (L.fem && !["long", "bob", "afro"].includes(hs)) { C("#f2c14e"); R(9, 10 + H, 1, 2); R(22, 10 + H, 1, 2); }
    beardFront();
    glassesFront();
    accessoryFront(b, ox, oy + H, L, C);
    if (o.deep) { // deep focus: big over-ear headphones
      C("#222"); R(9, 1 + H, 14, 2); R(8, 2 + H, 2, 5); R(22, 2 + H, 2, 5);
      C("#2a2a30"); R(7, 6 + H, 3, 6); R(22, 6 + H, 3, 6);
      C(e.color || "#e5a02d"); R(8, 7 + H, 1, 4); R(23, 7 + H, 1, 4);
    }
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
    else if (F.topStyle === "crop") {
      C(skin);
      if (fem) { R(tx + 2, 23 + T, tw - 4, 3); R(tx + 1, 26 + T, tw - 2, 1); R(tx, 27 + T, tw, 1); }
      else R(P.belly ? tx - 1 : tx, 23 + T, P.belly ? tw + 2 : tw, 5);
      C(skinDark); R(tx + tw - (fem ? 4 : 2), 23 + T, 2, 3); R(tx + tw - 2, 26 + T, 2, 2);
      C(topDark); R(tx, 22 + T, tw, 1);
    }
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
    else if (F.topStyle === "crop") {
      C(skin);
      if (fem) { R(sx + 1, 23 + T, sw - 2, 3); R(sx, 26 + T, sw, 2); } else R(sx, 23 + T, sw, 5);
      if (P.belly) { R(sx + sw, 23 + T, 2, 5); }
      C(skinDark); R(sx, 23 + T, 2, 5);
      C(topDark); R(sx, 22 + T, sw, 1);
    }
    if (F.topStyle !== "dress" && !suit) { C("#33303a"); R(sx, 28 + T, sw, 1); }
    C(skin); R(14, 14 + H, 4, 3);
    const ax = sx + Math.floor((sw - aw) / 2);
    if (lauPose) {
      const fl = still ? 0 : Math.floor(lt / 110) % 2;
      C(sleeveC);
      switch (lk) {
        case "belly": R(ax + 1, 17 + T, aw, 6); C(skin); R(ax + 2, 22 + T, aw + 4, 3); break;
        case "knee": R(ax + 1, 17 + T, aw, 9); C(skin); R(ax + 2, 26 + T + fl * 2, aw + 1, 4); break;
        case "tear": R(ax + 3, 13 + T, aw, 7); C(skin); R(ax + 4 + (still ? 0 : Math.floor(lt / 200) % 2), 9 + H, 4, 4); break;
        case "mouth": R(ax + 3, 14 + T, aw, 6); C(skin); R(ax + 5, 11 + H, 4, 3); break;
        case "slap": R(ax + 1, 17 + T, aw, 7); C(skin); R(ax + 2, 24 + T + fl * 2, aw + 2, 4); break;
        default: R(ax + 1, 8 + H, aw, 10); C(skin); R(ax + 1 + fl, 4 + H, aw + 1, 4);
      }
    } else if (o.anim === "drink") {
      C(sleeveC); R(ax + 1, 17 + T, aw, 5); C(skin); R(ax + 3, 21 + T, 3, 3);
      C("#f5f5f5"); R(ax + 4, 18 + T, 7, 8); C(e.color); R(ax + 6, 20 + T, 3, 4);
    } else if (o.anim === "read") {
      C(sleeveC); R(ax + 1, 17 + T, aw, 4); C("#f5f5f5"); R(ax + 2, 21 + T, 10, 8); C("#9aa"); R(ax + 4, 24 + T, 5, 1); R(ax + 4, 27 + T, 4, 1); C(skin); R(ax + 1, 24 + T, aw, 4);
    } else if (o.anim === "sitfree" || o.anim === "dozefree") {
      C(sleeveC); R(ax + 1, 17 + T, aw, 6); C(skin); R(ax + 2, 23 + T, aw, 4);
    } else if (o.anim === "pat") {
      // reaching out to a colleague's shoulder
      C(sleeveC); R(ax + 1, 18 + T, 11, 4); C(skin); R(ax + 12 + (Math.floor(o.t / 320) % 2), 17 + T, 4, 4);
    } else if (["cheer", "hop", "stretch", "clap", "clapsit"].includes(o.anim) || (o.anim === "chat" && o.talk)) {
      const w = Math.floor(o.t / 200) % 2;
      C(sleeveC); R(ax + 1, 8 + H, aw, 10); C(skin); R(ax + 1 + w, 4 + H, aw + 1, 4);
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
    if (!blink) { C("#1c1a20"); R(17, 8 + H, 2, 3); if (L.fem) R(17, 7 + H, 3, 1); C(F.eyes); R(18, 9 + H, 1, 1); C("#fff"); R(17, 8 + H, 1, 1); } else if (lau) { C("#1c1a20"); R(17, 10 + H, 1, 1); R(18, 9 + H, 1, 1); R(19, 10 + H, 1, 1); } else { C("#1c1a20"); R(17, 10 + H, 2, 1); }
    if (F.hat === "none") { C(hairDark); R(17, 6 + H, 3, 1); }
    C(skinDark); R(22, 9 + H, 1, 2);
    if (lau) {
      const big = lau > 0.55 && (still || Math.floor(lt / 110) % 3 !== 2);
      C("#4a1522"); R(lau > 0.55 ? 18 : 19, 12 + H, lau > 0.55 ? 4 : 3, big ? 3 : 2);
      C("#ffffff"); R(lau > 0.55 ? 18 : 19, 12 + H, lau > 0.55 ? 4 : 3, 1);
      if (big) { C("#e0607a"); R(19, 14 + H, 2, 1); }
      if (lau > 0.5 && (still || Math.floor(lt / 260) % 4 === 1 || Math.floor(lt / 260) % 4 === 2)) { C("#8fd3ff"); R(17, 11 + H + (still ? 0 : Math.floor(lt / 260) % 4 - 1), 1, 2); }
    } else if (o.talk && Math.floor((o.t + (o.seed || 0)) / 140) % 2) { C("#4a1522"); R(19, 12 + H, 2, 2); }
    else if (L.fem) { C("#d4607a"); R(19, 12 + H, 2, 1); } else { C(skinDark); R(19, 12 + H, 2, 1); }
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
// Drawing one costs ~2 ms and the roster, chat rows, board cards and meeting chips ask again on every render,
// so the result is kept per look (a changed look is a new key); the oldest entries go once the cache is full.
const portraitCache = new Map();
function portraitOf(e, scale = 3, full = false, dir = "down", anim = "stand", frame = 0) {
  const emp = { look: e.look || { skin: "#f1c9a5", hair: "#3b2a20", hairStyle: "short", top: e.color, bottom: "#2f3548" }, color: e.color || (e.look && e.look.top) || "#61afef", seed: 0 };
  const key = JSON.stringify([emp.look, emp.color, scale, full, dir, anim, frame]);
  const hit = portraitCache.get(key);
  if (hit) return hit;
  const url = drawPortrait(emp, scale, full, dir, anim, frame);
  portraitCache.set(key, url);
  if (portraitCache.size > 300) portraitCache.delete(portraitCache.keys().next().value);
  return url;
}
function drawPortrait(emp, scale, full, dir, anim, frame) {
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

// --- dream theme (dream interpretation & visualisation studio) ---
THEMES.dream = { dark: true, wall: { face: "#3b2f6b", top: "#4b3d84", base: "#2e2454", base2: "#211a3d", edge: "#161130", inner: "#4a3c7c", innerLight: "#6152a0", innerDark: "#251e42" }, floors: { kitchen: "clouds", office: "dreamwood", meeting: "starCarpet", lounge: "clouds", archive: "nightTiles" }, rug: "moon" };
const DREAM = { night: "#1c1740", navy: "#262058", violet: "#6d5bb5", lilac: "#a99be0", cloud: "#e9e6f7", cloudDark: "#cfc9ec", gold: "#ffd166", goldDark: "#c9973b", pink: "#f4a6c8", teal: "#7fd8d0", wood: "#5a4a7a", woodDark: "#3f3358", woodLight: "#7a6a9e" };

function drawClouds(b, x, y, w, h) { // soft cloud floor
  b.fillStyle = "#d9d5ef"; b.fillRect(x, y, w, h);
  let s = 7;
  for (let i = 0; i < Math.floor((w * h) / 900); i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const px = x + (s % w), py = y + ((s >> 8) % h), cw = 14 + (s >> 16) % 18, ch = 6 + (s >> 20) % 5;
    if (px + cw > x + w || py + ch + 3 > y + h) continue;
    b.fillStyle = "#f3f1fb"; b.fillRect(px, py, cw, ch); b.fillRect(px + 4, py - 3, cw - 8, 3);
    b.fillStyle = "#c9c3e6"; b.fillRect(px, py + ch, cw, 1);
  }
}
function drawDreamWood(b, x, y, w, h) { // muted violet planks
  b.fillStyle = DREAM.wood; b.fillRect(x, y, w, h);
  for (let py = y; py < y + h; py += 16) {
    const row = (py - y) / 16;
    b.fillStyle = row % 2 ? "#564771" : "#5e4e80"; b.fillRect(x, py, w, 16);
    b.fillStyle = DREAM.woodDark; b.fillRect(x, py + 15, w, 1);
    const off = (row % 3) * 48; for (let px = x + 24 - off; px < x + w; px += 144) if (px >= x) b.fillRect(px, py, 1, 16);
    b.fillStyle = "rgba(255,255,255,.06)"; for (let px = x + 40 + off; px < x + w; px += 144) if (px + 6 < x + w) b.fillRect(px, py + 5, 6, 1);
  }
}
function drawStarCarpet(b, x, y, w, h) { // deep navy carpet with tiny stars
  b.fillStyle = DREAM.navy; b.fillRect(x, y, w, h);
  b.fillStyle = "#2d2766"; for (let py = y + 4; py < y + h; py += 8) for (let px = x + ((py / 8) % 2) * 4; px < x + w; px += 8) b.fillRect(px, py, 2, 2);
  b.fillStyle = "#fff3b0"; for (let i = 0; i < Math.floor((w * h) / 700); i++) { const px = x + ((i * 53) % (w - 4)), py = y + ((i * 97) % (h - 4)); b.fillRect(px + 1, py, 1, 3); b.fillRect(px, py + 1, 3, 1); }
}
function drawNightTiles(b, x, y, w, h) {
  for (let py = y; py < y + h; py += 32) for (let px = x; px < x + w; px += 32) { b.fillStyle = ((px + py) / 32) % 2 ? "#332b5c" : "#2d2652"; b.fillRect(px, py, 32, 32); b.fillStyle = "#211b40"; b.fillRect(px, py + 31, 32, 1); b.fillRect(px + 31, py, 1, 32); b.fillStyle = "rgba(255,255,255,.05)"; b.fillRect(px + 2, py + 2, 12, 1); }
}
let moonRug = null;
function drawMoonRug(b, x, y) { // crescent moon on a night-blue round rug
  if (!moonRug) {
    moonRug = document.createElement("canvas"); moonRug.width = 144; moonRug.height = 144;
    const g = moonRug.getContext("2d");
    disc(g, 72, 72, 70, "#3a2f6e"); disc(g, 72, 72, 64, DREAM.night); disc(g, 72, 72, 60, "#221c4a");
    g.fillStyle = DREAM.gold; for (let a = 0; a < 24; a++) g.fillRect(72 + Math.round(Math.cos(a / 24 * Math.PI * 2) * 62) - 1, 72 + Math.round(Math.sin(a / 24 * Math.PI * 2) * 62) - 1, 2, 2);
    disc(g, 72, 72, 34, DREAM.gold); disc(g, 84, 64, 30, "#221c4a");
    g.fillStyle = "#fff3b0"; for (const [sx, sy] of [[92, 84], [104, 72], [96, 100], [40, 108], [110, 96]]) { g.fillRect(sx, sy - 2, 1, 5); g.fillRect(sx - 2, sy, 5, 1); }
  }
  b.drawImage(moonRug, x, y);
}
function drawZ(b, x, y, col, s = 1) { // a floating "z"
  b.fillStyle = col; b.fillRect(x, y, 4 * s, s); b.fillRect(x + 2 * s, y + s, s, s); b.fillRect(x + s, y + 2 * s, s, s); b.fillRect(x, y + 3 * s, 4 * s, s);
}
function drawCrystalBall(b, cx, cy, r, t, seed = 0) { // glowing crystal ball on a small stand
  const pulse = (Math.floor((t + seed) / 400) % 4);
  b.fillStyle = `rgba(127,216,208,${0.10 + pulse * 0.04})`; b.fillRect(cx - r - 4, cy - r - 4, r * 2 + 8, r * 2 + 8);
  outlineRect(b, cx - r + 1, cy + r - 2, r * 2 - 2, 4, DREAM.goldDark);
  disc(b, cx, cy, r + 1, OUTLINE); disc(b, cx, cy, r, "#8fd3e8"); disc(b, cx + 1, cy + 1, r - 2, "#6fb8d8");
  b.fillStyle = "#e8fbff"; b.fillRect(cx - r + 2, cy - r + 3, 2, 3); b.fillRect(cx - r + 3, cy - r + 2, 3, 1);
  b.fillStyle = "#c9a5f0"; b.fillRect(cx - 1 + (pulse % 2), cy - 1, 3, 2); b.fillRect(cx + 2 - pulse, cy + 2, 2, 1);
}
function drawTeaBar(b, x, y, t) { // kitchen counter: herbal tea bar
  outlineRect(b, x, y + 6, 160, 26, DREAM.wood); b.fillStyle = DREAM.woodLight; b.fillRect(x, y + 6, 160, 4); b.fillStyle = DREAM.woodDark; b.fillRect(x, y + 30, 160, 2);
  for (let i = 0; i < 5; i++) { b.fillStyle = "#4e4070"; b.fillRect(x + i * 32 + 2, y + 14, 28, 16); b.fillStyle = DREAM.gold; b.fillRect(x + i * 32 + 13, y + 21, 6, 2); }
  // kettle with steam
  outlineRect(b, x + 8, y - 8, 22, 14, "#c9c9d6"); b.fillStyle = "#9d9db0"; b.fillRect(x + 8, y - 8, 22, 3); b.fillStyle = OUTLINE; b.fillRect(x + 30, y - 4, 6, 2); b.fillRect(x + 34, y - 8, 2, 5); b.fillRect(x + 14, y - 12, 10, 4); b.fillStyle = DREAM.gold; b.fillRect(x + 16, y - 11, 6, 2);
  b.fillStyle = "rgba(255,255,255,.55)"; for (let i = 0; i < 3; i++) { const ph = (Math.floor(t / 260) + i * 2) % 6; b.fillRect(x + 34 + (ph % 2), y - 14 - ph * 2, 2, 2); }
  // jars of herbs, moon mug, honey
  for (let i = 0; i < 3; i++) { const c = ["#7fb87f", "#c9a06a", "#a06ac9"][i]; outlineRect(b, x + 46 + i * 13, y - 10, 10, 16, "#dfe6f0"); b.fillStyle = c; b.fillRect(x + 48 + i * 13, y - 4, 6, 8); b.fillStyle = DREAM.wood; b.fillRect(x + 46 + i * 13, y - 12, 10, 3); }
  outlineRect(b, x + 92, y - 6, 10, 10, DREAM.night); b.fillStyle = DREAM.gold; b.fillRect(x + 96, y - 3, 3, 3); b.fillRect(x + 97, y - 4, 1, 1); b.fillStyle = OUTLINE; b.fillRect(x + 103, y - 3, 2, 4);
  outlineRect(b, x + 112, y - 8, 12, 12, "#f0b840"); b.fillStyle = "#c98a20"; b.fillRect(x + 114, y - 2, 8, 2); b.fillStyle = DREAM.wood; b.fillRect(x + 113, y - 11, 10, 3);
  // stack of dream journals at the end
  for (let i = 0; i < 3; i++) { outlineRect(b, x + 134 + (i % 2), y - 2 - i * 4, 20, 4, [DREAM.violet, DREAM.pink, DREAM.teal][i]); }
}
function drawGrandfatherClock(b, x, y, t = 0) { // fridge slot: tall clock with a swinging pendulum and a moon face
  outlineRect(b, x + 4, y - 30, 24, 60, DREAM.wood); b.fillStyle = DREAM.woodLight; b.fillRect(x + 4, y - 30, 24, 3); b.fillStyle = DREAM.woodDark; b.fillRect(x + 4, y + 26, 24, 4);
  disc(b, x + 16, y - 18, 9, OUTLINE); disc(b, x + 16, y - 18, 8, "#f4ecd8");
  b.fillStyle = DREAM.night; b.fillRect(x + 13, y - 24, 6, 3); disc(b, x + 20, y - 21, 3, "#f4ecd8"); // moon phase dial
  const d = new Date(); const ha = ((d.getHours() % 12) + d.getMinutes() / 60) / 12 * Math.PI * 2 - Math.PI / 2, ma = d.getMinutes() / 60 * Math.PI * 2 - Math.PI / 2;
  line(b, x + 16, y - 17, x + 16 + Math.cos(ha) * 4, y - 17 + Math.sin(ha) * 4, OUTLINE); line(b, x + 16, y - 17, x + 16 + Math.cos(ma) * 6, y - 17 + Math.sin(ma) * 6, OUTLINE);
  b.fillStyle = "#2a2340"; b.fillRect(x + 8, y - 6, 16, 30);
  const sw = Math.round(Math.sin(t / 500) * 4);
  b.fillStyle = DREAM.gold; b.fillRect(x + 15 + Math.round(sw / 2), y - 6, 2, 18); disc(b, x + 16 + sw, y + 14, 4, DREAM.goldDark); disc(b, x + 16 + sw, y + 14, 3, DREAM.gold);
}
function drawMoonTable(b, x, y, t = 0) { // roundTable slot: table with a crescent-moon top and a candle
  b.fillStyle = OUTLINE; b.fillRect(x + 6, y + 2, 52, 26); b.fillRect(x + 2, y + 6, 60, 18);
  b.fillStyle = DREAM.night; b.fillRect(x + 7, y + 3, 50, 24); b.fillRect(x + 3, y + 7, 58, 16);
  b.fillStyle = "#151033"; b.fillRect(x + 7, y + 23, 50, 4); b.fillStyle = OUTLINE; b.fillRect(x + 28, y + 26, 8, 6);
  disc(b, x + 22, y + 14, 8, DREAM.gold); disc(b, x + 25, y + 12, 7, DREAM.night);
  b.fillStyle = "#fff3b0"; b.fillRect(x + 40, y + 8, 1, 3); b.fillRect(x + 39, y + 9, 3, 1); b.fillRect(x + 48, y + 16, 1, 3); b.fillRect(x + 47, y + 17, 3, 1);
  b.fillStyle = "#f4ecd8"; b.fillRect(x + 40, y + 16, 3, 7); drawCandleFlame(b, x + 40, y + 16, t, 3);
}
function drawCloudStool(b, x, y) { // stool slot: cloud pouf
  outlineRect(b, x + 7, y + 14, 18, 8, DREAM.cloud); b.fillStyle = "#ffffff"; b.fillRect(x + 9, y + 12, 6, 3); b.fillRect(x + 17, y + 11, 6, 4); b.fillStyle = OUTLINE; b.fillRect(x + 9, y + 11, 6, 1); b.fillRect(x + 17, y + 10, 6, 1);
  b.fillStyle = DREAM.cloudDark; b.fillRect(x + 8, y + 20, 16, 2);
}
function drawDreamTable(b, x, y, t = 0) { // meeting table slot 128x48: interpretation table
  outlineRect(b, x + 4, y + 4, 120, 48, DREAM.wood); b.fillStyle = DREAM.woodLight; b.fillRect(x + 4, y + 4, 120, 4); b.fillStyle = DREAM.woodDark; b.fillRect(x + 4, y + 46, 120, 6);
  b.fillStyle = "#4e4272"; b.fillRect(x + 8, y + 10, 112, 34);
  // open dream dictionary
  outlineRect(b, x + 14, y + 14, 40, 26, "#f4ecd8"); b.fillStyle = "#d9d0b8"; b.fillRect(x + 34, y + 14, 1, 26);
  b.fillStyle = "#8a7fb8"; for (let i = 0; i < 5; i++) { b.fillRect(x + 17, y + 18 + i * 4, 14 - (i % 2) * 4, 1); b.fillRect(x + 37, y + 18 + i * 4, 13 - ((i + 1) % 2) * 4, 1); }
  b.fillStyle = DREAM.gold; b.fillRect(x + 40, y + 20, 6, 6); b.fillStyle = DREAM.night; b.fillRect(x + 43, y + 20, 5, 5);
  // crystal ball in the middle, tarot cards, candles
  drawCrystalBall(b, x + 70, y + 24, 8, t, 40);
  for (let i = 0; i < 3; i++) { const c = [DREAM.violet, DREAM.pink, DREAM.teal][i]; outlineRect(b, x + 88 + i * 9, y + 16 + (i % 2) * 2, 8, 12, "#f4ecd8"); b.fillStyle = c; b.fillRect(x + 90 + i * 9, y + 18 + (i % 2) * 2, 4, 8); b.fillStyle = DREAM.gold; b.fillRect(x + 91 + i * 9, y + 21 + (i % 2) * 2, 2, 2); }
  for (const [cx, seed] of [[x + 60, 1], [x + 112, 2]]) { b.fillStyle = "#f4ecd8"; b.fillRect(cx, y + 32, 3, 8); drawCandleFlame(b, cx, y + 32, t, seed); }
  b.fillStyle = "rgba(255,209,102,.08)"; b.fillRect(x + 8, y + 10, 112, 34);
}
function drawChaise(b, x, y) { // sofa slot: the analyst's velvet couch
  outlineRect(b, x + 2, y - 12, 34, 20, "#7a3b6b"); b.fillStyle = "#9a4f88"; b.fillRect(x + 2, y - 12, 34, 3); b.fillStyle = "#5e2c52"; b.fillRect(x + 4, y - 4, 30, 1);
  outlineRect(b, x, y + 6, 96, 22, "#7a3b6b"); b.fillStyle = "#9a4f88"; b.fillRect(x + 4, y + 8, 88, 10); b.fillStyle = "#5e2c52"; b.fillRect(x, y + 22, 96, 6); b.fillStyle = "#b565a2"; for (let i = 0; i < 5; i++) b.fillRect(x + 8 + i * 18, y + 10, 10, 1);
  outlineRect(b, x + 6, y + 2, 26, 10, DREAM.cloud); b.fillStyle = DREAM.cloudDark; b.fillRect(x + 8, y + 9, 22, 2); // pillow
  outlineRect(b, x + 56, y + 4, 36, 8, DREAM.lilac); b.fillStyle = DREAM.violet; for (let i = 0; i < 4; i++) b.fillRect(x + 58 + i * 9, y + 6, 4, 1); // folded blanket
  b.fillStyle = OUTLINE; b.fillRect(x + 4, y + 28, 4, 4); b.fillRect(x + 88, y + 28, 4, 4); b.fillStyle = DREAM.goldDark; b.fillRect(x + 5, y + 28, 2, 3); b.fillRect(x + 89, y + 28, 2, 3);
}
function drawCrystalStand(b, x, y, t = 0) { // coffee table slot: low table with a crystal ball and cards
  outlineRect(b, x + 12, y + 8, 72, 16, DREAM.wood); b.fillStyle = DREAM.woodLight; b.fillRect(x + 12, y + 8, 72, 2); b.fillStyle = OUTLINE; b.fillRect(x + 16, y + 24, 3, 6); b.fillRect(x + 77, y + 24, 3, 6);
  drawCrystalBall(b, x + 48, y + 8, 7, t, 90);
  outlineRect(b, x + 18, y + 10, 10, 12, "#f4ecd8"); b.fillStyle = DREAM.pink; b.fillRect(x + 20, y + 12, 6, 8); outlineRect(b, x + 26, y + 12, 10, 12, "#f4ecd8"); b.fillStyle = DREAM.violet; b.fillRect(x + 28, y + 14, 6, 8);
  outlineRect(b, x + 64, y + 12, 14, 8, DREAM.night); b.fillStyle = DREAM.gold; b.fillRect(x + 66, y + 14, 4, 4); b.fillStyle = DREAM.night; b.fillRect(x + 68, y + 14, 3, 3); // notebook with a moon
}
function drawDreamShelf(b, x, y) { // bookshelf slot: dream journals + an hourglass
  outlineRect(b, x + 2, y - 30, 28, 60, DREAM.wood); b.fillStyle = "#332a55"; b.fillRect(x + 4, y - 28, 24, 56);
  const cols = [DREAM.violet, DREAM.pink, DREAM.teal, DREAM.gold, "#6a8fd8", "#c96a8a"];
  for (let s = 0; s < 3; s++) {
    b.fillStyle = DREAM.woodLight; b.fillRect(x + 4, y - 12 + s * 18 - 2, 24, 2);
    if (s === 1) { b.fillStyle = OUTLINE; b.fillRect(x + 12, y - 27 + s * 18, 8, 1); b.fillRect(x + 12, y - 16 + s * 18, 8, 1); b.fillStyle = "#e8fbff"; b.fillRect(x + 13, y - 26 + s * 18, 6, 4); b.fillRect(x + 13, y - 20 + s * 18, 6, 4); b.fillStyle = DREAM.gold; b.fillRect(x + 15, y - 21 + s * 18, 2, 3); continue; }
    for (let i = 0; i < 4; i++) { const c = cols[(s * 4 + i) % cols.length]; outlineRect(b, x + 5 + i * 6, y - 26 + s * 18 - (i % 2), 5, 13 + (i % 2), c); b.fillStyle = "#fff3b0"; b.fillRect(x + 7 + i * 6, y - 22 + s * 18, 1, 1); }
  }
}
function drawMoonLamp(b, x, y, t = 0) { // lamp slot: floor lamp with a glowing moon
  const glow = 0.10 + (Math.floor(t / 700) % 2) * 0.04;
  b.fillStyle = `rgba(255,243,176,${glow})`; b.fillRect(x - 2, y - 30, 36, 34);
  outlineRect(b, x + 8, y + 22, 16, 6, DREAM.woodDark); b.fillStyle = OUTLINE; b.fillRect(x + 14, y - 12, 4, 34); b.fillStyle = DREAM.goldDark; b.fillRect(x + 15, y - 11, 2, 32);
  disc(b, x + 16, y - 16, 11, OUTLINE); disc(b, x + 16, y - 16, 10, "#fff3b0"); b.fillStyle = "#f0dc8a"; b.fillRect(x + 10, y - 20, 4, 3); b.fillRect(x + 18, y - 14, 5, 4); b.fillRect(x + 12, y - 10, 3, 2);
}
function drawApothecary(b, x, y) { // cabinets slot: cabinet of little drawers and labelled jars
  outlineRect(b, x + 2, y - 20, 92, 46, DREAM.wood); b.fillStyle = DREAM.woodLight; b.fillRect(x + 2, y - 20, 92, 3);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) { outlineRect(b, x + 6 + c * 15, y - 14 + r * 12, 12, 9, "#6a5a92"); b.fillStyle = DREAM.gold; b.fillRect(x + 11 + c * 15, y - 10 + r * 12, 2, 1); b.fillStyle = "#f4ecd8"; b.fillRect(x + 8 + c * 15, y - 13 + r * 12, 8, 2); }
  for (let i = 0; i < 4; i++) { const c = ["#7fb87f", "#a06ac9", "#f0b840", "#7fd8d0"][i]; outlineRect(b, x + 10 + i * 22, y - 34, 12, 14, "#dfe6f0"); b.fillStyle = c; b.fillRect(x + 12 + i * 22, y - 28, 8, 7); b.fillStyle = DREAM.wood; b.fillRect(x + 10 + i * 22, y - 36, 12, 3); b.fillStyle = "#f4ecd8"; b.fillRect(x + 12 + i * 22, y - 31, 8, 2); }
}
function drawPillowPile(b, x, y) { // boxes slot: pile of pillows and a blanket
  outlineRect(b, x + 4, y + 14, 44, 12, DREAM.violet); b.fillStyle = DREAM.lilac; b.fillRect(x + 6, y + 16, 40, 2);
  outlineRect(b, x + 10, y + 4, 34, 12, DREAM.pink); b.fillStyle = "#f8c6dc"; b.fillRect(x + 12, y + 6, 30, 2);
  outlineRect(b, x + 16, y - 6, 28, 12, DREAM.cloud); b.fillStyle = "#ffffff"; b.fillRect(x + 18, y - 4, 24, 2); b.fillStyle = DREAM.cloudDark; b.fillRect(x + 18, y + 3, 24, 1);
  outlineRect(b, x + 44, y + 8, 18, 18, DREAM.teal); b.fillStyle = "#5fb8b0"; for (let i = 0; i < 4; i++) b.fillRect(x + 46, y + 11 + i * 4, 14, 1);
  drawZ(b, x + 30, y - 14, DREAM.gold, 1); drawZ(b, x + 36, y - 20, DREAM.gold, 1);
}
function drawEasel(b, x, y, t = 0) { // printer slot: easel where a dream is being painted
  b.fillStyle = OUTLINE; b.fillRect(x + 20, y - 8, 3, 38); b.fillRect(x + 42, y - 8, 3, 38); b.fillRect(x + 30, y - 4, 3, 34); b.fillRect(x + 16, y + 14, 34, 2);
  b.fillStyle = DREAM.woodLight; b.fillRect(x + 21, y - 7, 1, 36); b.fillRect(x + 43, y - 7, 1, 36);
  outlineRect(b, x + 14, y - 24, 38, 30, "#f4ecd8");
  // the painting: night sky, moon, hills; a brush stroke that "appears" over time
  b.fillStyle = DREAM.night; b.fillRect(x + 16, y - 22, 34, 20); b.fillStyle = "#6a3b8a"; b.fillRect(x + 16, y - 8, 34, 6); b.fillStyle = "#4a2a6a"; b.fillRect(x + 16, y - 6, 34, 8);
  disc(b, x + 40, y - 16, 4, DREAM.gold); b.fillStyle = "#fff3b0"; b.fillRect(x + 20, y - 18, 1, 1); b.fillRect(x + 26, y - 20, 1, 1); b.fillRect(x + 31, y - 15, 1, 1);
  const prog = Math.floor(t / 300) % 30; b.fillStyle = DREAM.pink; b.fillRect(x + 18, y - 12, Math.min(28, prog), 2); b.fillStyle = DREAM.teal; b.fillRect(x + 18, y - 9, Math.max(0, Math.min(28, prog - 8)), 1);
  // palette and brush
  disc(b, x + 8, y + 22, 7, OUTLINE); disc(b, x + 8, y + 22, 6, "#c9a781"); for (const [ox, oy, c] of [[-3, -2, DREAM.pink], [1, -3, DREAM.teal], [3, 1, DREAM.gold], [-2, 2, DREAM.violet]]) { b.fillStyle = c; b.fillRect(x + 8 + ox, y + 22 + oy, 2, 2); }
  b.fillStyle = OUTLINE; b.fillRect(x + 52, y + 16, 2, 12); b.fillStyle = DREAM.pink; b.fillRect(x + 52, y + 14, 2, 3);
}
function drawHourglass(b, x, y, t = 0) { // cooler slot: big hourglass with falling sand
  outlineRect(b, x + 6, y - 26, 20, 4, DREAM.woodDark); outlineRect(b, x + 6, y + 22, 20, 4, DREAM.woodDark);
  b.fillStyle = OUTLINE; b.fillRect(x + 7, y - 22, 2, 44); b.fillRect(x + 23, y - 22, 2, 44);
  b.fillStyle = "#e8fbff"; for (let i = 0; i < 20; i++) { const w = Math.abs(i - 10) < 2 ? 2 : Math.min(14, 4 + Math.abs(i - 10) * 2); b.fillRect(x + 16 - w / 2, y - 22 + i * 2, w, 2); b.fillRect(x + 16 - w / 2, y + 2 + (19 - i) * 2 - 20 + 20, 0, 0); }
  const f = (t / 8000) % 1; // top empties, bottom fills
  b.fillStyle = DREAM.gold;
  const topH = Math.round((1 - f) * 14), botH = Math.round(f * 14);
  for (let i = 0; i < topH; i++) { const row = 9 - i; const w = Math.min(12, 2 + row * 2); if (row >= 0) b.fillRect(x + 16 - w / 2, y - 22 + row * 2, w, 2); }
  for (let i = 0; i < botH; i++) { const row = 19 - i; const w = Math.min(12, 2 + (19 - row) * 2); b.fillRect(x + 16 - w / 2, y - 22 + row * 2, w, 2); }
  b.fillRect(x + 15, y - 4 + (Math.floor(t / 120) % 3), 2, 4);
}
function drawDreamcatcher(b, x, y, t = 0) { // coffeeStation slot: dreamcatcher on a stand, feathers swaying
  outlineRect(b, x + 8, y + 22, 16, 6, DREAM.woodDark); b.fillStyle = OUTLINE; b.fillRect(x + 14, y - 30, 4, 52); b.fillStyle = DREAM.goldDark; b.fillRect(x + 15, y - 29, 2, 50);
  disc(b, x + 16, y - 12, 12, OUTLINE); disc(b, x + 16, y - 12, 11, DREAM.wood); disc(b, x + 16, y - 12, 9, DREAM.night);
  b.fillStyle = DREAM.lilac; for (let a = 0; a < 8; a++) line(b, x + 16, y - 12, x + 16 + Math.cos(a / 8 * Math.PI * 2) * 9, y - 12 + Math.sin(a / 8 * Math.PI * 2) * 9, DREAM.lilac);
  disc(b, x + 16, y - 12, 2, DREAM.gold);
  const sway = Math.round(Math.sin(t / 600) * 2);
  for (const [ox, len, c] of [[-6, 12, DREAM.pink], [0, 16, DREAM.teal], [6, 12, DREAM.gold]]) { b.fillStyle = OUTLINE; b.fillRect(x + 16 + ox + sway, y - 2, 1, 6); b.fillStyle = c; b.fillRect(x + 15 + ox + sway, y + 4, 3, len); b.fillStyle = shade(c, -30); b.fillRect(x + 16 + ox + sway, y + 4, 1, len); }
}
WALL_ART.dream_sky = (b, t) => { // night sky in the windows, whatever the time of day
  for (const wx of [9 * TILE, 17 * TILE]) {
    b.fillStyle = "#2a2150"; b.fillRect(wx - 4, 4, 104, 48); b.fillStyle = "#1a153a"; b.fillRect(wx - 4, 50, 104, 3);
    const g = b.createLinearGradient(0, 8, 0, 48); g.addColorStop(0, "#120e2c"); g.addColorStop(1, "#3a2d6e"); b.fillStyle = g; b.fillRect(wx, 8, 96, 40);
    b.fillStyle = "#fff8d0"; for (let i = 0; i < 16; i++) if ((t / 700 + i * 1.3) % 5 < 4) b.fillRect(wx + 3 + ((i * 41) % 90), 10 + ((i * 17) % 30), 1 + (i % 4 === 0 ? 1 : 0), 1);
    disc(b, wx + 74, 18, 6, "#fff3b0"); disc(b, wx + 77, 16, 5, "#120e2c");
    b.save(); b.beginPath(); b.rect(wx, 8, 96, 40); b.clip(); b.fillStyle = "rgba(233,230,247,.35)"; const cx = wx + ((t / 160) % 140) - 40; b.fillRect(cx, 30, 26, 5); b.fillRect(cx + 6, 27, 12, 3); b.fillRect(cx + 50, 14, 18, 4); b.restore();
    b.fillStyle = "#2a2150"; b.fillRect(wx + 47, 8, 2, 40); b.fillRect(wx, 27, 96, 2);
  }
};
WALL_ART.dream_moons = wallAt(0, (b, t) => { // moon phases along the kitchen wall + floating z's
  for (let i = 0; i < 5; i++) { const px = 22 + i * 36; disc(b, px, 26, 9, OUTLINE); disc(b, px, 26, 8, "#fff3b0"); if (i !== 2) { const k = i < 2 ? 1 : -1; disc(b, px + k * (i === 0 || i === 4 ? 4 : 7), 26, 8, THEMES.dream.wall.face); } }
  for (let i = 0; i < 3; i++) { const ph = (t / 900 + i * 1.1) % 3; drawZ(b, 150 + i * 14 + Math.round(ph), 40 - Math.round(ph * 6), `rgba(255,243,176,${0.9 - ph * 0.25})`, 1 + (i === 2 ? 1 : 0)); }
});
WALL_ART.dream_eye = wallAt(14, (b, t) => { // the all-seeing eye
  const ex = 14 * TILE + 16; b.fillStyle = OUTLINE; b.fillRect(ex - 18, 22, 36, 12); b.fillRect(ex - 14, 18, 28, 4); b.fillRect(ex - 14, 34, 28, 4); b.fillRect(ex - 8, 14, 16, 4); b.fillRect(ex - 8, 38, 16, 4);
  b.fillStyle = "#f4ecd8"; b.fillRect(ex - 16, 23, 32, 10); b.fillRect(ex - 12, 19, 24, 4); b.fillRect(ex - 12, 33, 24, 4);
  const look = Math.floor(t / 1700) % 3 - 1; disc(b, ex + look * 2, 28, 5, "#5a3d9a"); disc(b, ex + look * 2, 28, 3, OUTLINE); b.fillStyle = "#fff"; b.fillRect(ex + look * 2 - 2, 26, 1, 1);
  b.fillStyle = DREAM.gold; for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; b.fillRect(ex + Math.round(Math.cos(a) * 24) - 1, 28 + Math.round(Math.sin(a) * 16) - 1, 2, 2); }
}, 16);
WALL_ART.dream_constellation = wallAt(23, (b, t) => {
  const cx = 23 * TILE + 10; b.fillStyle = "#fff8d0"; const pts = [[6, 12], [30, 8], [52, 18], [78, 10], [96, 26], [126, 14], [150, 22]];
  for (let i = 0; i < pts.length - 1; i++) { const [ax, ay] = pts[i], [bx, by] = pts[i + 1]; for (let k = 0; k < 10; k += 2) b.fillRect(cx + Math.round(ax + (bx - ax) * k / 10), 10 + Math.round(ay + (by - ay) * k / 10), 1, 1); }
  pts.forEach(([px, py], i) => { const tw = Math.floor(t / 400 + i) % 4 === 0; b.fillStyle = tw ? DREAM.gold : "#fff8d0"; b.fillRect(cx + px - 1, 10 + py - 1, 3, 3); });
}, -4);
WALL_ART.dream_painting = wallAt(28, (b) => { // a framed dream painting
  outlineRect(b, 28 * TILE - 6, 8, 36, 40, DREAM.goldDark); b.fillStyle = DREAM.night; b.fillRect(28 * TILE - 2, 12, 28, 32); b.fillStyle = "#6a3b8a"; b.fillRect(28 * TILE - 2, 32, 28, 12); disc(b, 28 * TILE + 16, 22, 5, DREAM.gold); b.fillStyle = DREAM.pink; b.fillRect(28 * TILE + 2, 36, 12, 2);
}, 7);
WALL_ART.dream_clock = wallClock;
PROPS.dream = { counter: drawTeaBar, fridge: drawGrandfatherClock, roundTable: drawMoonTable, stool: drawCloudStool, meetingTable: drawDreamTable, sofa: drawChaise, coffeeTable: drawCrystalStand, bookshelf: drawDreamShelf, lamp: drawMoonLamp, cabinets: drawApothecary, boxes: drawPillowPile, printer: drawEasel, cooler: drawHourglass, coffeeStation: drawDreamcatcher };
THEME_NAMES.push("dream");

// ---------- what finished work unlocks (web/progress.js): wall pieces, in this order; see POLayout.progressWall ----------
WALL_ART.progress_poster = wallAt(5, (b) => { // framed poster
  outlineRect(b, 184, 10, 26, 34, "#e8d9b0"); b.fillStyle = "#3f7cc9"; b.fillRect(188, 14, 18, 14);
  b.fillStyle = "#ffd166"; b.fillRect(194, 17, 6, 6); b.fillStyle = "#2b2b2b"; b.fillRect(188, 32, 18, 2); b.fillRect(191, 37, 12, 2);
}, -21);
WALL_ART.progress_plant = wallAt(7, (b, t) => { // hanging plant
  const sway = Math.round(Math.sin(t / 1400));
  b.fillStyle = "#6b4a2b"; b.fillRect(243, 8, 2, 12);
  outlineRect(b, 236, 20, 16, 9, "#b4593a");
  b.fillStyle = "#3a9d5d"; b.fillRect(234 + sway, 26, 5, 14); b.fillRect(250 + sway, 26, 5, 18); b.fillRect(241, 28, 6, 10);
  b.fillStyle = "#5ac27a"; b.fillRect(235 + sway, 30, 2, 6); b.fillRect(251 + sway, 32, 2, 8);
});
WALL_ART.progress_espresso = wallAt(9, (b, t) => { // shelf with a golden espresso machine
  b.fillStyle = "#5c3d22"; b.fillRect(296, 40, 46, 4); b.fillStyle = "#8a5a32"; b.fillRect(296, 40, 46, 1);
  outlineRect(b, 304, 22, 30, 18, "#d9a521"); b.fillStyle = "#ffd166"; b.fillRect(304, 22, 30, 3);
  b.fillStyle = "#7a5410"; b.fillRect(310, 28, 8, 6); b.fillStyle = "#f5f5f5"; b.fillRect(322, 31, 6, 7);
  b.fillStyle = Math.floor(t / 700) % 2 ? "#4ade80" : "#1f7a3f"; b.fillRect(328, 26, 2, 2);
});
WALL_ART.progress_trophies = wallAt(11, (b, t) => { // trophy shelf
  b.fillStyle = "#5c3d22"; b.fillRect(354, 40, 52, 4); b.fillStyle = "#8a5a32"; b.fillRect(354, 40, 52, 1);
  for (let i = 0; i < 3; i++) {
    const x = 358 + i * 16, h = i === 1 ? 20 : 15;
    b.fillStyle = OUTLINE; b.fillRect(x - 1, 39 - h, 12, h + 1);
    b.fillStyle = "#ffd166"; b.fillRect(x, 40 - h, 10, h - 6); b.fillRect(x + 3, 34, 4, 5); b.fillRect(x + 1, 38, 8, 2);
    b.fillStyle = "#fff3b0"; b.fillRect(x + 1, 41 - h, 2, h - 8);
  }
  if (Math.floor(t / 1200) % 4 === 0) { b.fillStyle = "#fff"; b.fillRect(377, 14, 1, 5); b.fillRect(375, 16, 5, 1); }
});
WALL_ART.progress_neon = wallAt(17, (b, t) => { // neon sign
  const on = Math.floor(t / 600) % 6 !== 0, c = on ? "#ff5fa2" : "#7a2f52";
  b.fillStyle = OUTLINE; b.fillRect(548, 14, 88, 30);
  b.fillStyle = "#1a1224"; b.fillRect(550, 16, 84, 26);
  b.fillStyle = c; b.fillRect(552, 18, 80, 2); b.fillRect(552, 38, 80, 2); b.fillRect(552, 18, 2, 22); b.fillRect(630, 18, 2, 22);
  b.fillStyle = on ? "#7dd3fc" : "#3b566b"; // a lightning bolt and a star
  b.fillRect(574, 22, 6, 3); b.fillRect(570, 25, 6, 3); b.fillRect(574, 28, 6, 3); b.fillRect(570, 31, 6, 3); b.fillRect(568, 34, 4, 2);
  b.fillStyle = on ? "#ffd166" : "#6b5a2b"; b.fillRect(603, 21, 4, 14); b.fillRect(598, 26, 14, 4); b.fillRect(600, 23, 10, 10);
});

// ---------- day cycle & office events ----------
// Night: a dim blue layer over the whole office, and idle people sometimes doze on the lounge sofa.
// Events: every few minutes something small happens (pizza, cake, printer jam, blackout). Only idle people react;
// anyone who starts working goes straight back to the desk (setStatus clears the event spot). Switch: localStorage po.events.
const officeEventsOn = () => { try { return localStorage.getItem("po.events") !== "0"; } catch { return true; } };

const EVENT_KINDS = ["pizza", "cake", "printer", "blackout"];
// Where people gather comes from the furniture (POLayout events): the tiles around a round table (pizza / cake), around a printer (jam).
// No table or no printer in the office: that event is simply skipped.

Object.assign(Office.prototype, {
  isNapping(e) { return !!e.napSpot && e.napSpot === e.spot && e.status === "idle" && !e.path.length; },

  // At night an idle employee may curl up on a free sofa seat for a while.
  tryNap(e, now) {
    if (!isNight() || e.meet || this.evt || Math.random() > 0.5) return false;
    const taken = new Set(this.emps.filter((o) => o !== e && o.spot).map((o) => o.spot.key));
    const s = this.spots.find((x) => x.group === "sofa" && !taken.has(x.key));
    if (!s || !this.goToSpot(e, s)) return false;
    e.spot = s; e.napSpot = s;
    return true;
  },

  arrivedExtra(e, now) {
    if (e.napSpot && e.napSpot === e.spot) e.restUntil = now + rand(30000, 70000);
    else if (e.spot?.evt) {
      e.restUntil = Math.max(e.restUntil, this.evt ? this.evt.until : now);
      if (e.spot.evt === "pizza" || e.spot.evt === "cake") e.bubble = { kind: "party", until: now + 3000 };
      const text = Math.random() < 0.6 ? this.eventLine(e.spot.evt) : "";
      if (text && !e.sayLater) e.sayLater = { at: now + rand(300, 1400), text };
    }
  },

  tickEvents(now) {
    if (this.evNext == null) this.evNext = now + rand(3 * 60000, 8 * 60000);
    if (this.evt) {
      if (now > this.evt.until || !officeEventsOn()) this.endEvent(now);
      return;
    }
    if (now < this.evNext) return;
    if (!officeEventsOn() || this.offline || this.meetingOn || !this.emps.length) { this.evNext = now + 30000; return; }
    const kind = EVENT_KINDS[Math.floor(Math.random() * EVENT_KINDS.length)];
    if (!this.startEvent(kind, now)) this.evNext = now + 30000;
  },

  // Returns false (and does nothing) when nobody idle is around to see it. Callable from the console: office.startEvent("pizza").
  startEvent(kind, now = performance.now()) {
    if (this.evt || !EVENT_KINDS.includes(kind)) return false;
    const idle = this.emps.filter((e) => e.status === "idle" && !e.meet && !e.entering);
    if (!idle.length) return false;
    const ev = { kind, t0: now, until: now + (kind === "blackout" ? 5000 : rand(22000, 32000)) };
    this.evt = ev; // eventLine() reads it
    if (kind === "blackout") {
      idle.forEach((e, i) => {
        e.restUntil = Math.max(e.restUntil, ev.until + 1000);
        const text = this.eventLine(kind);
        if (text && i < 5) e.sayLater = { at: now + 500 + i * 700 + rand(0, 400), text };
      });
    } else {
      const sites = (kind === "printer" ? this.scene.build.events.printer : this.scene.build.events.food).filter((s) => s.tiles.length).sort(() => Math.random() - 0.5);
      let n = 0;
      for (const site of sites) {
      ev.site = site;
      const tiles = site.tiles;
      for (const e of idle.sort(() => Math.random() - 0.5)) {
        if (n >= (kind === "printer" ? 2 : 4)) break;
        const tile = tiles.find(([x, y]) => !this.isBlocked(x, y, e));
        if (!tile) break;
        const was = e.spot;
        const spot = { key: "evt" + n, tx: tile[0], ty: tile[1], dir: "up", anim: kind === "printer" ? "think" : "stand", evt: kind };
        e.spot = spot;
        if (this.goToSpot(e, spot)) {
          e.bubble = null; e.napSpot = null;
          const text = this.eventLine(kind);
          if (text) e.sayLater = { at: now + 300 + n * 800 + rand(0, 500), text };
          n++;
        } else e.spot = was;
      }
      if (n) break;
      }
      if (!n) { this.evt = null; return false; }
    }
    this.evNext = now + rand(3 * 60000, 8 * 60000);
    if (typeof toast === "function") toast(t("ui.events." + kind));
    return true;
  },

  endEvent(now) {
    this.evt = null;
    for (const e of this.emps) if (e.spot?.evt) { e.spot = null; e.restUntil = now + rand(1000, 5000); }
  },

  // Table / printer props, depth-sorted with the rest of the scene.
  eventItems(t) {
    const ev = this.evt;
    if (!ev || ev.kind === "blackout" || !ev.site) return [];
    const s = ev.site;
    if (ev.kind === "printer") return [{ y: (s.ty + 1) * TILE + 24, draw: (b) => drawPrinterJam(b, s.tx * TILE, s.ty * TILE, t) }];
    return [{ y: s.ty * TILE + 30, draw: (b) => (ev.kind === "pizza" ? drawPizza : drawCake)(b, (s.tx + 1) * TILE, s.ty * TILE + 10, t) }];
  },
});

function drawPizza(b, x, y, t) {
  outlineRect(b, x - 14, y - 4, 28, 14, "#b98a52");
  b.fillStyle = "#e8c07a"; b.fillRect(x - 12, y - 2, 24, 10);
  b.fillStyle = "#d9432f"; b.fillRect(x - 6, y, 4, 3); b.fillRect(x + 3, y + 3, 4, 3); b.fillRect(x - 1, y + 4, 3, 2);
  if (!REDUCED_MOTION.matches && Math.floor(t / 500) % 2) { b.fillStyle = "rgba(255,255,255,.7)"; b.fillRect(x - 4, y - 10, 2, 5); b.fillRect(x + 4, y - 12, 2, 5); }
}

function drawCake(b, x, y, t) {
  outlineRect(b, x - 12, y - 2, 24, 12, "#f4a8c0");
  b.fillStyle = "#fff"; b.fillRect(x - 12, y - 2, 24, 4);
  for (let i = 0; i < 3; i++) {
    b.fillStyle = "#61afef"; b.fillRect(x - 8 + i * 8, y - 8, 2, 6);
    if (REDUCED_MOTION.matches || Math.floor(t / 250 + i) % 3) { b.fillStyle = "#ffd166"; b.fillRect(x - 8 + i * 8, y - 11, 2, 3); }
  }
}

function drawPrinterJam(b, x, y, t) {
  const on = REDUCED_MOTION.matches || Math.floor(t / 300) % 2;
  b.fillStyle = on ? "#f87171" : "#5a1a1a"; b.fillRect(x + 42, y - 6, 3, 2);
  b.fillStyle = "#fff"; b.fillRect(x + 20, y + 30, 10, 6); b.fillRect(x + 36, y + 32, 8, 5);
  if (!REDUCED_MOTION.matches) for (let i = 0; i < 3; i++) {
    const p = (t / 900 + i / 3) % 1;
    b.fillStyle = `rgba(150,150,150,${0.6 * (1 - p)})`; b.fillRect(x + 26 + i * 6 + Math.sin(p * 6 + i) * 3, y - 14 - p * 22, 5, 5);
  }
  b.fillStyle = OUTLINE; b.fillRect(x + 28, y - 44, 8, 14); b.fillStyle = "#f87171"; b.fillRect(x + 29, y - 43, 6, 12);
  b.fillStyle = "#fff"; b.fillRect(x + 31, y - 41, 2, 6); b.fillRect(x + 31, y - 33, 2, 2);
}

// "z z z" above a dozing person; static under reduced motion.
function drawZzz(b, e, t) {
  const still = REDUCED_MOTION.matches;
  const f = still ? 0 : (t / 700 + e.seed) % 3;
  b.fillStyle = "#dbe6ff";
  for (let i = 0; i < 3; i++) {
    const p = still ? i : (f + i) % 3, s = 2 + Math.floor(p);
    b.globalAlpha = still ? 1 : 1 - p / 3.2;
    b.fillRect(e.x + 22 + p * 5, e.y - 14 - p * 7, s + 2, 1);
    b.fillRect(e.x + 22 + p * 5, e.y - 14 - p * 7 + s + 1, s + 2, 1);
    b.fillRect(e.x + 23 + p * 5 + s - 1, e.y - 13 - p * 7, 1, s);
  }
  b.globalAlpha = 1;
}

// Night layer: a flat dim blue tint over the whole office. A blackout goes much darker for a few seconds.
function drawDayNight(b, t, ev) {
  let a = nightDarkness();
  if (ev && ev.kind === "blackout") {
    const p = performance.now() - ev.t0;
    const flicker = !REDUCED_MOTION.matches && p < 900 && Math.floor(p / 120) % 2 === 0 ? 0.25 : 0;
    a = Math.max(a, (p < 4200 ? 0.72 : 0.72 * Math.max(0, 5000 - p) / 800) - flicker);
  }
  if (a <= 0.01) return;
  b.fillStyle = `rgba(8,14,44,${a.toFixed(3)})`;
  b.fillRect(0, 0, LW, LH);
}
