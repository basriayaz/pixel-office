// Office layout as data: every movable piece of furniture is a record {id, type, tx, ty, dir?, v?, water?, emp?}.
// Everything the office needs is derived from those records: blocked tiles, hangout spots, meeting places, seats, event tiles.
// Rooms, walls, doors and the two windows are fixed. The wall decor (posters, clocks, shelves, screens ...) hangs on the top wall band as
// movable pieces (WALL below: every theme's own pieces, any of them can hang in any office), the lounge rug is a movable piece too, and
// a floor piece can wear another theme's look (`skin`). Pure logic (no drawing, no DOM): the browser loads this as a
// classic script (window.POLayout), the server loads the very same file to validate what a browser sends (globalThis.POLayout).
(() => {
  const COLS = 30, ROWS = 17;
  const MAX_EMP = 12;        // the office seats this many colleagues
  const MAX_ITEMS = 240, MAX_DESKS = 16;
  const ENTRANCE = { tx: 14, ty: 16 }; // doormat at the bottom edge of the open office; new hires walk in from below
  const key = (x, y) => x + "," + y;

  // Rooms: x0..x1, y0..y1 in tiles (inclusive). The floor of a room is the only place furniture may stand.
  const ROOMS = [
    { key: "kitchen", x0: 0, y0: 2, x1: 6, y1: 8, floor: "tiles" },
    { key: "office", x0: 8, y0: 2, x1: 21, y1: 16, floor: "wood" },
    { key: "meeting", x0: 23, y0: 2, x1: 29, y1: 8, floor: "carpet" },
    { key: "lounge", x0: 0, y0: 10, x1: 6, y1: 16, floor: "wood" },
    { key: "archive", x0: 23, y0: 10, x1: 29, y1: 16, floor: "concrete" },
  ];
  const DOORS = [[7, 5], [7, 6], [22, 5], [22, 6], [3, 9], [4, 9], [25, 9], [26, 9], [7, 12], [7, 13], [22, 12], [22, 13]];
  // each doorway: its tiles and the tiles just in front of it on both sides (at least one free, reachable tile per side)
  const DOOR_GROUPS = [
    { tiles: [[7, 5], [7, 6]], a: [[6, 5], [6, 6]], b: [[8, 5], [8, 6]] },
    { tiles: [[22, 5], [22, 6]], a: [[21, 5], [21, 6]], b: [[23, 5], [23, 6]] },
    { tiles: [[7, 12], [7, 13]], a: [[6, 12], [6, 13]], b: [[8, 12], [8, 13]] },
    { tiles: [[22, 12], [22, 13]], a: [[21, 12], [21, 13]], b: [[23, 12], [23, 13]] },
    { tiles: [[3, 9], [4, 9]], a: [[3, 8], [4, 8]], b: [[3, 10], [4, 10]] },
    { tiles: [[25, 9], [26, 9]], a: [[25, 8], [26, 8]], b: [[25, 10], [26, 10]] },
  ];
  // spots that belong to the fixed wall decor (the two windows)
  const FIXED_SPOTS = [
    { key: "window", tx: 20, ty: 2, dir: "up", anim: "stand" },
    { key: "window2", tx: 16, ty: 2, dir: "up", anim: "gaze" },
  ];

  // The top wall band (rows 0-1) carries the wall decor. The windows are part of the wall: nothing hangs over them.
  const WINDOW_TILES = new Set([9, 10, 11, 17, 18, 19]);
  // The looks an office can have (the themes). Floor pieces and rugs are drawn in the office's theme unless a piece names a `skin`.
  const THEMES = ["default", "football", "fashion", "gothic", "music", "travel", "dream"];
  // Wall pieces: group -> piece -> [default tiles (one piece per tile), width in tiles, layer]. A piece's type is "<group>_<piece>".
  // Width 0 = ambient decor that spans the wall and takes no tiles (string lights, stained glass ...): each one at most once, drawn under
  // the other pieces ("under", the default) or over them ("over"). The groups are the themes plus "progress": the pieces finished work
  // unlocks. The artwork lives in office.js (WALL_ART).
  const WALL = {
    default: { cabinets: [[0], 6], poster: [[13], 1], clock: [[15], 1], shelf: [[20], 2], tv: [[24], 4], whiteboard: [[28], 2] },
    football: { banner: [[0], 6], jersey: [[13], 2], clock: [[15], 1], trophies: [[20], 2], scoreboard: [[24], 4], tactics: [[28], 2], pennants: [[0], 0] },
    fashion: { atelier: [[0], 6], moodboard: [[6], 3], poster: [[13], 1], clock: [[15], 1], hats: [[20], 2], mirror: [[24], 4], lights: [[0], 0, "over"] },
    gothic: { torch: [[1, 3, 26, 28], 1], portrait: [[13], 1], chandelier: [[14], 2], clock: [[16], 1], moon: [[20], 1], glass: [[0], 0], cobwebs: [[0], 0] },
    music: { foam: [[0], 5], clock: [[6], 1], speaker: [[8, 20], 1], plaque: [[13], 2], onair: [[15], 2], awards: [[23], 3], counter: [[26], 4] },
    travel: { bunting: [[0], 7], poster: [[7], 2], map: [[12], 5], clock: [[21], 1], departures: [[23], 7] },
    dream: { moons: [[0], 6], eye: [[14], 2], clock: [[21], 1], constellation: [[23], 5], painting: [[28], 2], sky: [[0], 0] },
    progress: { poster: [[], 1], plant: [[], 1], espresso: [[], 2], trophies: [[], 2], neon: [[], 3] }, // (unlocked in this order; placed where they fit)
  };
  const PROGRESS_ORDER = ["poster", "plant", "espresso", "trophies", "neon"];
  const PROGRESS_NEAR = { poster: 6, plant: 7, espresso: 22, trophies: 22, neon: 7 }; // the tile each prefers (the nearest free one is taken)
  // The lounge rug: 5x5 tiles, lies under everything. `deco` tiles must be floor; two rugs may not overlap; furniture may stand on it.
  const RUG = { w: 5, h: 5, def: [0, 11] };
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  const doors = new Set(DOORS.map(([x, y]) => key(x, y)));
  const floor = new Set();
  for (const r of ROOMS) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) floor.add(key(x, y));
  const WALLS = new Set(); // wall band, interior walls (doors excepted)
  for (let x = 0; x < COLS; x++) { WALLS.add(key(x, 0)); WALLS.add(key(x, 1)); }
  for (let y = 2; y < ROWS; y++) { if (!doors.has(key(7, y))) WALLS.add(key(7, y)); if (!doors.has(key(22, y))) WALLS.add(key(22, y)); }
  for (let x = 0; x <= 6; x++) if (!doors.has(key(x, 9))) WALLS.add(key(x, 9));
  for (let x = 23; x < COLS; x++) if (!doors.has(key(x, 9))) WALLS.add(key(x, 9));

  // ---------- furniture types ----------
  // fp: tiles the piece blocks (relative to the anchor tile tx,ty); soft: tiles it occupies but that stay walkable while free
  // (a stool, a chair, the seat in front of a desk); sort: depth row offset; up: pixels above the footprint that still count as the piece.
  // spots: interaction points. `at` = candidate tiles [dx, dy, facing] tried in order (facing "item" = the piece's own dir);
  // `via` = the tile a character steps in from (so nobody climbs over a sofa back or a table); soft spots are dropped when they do not fit.
  const row = (n) => Array.from({ length: n }, (_, i) => [i, 0]);
  const FRONT = [[0, 1, "up"], [0, -1, "down"]];
  const TYPES = {
    desk: { fp: [[-1, 1], [0, 1], [1, 1]], soft: [[0, 0]], up: 20 },
    counter: { fp: row(5), up: 18, spots: [{ at: [[3, 1, "up"], [3, -1, "down"]], anim: "drink", wk: "coffee" }] },
    fridge: { fp: [[0, 0]], up: 26, spots: [{ at: FRONT, anim: "stand", wk: "fridge" }] },
    roundTable: { fp: [[0, 0], [1, 0]], up: 4, events: { kind: "food", tiles: [[0, -1], [1, -1], [2, -1], [-1, -1], [0, 1], [1, 1], [3, -1], [2, 1]] } },
    stool: { soft: [[0, 0]], dirs: ["right", "down", "left", "up"], spots: [{ at: [[0, 0, "item"]], via: "below", anim: "sitfree", group: "stool", wk: "stoolL" }] },
    bin: { fp: [[0, 0]], up: 6 },
    plant: { fp: [[0, 0]], up: 16, spots: [{ at: [[0, -1, "down"]], anim: "water", wk: "plantK", soft: true, when: (it) => !!it.water }] },
    meetingTable: {
      fp: [0, 1].flatMap((y) => [0, 1, 2, 3].map((x) => [x, y])), sort: 1, up: 4,
      spots: [
        ["S1", 1, -1, "down"], ["S2", 1, 2, "up"], ["S3", -1, 0, "right"], ["S4", 4, 0, "left"],
        ["S5", 3, -1, "down"], ["S6", 3, 2, "up"], ["S7", 4, 2, "left"], ["S8", 4, 1, "left"],
      ].map(([sfx, dx, dy, d]) => ({ sfx, at: [[dx, dy, d]], anim: "stand", group: "meetS", wk: "meetS", soft: true, meet: true, only: "meeting" })),
    },
    meetingChair: { soft: [[0, 0]], dirs: ["down", "up"], up: 12, spots: [{ at: [[0, 0, "item"]], via: "behind", anim: "sitfree", group: "meet", wk: "meetA", meet: true }] },
    sofa: {
      fp: row(3), up: 10,
      spots: [{ sfx: "L", at: [[0, 0, "down"]], via: "below", anim: "sitfree", group: "sofa", wk: "sofaL" }, { sfx: "R", at: [[2, 0, "down"]], via: "below", anim: "sitfree", group: "sofa", wk: "sofaR" }],
    },
    coffeeTable: { fp: row(3), up: 4 },
    bookshelf: { fp: [[0, 0]], up: 30, spots: [{ at: FRONT, anim: "read", wk: "books" }] },
    lamp: { fp: [[0, 0]], up: 40 },
    cabinets: { fp: row(3), up: 22 },
    boxes: { fp: row(2), up: 12 },
    printer: { fp: row(2), up: 14, spots: [{ at: FRONT, anim: "think", wk: "printer" }], events: { kind: "printer", tiles: [[0, 1], [-1, 1], [1, 1], [-1, 2], [0, 2]] } },
    cooler: { fp: [[0, 0]], up: 16, spots: [{ at: [[1, 0, "left"], [-1, 0, "right"], [0, 1, "up"]], anim: "drink", wk: "water" }] },
    coffeeStation: { fp: [[0, 0]], up: 8, spots: [{ at: FRONT, anim: "brew", wk: "brew" }] },
  };
  for (const th of Object.keys(WALL)) for (const [piece, [, w, layer]] of Object.entries(WALL[th])) TYPES[th + "_" + piece] = { wall: { theme: th, piece, w, ambient: w === 0, layer: layer || "under" } };
  TYPES.rug = { deco: Array.from({ length: RUG.w * RUG.h }, (_, i) => [i % RUG.w, Math.floor(i / RUG.w)]), sort: -100 };
  // palette order (desks are added automatically and by copying)
  const TYPE_ORDER = ["desk", "counter", "fridge", "roundTable", "stool", "bin", "plant", "meetingTable", "meetingChair", "sofa", "coffeeTable", "bookshelf", "lamp", "cabinets", "boxes", "printer", "cooler", "coffeeStation", "rug"];
  const DEFAULT_DIR = { stool: "right", meetingChair: "down" };
  const DIRS = ["up", "down", "left", "right"];
  const DIR_VEC = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" };
  const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;

  // ---------- default layout (what the office has always looked like) ----------
  // Same order as the old hard-coded drawing list (the depth sort is stable, so ties draw the same). Desks come from deskLayout(n).
  function defaultItems() {
    const P = (id, type, tx, ty, extra = {}) => ({ id, type, tx, ty, ...extra });
    return [
      P("coffee", "counter", 0, 2), P("fridge", "fridge", 5, 2), P("table", "roundTable", 2, 6),
      P("stoolL", "stool", 1, 6, { dir: "right" }), P("stoolR", "stool", 4, 6, { dir: "left" }),
      P("bin", "bin", 0, 8), P("plantK", "plant", 6, 8, { v: 1, water: true }),
      P("meet", "meetingTable", 24, 4),
      P("meetA", "meetingChair", 24, 3, { dir: "down" }), P("meetB", "meetingChair", 26, 3, { dir: "down" }),
      P("meetC", "meetingChair", 24, 6, { dir: "up" }), P("meetD", "meetingChair", 26, 6, { dir: "up" }),
      P("plant1", "plant", 29, 2, { v: 2 }), P("plantM", "plant", 23, 8, { v: 1, water: true }),
      P("sofa", "sofa", 1, 12), P("coffeeTable", "coffeeTable", 1, 14), P("books", "bookshelf", 5, 11), P("lamp", "lamp", 0, 10),
      P("plant2", "plant", 6, 16, { v: 2 }), P("plant3", "plant", 0, 16, { v: 1 }),
      P("cabinets", "cabinets", 23, 10), P("boxes", "boxes", 28, 10), P("printer", "printer", 27, 13), P("water", "cooler", 23, 14),
      P("plant4", "plant", 29, 16, { v: 2 }), P("plant5", "plant", 8, 16, { v: 2 }), P("plant6", "plant", 21, 16, { v: 2 }),
      P("brew", "coffeeStation", 8, 2),
    ];
  }

  // Desk seat tile columns / rows inside the open office (x 8..21) by head-count
  function deskLayout(n) {
    const cols = n <= 2 ? [14] : n <= 4 ? [11, 17] : [10, 14, 18];
    const rowsNeeded = Math.ceil(n / cols.length);
    const rows = [[8], [5, 11], [4, 9, 14], [3, 7, 11, 15]][Math.min(rowsNeeded, 4) - 1];
    return { cols, rows };
  }
  function autoDesks(n, ids = []) {
    n = Math.min(n, MAX_EMP);
    if (n < 1) return [];
    const { cols, rows } = deskLayout(n);
    return Array.from({ length: n }, (_, i) => ({ id: "desk" + i, type: "desk", tx: cols[i % cols.length], ty: rows[Math.floor(i / cols.length)], ...(ids[i] != null ? { emp: String(ids[i]) } : {}) }));
  }

  // ---------- build: everything derived from the records ----------
  const tileOf = (it, [dx, dy]) => [it.tx + dx, it.ty + dy];
  const inGrid = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;

  function reachFrom(blockedSet) {
    const seen = new Set([key(ENTRANCE.tx, ENTRANCE.ty)]);
    const queue = [[ENTRANCE.tx, ENTRANCE.ty]];
    for (let i = 0; i < queue.length; i++) {
      const [cx, cy] = queue[i];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy, k = key(nx, ny);
        if (!inGrid(nx, ny) || seen.has(k) || blockedSet.has(k)) continue;
        seen.add(k);
        queue.push([nx, ny]);
      }
    }
    return seen;
  }

  // Returns {blocked, occ, soft, reach, spots, meetingSpots, desks, events, errors}. Never throws; `errors` lists what is wrong
  // ({code, id}): unknown types, pieces off the floor or on top of each other, spots left without a free tile.
  function build(items) {
    const errors = [];
    const blocked = new Set(WALLS), occ = new Map(), soft = new Map();
    const ids = new Set();
    const list = [], wallItems = [], decoOcc = new Map();
    for (const it of items) {
      const T = hasOwn(TYPES, it.type) ? TYPES[it.type] : null;
      if (!T) { errors.push({ code: "type", id: it.id }); continue; }
      if (ids.has(it.id)) { errors.push({ code: "dup", id: it.id }); continue; }
      ids.add(it.id);
      if (T.wall) { wallItems.push(it); continue; }
      list.push(it);
      const claim = (x, y, isSoft) => {
        const k = key(x, y);
        if (!floor.has(k)) { errors.push({ code: "outside", id: it.id, tile: [x, y] }); return; }
        if (occ.has(k)) { errors.push({ code: "overlap", id: it.id, other: occ.get(k), tile: [x, y] }); return; }
        occ.set(k, it.id);
        if (isSoft) soft.set(k, it.id); else blocked.add(k);
      };
      for (const d of T.deco || []) { // a rug: lies on the floor, may not overlap another rug, everything else may stand on it
        const [x, y] = tileOf(it, d), k = key(x, y);
        if (!floor.has(k)) { errors.push({ code: "outside", id: it.id, tile: [x, y] }); break; }
        if (decoOcc.has(k)) { errors.push({ code: "overlap", id: it.id, other: decoOcc.get(k), tile: [x, y] }); break; }
        decoOcc.set(k, it.id);
      }
      for (const d of T.fp || []) { const [x, y] = tileOf(it, d); claim(x, y, false); }
      for (const d of T.soft || []) { const [x, y] = tileOf(it, d); claim(x, y, true); }
    }
    // wall decor: inside the top band, clear of the windows, not on another piece; ambient decor takes no tiles but only one of each
    const hung = new Map(), ambient = new Set();
    for (const it of wallItems) {
      const { w } = TYPES[it.type].wall;
      if (!w) { if (ambient.has(it.type)) errors.push({ code: "dup", id: it.id }); ambient.add(it.type); continue; }
      if (it.ty !== 0 || it.tx < 0 || it.tx + w > COLS) { errors.push({ code: "wallEdge", id: it.id }); continue; }
      const cols = Array.from({ length: w }, (_, i) => it.tx + i);
      if (cols.some((x) => WINDOW_TILES.has(x))) { errors.push({ code: "window", id: it.id }); continue; }
      const hit = cols.map((x) => hung.get(x)).find(Boolean);
      if (hit) { errors.push({ code: "wallOverlap", id: it.id, other: hit }); continue; }
      for (const x of cols) hung.set(x, it.id);
    }
    // a walkable tile that nobody stands on, sits on or walks through: walls, furniture, desk seats, stools and chairs all block passage
    const passBlock = new Set([...blocked, ...soft.keys()]);
    const reach = reachFrom(passBlock);
    const free = (x, y) => inGrid(x, y) && !blocked.has(key(x, y)) && !soft.has(key(x, y));

    const spots = [], meetingSpots = [], standing = [];
    const seenKeys = new Set();
    const pushSpot = (s, only) => {
      if (seenKeys.has(s.key)) { errors.push({ code: "dup", id: s.item, key: s.key }); return; }
      seenKeys.add(s.key);
      if (only === "meeting") standing.push(s); else spots.push(s);
    };
    for (const it of list) {
      const T = TYPES[it.type];
      for (const tpl of T.spots || []) {
        if (tpl.when && !tpl.when(it)) continue;
        const skey = it.id + (tpl.sfx || "");
        let picked = null;
        if (tpl.via) {
          const [dx, dy, d] = tpl.at[0];
          const tx = it.tx + dx, ty = it.ty + dy, dir = d === "item" ? (it.dir || DEFAULT_DIR[it.type]) : d;
          const order = tpl.via === "behind"
            ? [OPPOSITE[dir], ...DIRS.filter((x) => x !== OPPOSITE[dir] && x !== dir), dir]
            : ["down", "up", "left", "right"];
          const cands = order.map((o) => [tx + DIR_VEC[o][0], ty + DIR_VEC[o][1]]).filter(([x, y]) => free(x, y));
          const via = cands.find(([x, y]) => reach.has(key(x, y))) || cands[0];
          if (via && inGrid(tx, ty)) picked = { key: skey, tx, ty, dir, anim: tpl.anim, via: [via[0], via[1]], ok: reach.has(key(via[0], via[1])) };
        } else {
          const cands = tpl.at.map(([dx, dy, d]) => ({ x: it.tx + dx, y: it.ty + dy, dir: d === "item" ? (it.dir || DEFAULT_DIR[it.type]) : d })).filter((c) => free(c.x, c.y));
          const c = cands.find((q) => reach.has(key(q.x, q.y))) || cands[0];
          if (c) picked = { key: skey, tx: c.x, ty: c.y, dir: c.dir, anim: tpl.anim, ok: reach.has(key(c.x, c.y)) };
        }
        if (!picked) { if (!tpl.soft) errors.push({ code: "spot", id: it.id, key: skey }); continue; }
        Object.assign(picked, { group: tpl.group || skey, wk: tpl.wk || skey, item: it.id, ...(tpl.meet ? { meet: true } : {}), ...(tpl.soft ? { soft: true } : {}) });
        pushSpot(picked, tpl.only);
      }
    }
    for (const f of FIXED_SPOTS) { const s = { ...f, group: f.key, wk: f.key, item: null, ok: reach.has(key(f.tx, f.ty)) }; if (free(f.tx, f.ty)) pushSpot(s); else errors.push({ code: "spot", id: null, key: f.key }); }
    // meeting: the chairs first (all idle spots that are meeting seats), then the standing places around the tables
    for (const s of spots) if (s.meet) meetingSpots.push(s);
    for (const s of standing) meetingSpots.push(s);

    const desks = list.filter((it) => it.type === "desk").map((it) => ({ id: it.id, tx: it.tx, ty: it.ty, emp: it.emp || null }));
    const events = { food: [], printer: [] };
    for (const it of list) {
      const ev = TYPES[it.type].events;
      if (!ev) continue;
      events[ev.kind].push({ id: it.id, tx: it.tx, ty: it.ty, tiles: ev.tiles.map((d) => tileOf(it, d)).filter(([x, y]) => free(x, y)) });
    }
    return { blocked, occ, soft, reach, spots, standing, meetingSpots, desks, events, errors };
  }

  // Everything that must hold for a layout to be accepted: a valid build, the entrance open, every desk / spot / door reachable on foot,
  // and a desk for every colleague. Returns {ok, errors, build}.
  function check(items, { empCount = 0 } = {}) {
    const b = build(items);
    const errors = b.errors.slice();
    const entrance = key(ENTRANCE.tx, ENTRANCE.ty);
    if (b.blocked.has(entrance) || b.soft.has(entrance)) errors.push({ code: "entrance", id: b.occ.get(entrance) || null });
    else {
      const R = b.reach;
      for (const s of b.spots) if (!s.soft && !s.ok) errors.push({ code: "unreachable", id: s.item, key: s.key });
      for (const d of b.desks) {
        if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => R.has(key(d.tx + dx, d.ty + dy)))) errors.push({ code: "unreachable", id: d.id });
      }
      for (const g of DOOR_GROUPS) {
        if (!g.a.some(([x, y]) => R.has(key(x, y))) || !g.b.some(([x, y]) => R.has(key(x, y)))) errors.push({ code: "door", id: null, tile: g.tiles[0] });
      }
    }
    if (b.desks.length > MAX_DESKS) errors.push({ code: "desks", id: null });
    if (b.desks.length < Math.min(empCount, MAX_EMP)) errors.push({ code: "desks", id: null });
    return { ok: errors.length === 0, errors, build: b };
  }

  // ---------- schema: what a stored / received layout may contain ----------
  const isInt = (v) => Number.isInteger(v);
  function sanitize(doc) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.v !== 1 || !Array.isArray(doc.items)) return { ok: false, error: "shape" };
    if (doc.items.length > MAX_ITEMS) return { ok: false, error: "size" };
    const items = [], ids = new Set();
    for (const raw of doc.items) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "item" };
      const T = typeof raw.type === "string" && hasOwn(TYPES, raw.type) ? TYPES[raw.type] : null;
      if (!T || typeof raw.id !== "string" || !ID_RE.test(raw.id) || ids.has(raw.id)) return { ok: false, error: "item" };
      if (!isInt(raw.tx) || !isInt(raw.ty) || raw.tx < 0 || raw.ty < 0 || raw.tx >= COLS || raw.ty >= ROWS) return { ok: false, error: "tile" };
      if (T.wall && (raw.ty !== 0 || raw.tx + T.wall.w > COLS)) return { ok: false, error: "tile" };
      if (T.wall && T.wall.ambient && raw.tx !== 0) return { ok: false, error: "tile" };
      ids.add(raw.id);
      const it = { id: raw.id, type: raw.type, tx: raw.tx, ty: raw.ty };
      if (T.dirs) { if (raw.dir !== undefined && !T.dirs.includes(raw.dir)) return { ok: false, error: "dir" }; it.dir = raw.dir || DEFAULT_DIR[raw.type]; }
      if (raw.type === "plant") {
        if (raw.v !== undefined && raw.v !== 1 && raw.v !== 2) return { ok: false, error: "item" };
        it.v = raw.v || 1;
        if (raw.water) it.water = true;
      }
      if (raw.skin !== undefined) { // another theme's look for this piece
        if (T.wall || typeof raw.skin !== "string" || !THEMES.includes(raw.skin)) return { ok: false, error: "skin" };
        it.skin = raw.skin;
      }
      if (raw.type === "desk" && raw.emp !== undefined && raw.emp !== null && raw.emp !== "") {
        if (typeof raw.emp !== "string" || raw.emp.length > 80) return { ok: false, error: "item" };
        it.emp = raw.emp;
      }
      items.push(it);
    }
    // `decor`: the wall decor and the rug are stored in `items` (otherwise the office's own defaults apply). (An earlier draft kept a list of themes in `walls`.)
    const decor = doc.decor === true || (Array.isArray(doc.walls) && doc.walls.length > 0);
    if (doc.decor !== undefined && typeof doc.decor !== "boolean") return { ok: false, error: "decor" };
    return { ok: true, items, ...(decor ? { decor: true } : {}) };
  }
  const toDoc = (items, decor) => ({ v: 1, items: items.map((it) => ({ ...it })), ...(decor ? { decor: true } : {}) });
  const clone = (items) => items.map((it) => ({ ...it }));

  // ---------- wall decor, rugs and what finished work unlocks ----------
  const isWall = (it) => hasOwn(TYPES, it.type) && !!TYPES[it.type].wall;
  const wallOrder = (group) => (hasOwn(WALL, group) ? Object.keys(WALL[group]).map((p) => group + "_" + p) : []);
  const wallOf = (items) => items.filter(isWall);
  const wallTiles = () => Array.from({ length: COLS }, (_, x) => [x, 0]);
  // A theme's default arrangement (the decor the office has always had). One piece per default tile: gothic_torch, gothic_torch2 ...
  function defaultWall(theme) {
    if (!hasOwn(WALL, theme) || theme === "progress") return [];
    const out = [];
    for (const [piece, [tiles]] of Object.entries(WALL[theme])) tiles.forEach((tx, i) => out.push({ id: theme + "_" + piece + (i ? i + 1 : ""), type: theme + "_" + piece, tx, ty: 0 }));
    return out;
  }
  // The pieces the first `n` unlocks give (in order), each hung where it fits (its favourite tile or the nearest free one), else left out.
  function progressWall(items, n) {
    let cur = items;
    const out = [];
    for (const piece of PROGRESS_ORDER.slice(0, Math.max(0, Math.min(n | 0, PROGRESS_ORDER.length)))) {
      const type = "progress_" + piece;
      if (cur.some((it) => it.type === type)) continue;
      const spot = findPlace(cur, { id: type, type }, [PROGRESS_NEAR[piece], 0]);
      if (spot) { out.push(spot); cur = [...cur, spot]; }
    }
    return out;
  }
  const defaultRug = () => ({ id: "rug", type: "rug", tx: RUG.def[0], ty: RUG.def[1] });
  // The wall decor and the rug an office has when nothing of them is stored (`doc.decor`): the theme's default arrangement, the lounge
  // rug and the unlocked pieces. Once stored, what is in `items` is all there is.
  function withDecor(items, doc, theme, progress = 0) {
    if (!theme || !hasOwn(WALL, theme) || (doc && doc.decor)) return items;
    let out = items;
    if (!out.some((it) => it.type === "rug")) out = out.concat(defaultRug());
    if (!wallOf(out).length) out = out.concat(defaultWall(theme));
    return out.concat(progressWall(out, progress));
  }

  // ---------- desks and colleagues ----------
  // Explicit `emp` first, then whoever is left takes the first free desk in list order.
  function assignDesks(items, ids) {
    ids = ids.slice(0, MAX_EMP);
    const desks = items.filter((it) => it.type === "desk"), idset = new Set(ids);
    const map = new Map(), used = new Set();
    for (const d of desks) if (d.emp && idset.has(d.emp) && !map.has(d.emp)) { map.set(d.emp, d.id); used.add(d.id); }
    const missing = [];
    for (const id of ids) {
      if (map.has(id)) continue;
      const d = desks.find((x) => !used.has(x.id));
      if (d) { map.set(id, d.id); used.add(d.id); } else missing.push(id);
    }
    return { map, missing };
  }

  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + 0.01 * Math.hypot(a[0] - b[0], a[1] - b[1]);
  const floorTiles = (rooms) => { const out = []; for (const r of ROOMS) if (!rooms || rooms.includes(r.key)) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) out.push([x, y]); return out; };
  function nextId(items, type) {
    const used = new Set(items.map((it) => it.id));
    for (let n = 2; ; n++) if (!used.has(type + n)) return type + n;
  }
  // The valid tile closest to `near` for a piece like `proto` (or null). `tiles` limits / orders the search.
  function findPlace(items, proto, near, { tiles, empCount = 0 } = {}) {
    const cand = (tiles || (isWall(proto) ? wallTiles() : floorTiles())).slice().sort((a, b) => dist(a, near) - dist(b, near));
    for (const [x, y] of cand) {
      const test = { ...proto, tx: x, ty: y };
      if (check([...items, test], { empCount }).ok) return test;
    }
    return null;
  }
  // Every colleague gets a desk: spare desks are handed out (and remembered in `emp`), missing ones are added where they fit.
  function ensureDesks(items, ids) {
    ids = ids.slice(0, MAX_EMP);
    let out = clone(items), changed = false;
    const { map } = assignDesks(out, ids);
    for (const id of ids) { const d = map.get(id) && out.find((x) => x.id === map.get(id)); if (d && d.emp !== id) { d.emp = id; changed = true; } }
    const missing = [];
    for (const id of ids) {
      if (map.has(id)) continue;
      const proto = { id: nextId(out, "desk"), type: "desk", emp: id };
      // the next free spot of the automatic desk grid first, then anywhere in the open office, then any room
      const grid = [];
      for (let n = 1; n <= MAX_EMP; n++) { const { cols, rows } = deskLayout(n); const i = n - 1; grid.push([cols[i % cols.length], rows[Math.floor(i / cols.length)]]); }
      let placed = null;
      for (const [x, y] of grid) { const test = { ...proto, tx: x, ty: y }; if (check([...out, test]).ok) { placed = test; break; } }
      if (!placed) placed = findPlace(out, proto, [14, 9], { tiles: floorTiles(["office"]).concat(floorTiles(["kitchen", "meeting", "lounge", "archive"])) });
      if (placed) { out.push(placed); changed = true; } else missing.push(id);
    }
    return { items: out, changed, missing };
  }
  // The full picture for a set of colleagues: the saved layout (null = the default one), desks made sure of, who sits where.
  function scene(doc, ids, theme, progress = 0) {
    ids = ids.slice(0, MAX_EMP);
    let items, missing = [], added = false;
    if (!doc) items = defaultItems().concat(autoDesks(ids.length, ids));
    else { const r = ensureDesks(doc.items, ids); items = r.items; missing = r.missing; added = r.changed; }
    items = withDecor(items, doc, theme, progress);
    const { map, missing: unseated } = assignDesks(items, ids);
    return { items, build: build(items), assign: map, missing: [...new Set([...missing, ...unseated])], changed: added };
  }
  // Fixes what is wrong by moving the offending pieces to the nearest valid tile (the classic layout for 11+ colleagues puts a desk on the
  // entrance mat). Returns the fixed items, or null when that is not possible.
  function repair(items, empCount = 0) {
    let cur = clone(items);
    for (let round = 0; round < 6; round++) {
      const r = check(cur, { empCount });
      if (r.ok) return cur;
      const bad = [...new Set(r.errors.filter((e) => e.id).map((e) => e.id))];
      if (!bad.length || r.errors.some((e) => !e.id)) return null;
      for (const id of bad) {
        const it = cur.find((x) => x.id === id);
        if (!it) continue;
        const moved = findPlace(cur.filter((x) => x.id !== id), it, [it.tx, it.ty]);
        if (!moved) return null;
        cur = cur.map((x) => (x.id === id ? moved : x));
      }
    }
    return null;
  }
  function canDelete(items, id, ids) {
    const it = items.find((x) => x.id === id);
    if (!it) return { ok: false, reason: "missing" };
    if (it.type !== "desk") return { ok: true };
    const { map } = assignDesks(items, ids);
    if ([...map.values()].includes(id)) return { ok: false, reason: "assigned" };
    if (items.filter((x) => x.type === "desk").length - 1 < Math.min(ids.length, MAX_EMP)) return { ok: false, reason: "lastDesk" };
    return { ok: true };
  }
  function rotate(it) {
    const T = TYPES[it.type];
    if (!T || !T.dirs) return it;
    const cur = it.dir || DEFAULT_DIR[it.type];
    return { ...it, dir: T.dirs[(T.dirs.indexOf(cur) + 1) % T.dirs.length] };
  }
  // closest walkable tile to `from`; used to rescue somebody standing where a piece has just been dropped
  function nearestFree(b, from, taken = new Set()) {
    let best = null, bd = 1e9;
    const big = b.reach.size > 40;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const k = key(x, y);
      if (b.blocked.has(k) || b.soft.has(k) || taken.has(k) || (big && !b.reach.has(k))) continue;
      const d = dist([x, y], from);
      if (d < bd) { bd = d; best = [x, y]; }
    }
    return best;
  }
  // (a wall piece: the two rows of the wall band under it, for hit testing and highlighting)
  const tilesOf = (it) => {
    const T = hasOwn(TYPES, it.type) ? TYPES[it.type] : null;
    if (T && T.wall) return Array.from({ length: T.wall.w }, (_, i) => [[it.tx + i, 0], [it.tx + i, 1]]).flat();
    return [...((T && T.fp) || []), ...((T && T.soft) || []), ...((T && T.deco) || [])].map((d) => tileOf(it, d));
  };

  globalThis.POLayout = {
    COLS, ROWS, MAX_EMP, MAX_ITEMS, MAX_DESKS, ENTRANCE, ROOMS, DOORS, DOOR_GROUPS, FIXED_SPOTS, WALLS, TYPES, TYPE_ORDER, DEFAULT_DIR,
    THEMES, WALL, RUG, PROGRESS_ORDER, WINDOW_TILES, isWall, wallOrder, wallOf, defaultWall, defaultRug, progressWall, withDecor,
    key, defaultItems, deskLayout, autoDesks, build, check, sanitize, toDoc, clone, assignDesks, ensureDesks, findPlace, nextId, scene,
    canDelete, rotate, repair, nearestFree, tilesOf, floorTiles, isFloor: (x, y) => floor.has(key(x, y)),
  };
})();
