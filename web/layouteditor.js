// Office layout editor (✏️ in the top bar): move, copy, rotate, delete and add pieces of furniture on the tile grid.
// Rooms, walls and doors are fixed. Every drop is checked by POLayout.check (on the floor, not on walls / doors / other pieces,
// every desk, hangout spot and doorway still reachable on foot, the entrance open). Changes show live in the office (people keep
// walking and re-route); Save sends the layout to the server (which checks it again), Cancel puts the saved one back.
const layoutEditor = (() => {
  const L = POLayout, TILE_PX = 32;
  const btn = $("btnLayout");
  const stage = document.querySelector("main.stage");
  const canvas = office.canvas;
  let active = false, items = [], startJson = "", base = null, undo = [], selected = null, drag = null, hover = null, ghost = null;
  let resetFlag = false, saving = false, msg = { text: "", bad: false };

  // ---------- the bar under the office ----------
  const bar = document.createElement("div");
  bar.className = "layout-bar";
  bar.hidden = true;
  bar.innerHTML = `
    <div class="lb-head"><b>${escapeHtml(t("ui.layout.title"))}</b><span class="lb-hint">${escapeHtml(t("ui.layout.hint"))}</span><span class="lb-msg" id="lbMsg" role="status"></span></div>
    <div class="lb-body">
      <div class="lb-palette" id="lbPalette" role="group" aria-label="${escapeHtml(t("ui.layout.add"))}"></div>
      <div class="lb-actions">
        <button class="btn small" id="lbUndo" type="button" title="Ctrl+Z">↶ ${escapeHtml(t("ui.layout.undo"))}</button>
        <button class="btn small" id="lbRotate" type="button" title="R">⟳ ${escapeHtml(t("ui.layout.rotate"))}</button>
        <button class="btn small" id="lbCopy" type="button" title="Ctrl+D">⧉ ${escapeHtml(t("ui.layout.copy"))}</button>
        <button class="btn small danger" id="lbDelete" type="button" title="Del">🗑 ${escapeHtml(t("ui.layout.delete"))}</button>
        <span class="lb-sep"></span>
        <button class="btn small ghost" id="lbReset" type="button">${escapeHtml(t("ui.layout.reset"))}</button>
        <button class="btn small" id="lbCancel" type="button" title="Esc">${escapeHtml(t("ui.layout.cancel"))}</button>
        <button class="btn small primary" id="lbSave" type="button">${escapeHtml(t("ui.layout.save"))}</button>
      </div>
    </div>`;
  stage.appendChild(bar);
  const q = (id) => bar.querySelector("#" + id);
  const palette = q("lbPalette");
  for (const type of L.TYPE_ORDER) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "lb-type"; b.dataset.type = type;
    b.title = t("ui.layout.addType", { name: t("ui.layout.type." + type) });
    b.innerHTML = `<img alt="" width="1" height="1"><span>${escapeHtml(t("ui.layout.type." + type))}</span>`;
    b.onclick = () => add(type);
    palette.appendChild(b);
  }
  const paintPalette = () => { // thumbnails follow the office's theme
    for (const b of palette.children) { const img = b.querySelector("img"); img.src = renderItemThumb(office.theme, b.dataset.type); img.removeAttribute("width"); img.removeAttribute("height"); }
  };

  // ---------- state helpers ----------
  const ids = () => office.rosterIds || [];
  const check = (list) => L.check(list, { empCount: ids().length });
  const find = (id) => items.find((i) => i.id === id);
  const put = (list, it) => list.map((x) => (x.id === it.id ? it : x));
  const nameOf = (empId) => { const e = office.emps.find((x) => x.id === empId); return e ? e.name : empId; };
  const ownerOf = (deskId) => { const { map } = L.assignDesks(items, ids()); for (const [emp, d] of map) if (d === deskId) return nameOf(emp); return ""; };
  const dirty = () => JSON.stringify(items) !== startJson || (resetFlag && base !== null);
  const say = (text, bad = false) => { msg = { text, bad }; const el = q("lbMsg"); el.textContent = text; el.classList.toggle("bad", bad); };
  const why = (res) => {
    const e = res.errors.find((x) => x.code !== "desks") || res.errors[0];
    return e ? t("ui.layout.err." + e.code) : "";
  };
  const typeName = (it) => t("ui.layout.type." + it.type);

  function refreshButtons() {
    const it = selected && find(selected);
    q("lbUndo").disabled = !undo.length;
    q("lbRotate").disabled = !(it && L.TYPES[it.type].dirs);
    q("lbCopy").disabled = !it;
    q("lbDelete").disabled = !it;
    q("lbSave").disabled = saving;
    for (const b of palette.children) b.classList.toggle("on", !!it && it.type === b.dataset.type);
    if (!drag) say(it ? t("ui.layout.selected", { name: typeName(it) + (it.type === "desk" && ownerOf(it.id) ? " · " + ownerOf(it.id) : "") }) : "");
  }

  // show the working copy in the office right away
  function apply() {
    office.applyLayout(L.toDoc(items));
    refreshButtons();
  }
  function commit(next, keepReset = false) {
    undo.push({ items, resetFlag });
    if (undo.length > 60) undo.shift();
    items = next;
    if (!keepReset) resetFlag = false;
    apply();
  }

  // ---------- pieces ----------
  function add(type) {
    if (!active) return;
    const proto = { id: L.nextId(items, type), type, ...(type === "plant" ? { v: 1, water: true } : {}), ...(L.DEFAULT_DIR[type] ? { dir: L.DEFAULT_DIR[type] } : {}) };
    const cur = selected && find(selected);
    const placed = L.findPlace(items, proto, cur ? [cur.tx, cur.ty] : [14, 9], { empCount: ids().length });
    if (!placed) { say(t("ui.layout.noRoom"), true); return; }
    commit([...items, placed]);
    selected = placed.id;
    refreshButtons();
  }
  function remove() {
    const it = selected && find(selected);
    if (!it) return;
    const r = L.canDelete(items, it.id, ids());
    if (!r.ok) { say(r.reason === "assigned" ? t("ui.layout.err.assigned", { name: ownerOf(it.id) }) : t("ui.layout.err." + r.reason), true); return; }
    const next = items.filter((x) => x.id !== it.id);
    const res = check(next);
    if (!res.ok) { say(why(res), true); return; } // (e.g. taking a piece away opens no hole, but be safe)
    commit(next);
    selected = null;
    refreshButtons();
  }
  function copy() {
    const it = selected && find(selected);
    if (!it) return;
    const proto = { ...it, id: L.nextId(items, it.type) };
    delete proto.emp;
    const placed = L.findPlace(items, proto, [it.tx, it.ty], { empCount: ids().length });
    if (!placed) { say(t("ui.layout.noRoom"), true); return; }
    commit([...items, placed]);
    selected = placed.id;
    refreshButtons();
  }
  function rotate() {
    const it = selected && find(selected);
    if (!it || !L.TYPES[it.type].dirs) return;
    const next = put(items, L.rotate(it));
    const res = check(next);
    if (!res.ok) { say(why(res), true); return; }
    commit(next);
  }
  function nudge(dx, dy) {
    const it = selected && find(selected);
    if (!it) return;
    const next = put(items, { ...it, tx: it.tx + dx, ty: it.ty + dy });
    const res = check(next);
    if (!res.ok) { say(why(res), true); return; }
    commit(next);
  }
  function undoLast() {
    const prev = undo.pop();
    if (!prev) return;
    items = prev.items; resetFlag = prev.resetFlag;
    if (selected && !find(selected)) selected = null;
    apply();
  }
  function reset() {
    const classic = L.repair(L.scene(null, ids()).items, ids().length);
    if (!classic) { say(t("ui.layout.err.cannotEdit"), true); return; }
    const same = JSON.stringify(classic) === JSON.stringify(L.scene(null, ids()).items);
    commit(classic, true);
    resetFlag = same;
    selected = null;
    refreshButtons();
    say(t("ui.layout.resetDone"));
  }

  // ---------- pointer ----------
  const at = (ev) => { const p = office.toLogical(ev); return { x: p.x, y: p.y, tx: Math.floor(p.x / TILE_PX), ty: Math.floor(p.y / TILE_PX) }; };
  // the piece under the pointer: the front-most one, counting the part that rises above its tiles (a fridge, a shelf, a monitor)
  function hitItem(p) {
    const depth = (it) => it.ty + (L.TYPES[it.type].sort || 0);
    for (const it of items.slice().sort((a, c) => depth(c) - depth(a) || items.indexOf(c) - items.indexOf(a))) {
      const up = L.TYPES[it.type].up || 0;
      for (const [x, y] of L.tilesOf(it)) if (p.x >= x * TILE_PX && p.x < (x + 1) * TILE_PX && p.y >= y * TILE_PX - up && p.y < (y + 1) * TILE_PX) return it;
    }
    return null;
  }
  canvas.addEventListener("pointerdown", (ev) => {
    if (!active || ev.button !== 0) return;
    const p = at(ev), it = hitItem(p);
    selected = it ? it.id : null;
    drag = it ? { id: it.id, orig: { ...it }, grab: [p.tx - it.tx, p.ty - it.ty], moved: false, sx: ev.clientX, sy: ev.clientY, last: "" } : null;
    if (drag) canvas.setPointerCapture(ev.pointerId);
    ghost = null;
    refreshButtons();
    ev.preventDefault();
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!active) return;
    const p = at(ev);
    hover = { tx: p.tx, ty: p.ty };
    if (!drag) { canvas.style.cursor = hitItem(p) ? "grab" : "default"; return; }
    if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 4) return;
    drag.moved = true;
    office.editorDim = drag.id;
    const cand = { ...drag.orig, tx: p.tx - drag.grab[0], ty: p.ty - drag.grab[1] };
    const k = cand.tx + "," + cand.ty;
    if (k !== drag.last) { drag.last = k; ghost = { item: cand, res: check(put(items, cand)) }; }
    canvas.style.cursor = ghost.res.ok ? "grabbing" : "not-allowed";
    say(ghost.res.ok ? "" : why(ghost.res), !ghost.res.ok);
  });
  const release = (ev, cancelled) => {
    if (!active || !drag) return;
    const d = drag, g = ghost;
    drag = null; ghost = null; office.editorDim = null;
    try { canvas.releasePointerCapture(ev.pointerId); } catch {}
    canvas.style.cursor = "default";
    if (!cancelled && d.moved && g) {
      const moved = g.item.tx !== d.orig.tx || g.item.ty !== d.orig.ty;
      if (g.res.ok && moved) { commit(put(items, g.item)); return; }
      if (!g.res.ok) { refreshButtons(); say(why(g.res), true); return; }
    }
    refreshButtons();
  };
  canvas.addEventListener("pointerup", (ev) => release(ev, false));
  canvas.addEventListener("pointercancel", (ev) => release(ev, true));
  canvas.addEventListener("pointerleave", () => { hover = null; });

  document.addEventListener("keydown", (ev) => {
    if (!active) return;
    const tag = (ev.target && ev.target.tagName) || "";
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || ev.target.isContentEditable) return;
    if (document.querySelector(".modal:not([hidden])")) return;
    const mod = ev.metaKey || ev.ctrlKey, k = ev.key;
    if (k === "Escape") { if (drag) { release(ev, true); } else if (selected) { selected = null; refreshButtons(); } else return; }
    else if (k === "Delete" || k === "Backspace") remove();
    else if ((k === "r" || k === "R") && !mod) rotate();
    else if ((k === "d" || k === "D") && mod) copy();
    else if ((k === "z" || k === "Z") && mod) undoLast();
    else if (k.startsWith("Arrow") && !mod) nudge(k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : 0, k === "ArrowUp" ? -1 : k === "ArrowDown" ? 1 : 0);
    else return;
    ev.preventDefault();
  });

  // ---------- drawing over the office (called from Office.draw while editing) ----------
  const tileFill = (b, tiles, col) => { b.fillStyle = col; for (const [x, y] of tiles) b.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX); };
  const frame = (b, tiles, col) => {
    b.fillStyle = col;
    const set = new Set(tiles.map(([x, y]) => x + "," + y));
    for (const [x, y] of tiles) {
      const px = x * TILE_PX, py = y * TILE_PX;
      if (!set.has(x + "," + (y - 1))) b.fillRect(px, py, TILE_PX, 2);
      if (!set.has(x + "," + (y + 1))) b.fillRect(px, py + TILE_PX - 2, TILE_PX, 2);
      if (!set.has(x - 1 + "," + y)) b.fillRect(px, py, 2, TILE_PX);
      if (!set.has(x + 1 + "," + y)) b.fillRect(px + TILE_PX - 2, py, 2, TILE_PX);
    }
  };
  function drawGhost(b, t, it, ok) {
    b.save();
    b.globalAlpha = 0.8;
    if (it.type === "desk") {
      const feet = (it.ty + 1) * TILE_PX;
      drawChair(b, it.tx * TILE_PX, feet);
      drawDesk(b, deskStub({ tx: it.tx, ty: it.ty }), t);
    } else {
      const list = [];
      itemDecor(office.theme, it, list);
      for (const d of list) d.draw(b, t);
    }
    b.restore();
    const tiles = L.tilesOf(it);
    tileFill(b, tiles, ok ? "rgba(74,222,128,.32)" : "rgba(248,113,113,.42)");
    frame(b, tiles, ok ? "#4ade80" : "#f87171");
  }
  function draw(b, t) {
    b.save();
    // the tile grid, on the floor only
    b.fillStyle = "rgba(255,255,255,.11)";
    for (const [x, y] of L.floorTiles()) { b.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, 1); b.fillRect(x * TILE_PX, y * TILE_PX, 1, TILE_PX); }
    // where people go: a dot on every hangout spot (and a tick on the tile they step in from)
    for (const s of office.spots) {
      b.fillStyle = "rgba(255,209,102,.85)"; b.fillRect(s.tx * TILE_PX + 14, s.ty * TILE_PX + 14, 4, 4);
      if (s.via) { b.fillStyle = "rgba(255,209,102,.4)"; b.fillRect(s.via[0] * TILE_PX + 15, s.via[1] * TILE_PX + 15, 2, 2); }
    }
    // whose desk is whose
    b.font = "bold 8px monospace"; b.textAlign = "center"; b.textBaseline = "middle";
    for (const d of office.scene.build.desks) {
      const e = office.emps.find((x) => x.seat.desk === d.id);
      const text = e ? String(e.name || "").split(/\s+/)[0] : "";
      if (!text) continue;
      const w = Math.min(TILE_PX * 3 - 6, Math.ceil(b.measureText(text).width) + 8), cx = d.tx * TILE_PX + 16, cy = (d.ty + 1) * TILE_PX + 10;
      b.fillStyle = "rgba(20,21,28,.82)"; b.fillRect(cx - w / 2, cy - 6, w, 12);
      b.fillStyle = e.color || "#ffd166"; b.fillRect(cx - w / 2, cy - 6, 2, 12);
      b.fillStyle = "#f5f0e6"; b.fillText(text, cx + 1, cy + 0.5, w - 6);
    }
    const it = selected && find(selected);
    if (it && !(drag && drag.moved)) frame(b, L.tilesOf(it), "#ffd166");
    if (ghost) drawGhost(b, t, ghost.item, ghost.res.ok);
    else if (hover && !drag) {
      const hit = L.floorTiles().some(([x, y]) => x === hover.tx && y === hover.ty);
      if (hit) { b.fillStyle = "rgba(255,255,255,.08)"; b.fillRect(hover.tx * TILE_PX, hover.ty * TILE_PX, TILE_PX, TILE_PX); }
    }
    b.restore();
  }

  // ---------- open / close ----------
  function open() {
    if (active) return;
    if (typeof isOnline === "function" && !isOnline()) { toast(t("ui.toast.noConnection")); return; }
    if (typeof closeChat === "function") closeChat();
    const start = office.scene.items;
    const fixed = L.repair(start, ids().length);
    if (!fixed) { toast(t("ui.layout.err.cannotEdit")); return; }
    base = cur().layout || null;
    items = fixed; startJson = JSON.stringify(start); undo = []; selected = null; drag = null; ghost = null; resetFlag = false; saving = false;
    active = true;
    office.editing = true;
    office.editorDraw = draw;
    document.body.classList.add("layout-editing");
    btn.classList.add("active");
    bar.hidden = false;
    paintPalette();
    refreshButtons();
    if (JSON.stringify(fixed) !== startJson) { office.applyLayout(L.toDoc(fixed)); say(t("ui.layout.repaired")); }
    requestAnimationFrame(() => office.fit());
  }
  // silent = leaving because the office on screen changes: nothing to put back
  function close(silent = false) {
    if (!active) return;
    active = false; drag = null; ghost = null; hover = null;
    office.editing = false; office.editorDraw = null; office.editorDim = null;
    document.body.classList.remove("layout-editing");
    btn.classList.remove("active");
    canvas.style.cursor = "";
    bar.hidden = true;
    if (!silent) office.applyLayout(cur().layout || null);
    requestAnimationFrame(() => office.fit());
  }
  function cancel(silent = false) { close(silent); }
  async function save() {
    if (!active || saving) return;
    const withDesks = L.ensureDesks(items, ids()).items; // colleagues hired meanwhile
    const res = check(withDesks);
    if (!res.ok) { say(why(res) || t("ui.layout.err.cannotEdit"), true); return; }
    if (!dirty()) { close(); return; }
    saving = true; refreshButtons();
    try {
      const out = await api("PUT", officeApi("/layout"), { layout: resetFlag ? null : L.toDoc(withDesks) });
      cur().layout = out.layout ?? null;
      toast(t("ui.layout.saved"));
      saving = false;
      close();
    } catch (err) {
      saving = false; refreshButtons();
      say(t("ui.layout.err.saveFailed", { message: err.message }), true);
    }
  }

  q("lbUndo").onclick = undoLast;
  q("lbRotate").onclick = rotate;
  q("lbCopy").onclick = copy;
  q("lbDelete").onclick = remove;
  q("lbReset").onclick = reset;
  q("lbCancel").onclick = () => cancel();
  q("lbSave").onclick = save;
  btn.onclick = () => {
    if (!active) open();
    else if (!dirty() || confirm(t("ui.layout.discard"))) cancel();
  };
  window.addEventListener("resize", () => { if (active) office.fit(); });

  return {
    get active() { return active; },
    get items() { return items; },
    open, cancel, save, add, remove, copy, rotate, undo: undoLast, commit,
    // for the ?debug panel: a random valid edit / back to the classic layout, applied to this browser only
    select(id) { selected = id; refreshButtons(); },
  };
})();
