// Test panel for the office animations. Only appears with `?debug` in the URL (e.g. http://localhost:PORT/?debug).
// Everything here is visual and local: it drives the office view directly and sends nothing to the server.
(() => {
  if (!new URLSearchParams(location.search).has("debug")) return;
  const now = () => performance.now();
  const emp = () => office.emps.find((e) => e.id === sel.value);
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:99999;width:250px;max-height:86vh;overflow:auto;background:#1d1a1fee;color:#eee;font:12px/1.4 system-ui;padding:8px;border:1px solid #555;border-radius:6px";
  const sel = document.createElement("select");
  sel.style.cssText = "width:100%;margin-bottom:6px";
  const head = document.createElement("div");
  head.innerHTML = "<b>Test paneli</b> <small>(yalnızca görsel)</small>";
  box.append(head, sel);
  const refresh = () => {
    const keep = sel.value;
    sel.innerHTML = "";
    for (const e of office.emps) sel.add(new Option(e.name || e.id, e.id));
    if (keep) sel.value = keep;
  };
  sel.addEventListener("focus", refresh);
  setInterval(() => { if (!sel.options.length) refresh(); }, 1000);

  const group = (title, items) => {
    const h = document.createElement("div");
    h.textContent = title;
    h.style.cssText = "margin:8px 0 3px;color:#ffd166;font-weight:600";
    const w = document.createElement("div");
    w.style.cssText = "display:flex;flex-wrap:wrap;gap:3px";
    for (const [label, fn] of items) {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "font:11px system-ui;padding:2px 6px;cursor:pointer";
      b.onclick = () => { try { fn(); } catch (err) { console.error("[debug]", err); alert("Hata: " + err.message); } };
      w.append(b);
    }
    box.append(h, w);
  };
  const toDesk = (e) => { office.setStatus(e.id, "idle"); e.spot = null; e.act = null; if (!office.atSeat(e)) office.goTo(e, e.seat.tx, e.seat.ty); e.restUntil = now() + 60000; };
  const atDesk = (e, fn) => { toDesk(e); const t0 = now(); const iv = setInterval(() => { if (office.atSeat(e) && !e.path.length || now() - t0 > 15000) { clearInterval(iv); fn(); } }, 200); };

  group("1) Çalışma / araç animasyonu", ["read", "write", "bash", "search", "web", "other"].map((k) => [k, () => { const e = emp(); office.setStatus(e.id, "idle"); office.setStatus(e.id, "working"); office.setTool(e.id, k); }]));
  group("Derin odak (60sn+ çalışma)", [["Kulaklık + içecek", () => { const e = emp(); office.setStatus(e.id, "working"); e.workSince = now() - 90000; }]]);
  group("Durum", ["idle", "working", "waiting", "error", "sick"].map((s) => [s, () => { const e = emp(); if (e.status === s) office.setStatus(e.id, "idle"); office.setStatus(e.id, s); }]));
  group("2) Masada mikro hareket", (typeof MICRO_KINDS !== "undefined" ? MICRO_KINDS : []).map((k) => [k, () => { const e = emp(); atDesk(e, () => { e.micro = { kind: k, t0: now() }; }); }]));
  group("Masada boşta", ["stretch", "yawn", "doze"].map((k) => [k, () => { const e = emp(); atDesk(e, () => { e.act = { kind: k, anim: k, t0: now(), until: now() + (k === "doze" ? 8000 : 2300), spot: null }; }); }]));
  group("3) Spot'a gönder", POLayout.build(POLayout.defaultItems()).spots.filter((s) => !s.meet).map((s) => [s.key, () => { const e = emp(), sp = office.spots.find((x) => x.key === s.key); if (!sp) throw new Error("bu spot yok (eşyası silinmiş olabilir)"); office.setStatus(e.id, "idle"); e.act = null; if (office.goToSpot(e, sp)) { e.spot = sp; e.restUntil = now() + 60000; } }]));
  const pair = () => { const a = emp(), b = office.emps.find((x) => x !== a); if (!b) return null; for (const x of [a, b]) { office.setStatus(x.id, "idle"); x.act = null; } return [a, b]; };
  group("Sohbet / tepki", [
    ["Sohbet (bu + sıradaki)", () => { const p = pair(); if (p) office.startChat(p[0], p[1], now()); }],
    ["Sohbet (kahkahalı)", () => { const p = pair(); if (p) office.startChat(p[0], p[1], now(), { laugh: true }); }],
    ["Gülme (bu + sıradaki)", () => { const a = emp(), b = office.emps.find((x) => x !== a); for (const x of [a, b]) if (x) office.startLaugh(x, now(), 4200); }],
    ["Gülme (yalnız, 4sn)", () => office.startLaugh(emp(), now(), 4200)],
    ["Kıkırdama (masada)", () => { const e = emp(); atDesk(e, () => { e.micro = { kind: "giggle", t0: now() }; }); }],
    ["Tıklama tepkisi", () => office.react(emp().id)],
    ["Konfeti", () => office.celebrate(emp().id)],
  ]);
  group("Gülme varyantı (bu kişi)", ["arms", "belly", "knee", "tear", "mouth", "slap"].map((v) => [v, () => office.startLaugh(emp(), now(), 4200, { v })]));
  group("4) Başarı / hata", [
    ["Zafer + alkış", () => { const e = emp(); atDesk(e, () => { office.setStatus(e.id, "working"); setTimeout(() => office.setStatus(e.id, "idle"), 400); }); }],
    ["Hata + omuz dokunuşu", () => { const e = emp(); atDesk(e, () => office.setStatus(e.id, "error")); }],
  ]);
  group("5) Ofis olayı", ["pizza", "cake", "printer", "blackout"].map((k) => [k, () => { for (const e of office.emps) if (e.status !== "idle") office.setStatus(e.id, "idle"); if (!office.startEvent(k)) alert("Olay başlamadı (toplantı açık ya da çevrimdışı olabilir)."); }]));
  const slider = (title, min, max, step, init, on) => {
    const h = document.createElement("div");
    h.style.cssText = "margin:8px 0 3px;color:#ffd166;font-weight:600";
    const r = document.createElement("input");
    Object.assign(r, { type: "range", min, max, step, value: init });
    r.style.width = "100%";
    const upd = () => { h.textContent = `${title}: ${r.value}`; on(parseFloat(r.value)); };
    r.oninput = upd; h.textContent = `${title}: ${init}`;
    box.append(h, r);
  };
  slider("6) Saat (gece = 22-6)", 0, 24, 0.5, new Date().getHours(), (v) => { window.__poHour = v >= 24 ? 23.99 : v; });
  slider("7) Ofis dekor sayısı (0-5)", 0, 5, 1, 0, (v) => office.setProgress(v));
  group("Görev/XP", [["Gerçek XP için: panoda bir görevi 'done' yap", () => alert("XP sunucuda hesaplanır: board'da bir görevi Done'a taşı, sağ üstteki ⭐ çipini kontrol et.")]]);
  // Furniture layout (this browser only; a saved layout comes back on the next update from the server)
  const randomMove = () => {
    const ids = office.rosterIds, items = office.scene.items;
    for (let i = 0; i < 300; i++) {
      const it = items[Math.floor(Math.random() * items.length)];
      const next = items.map((x) => (x.id === it.id ? { ...x, tx: Math.floor(Math.random() * POLayout.COLS), ty: Math.floor(Math.random() * POLayout.ROWS) } : x));
      if (next.find((x) => x.id === it.id).tx === it.tx && next.find((x) => x.id === it.id).ty === it.ty) continue;
      if (!POLayout.check(next, { empCount: ids.length }).ok) continue;
      office.applyLayout(POLayout.toDoc(next));
      return `${it.id} -> ${next.find((x) => x.id === it.id).tx},${next.find((x) => x.id === it.id).ty}`;
    }
    return null;
  };
  group("8) Ofis düzeni", [
    ["Düzeni sıfırla", () => office.applyLayout(null)],
    ["Rastgele geçerli taşıma", () => { const r = randomMove(); if (!r) alert("Geçerli taşıma bulunamadı."); else console.log("[debug] moved", r); }],
    ["10 rastgele taşıma", () => { for (let i = 0; i < 10; i++) randomMove(); }],
    ["Düzenleme modu", () => layoutEditor.active ? layoutEditor.cancel() : layoutEditor.open()],
  ]);
  document.body.append(box);
})();
