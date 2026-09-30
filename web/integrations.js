// The Integration Market: a full-screen page (🔌 in the top bar) where the boss connects outside services (MCP servers) and decides which
// employee may use which. Three ways in, whatever the service offers: sign in with the account (a popup, then the office is told), paste a key,
// or just add it. Nothing here ever holds a credential: the server sends "…abcd" hints only. Who may use what is per employee (a matrix
// view shows it all at once); the server enforces it, the switches only edit it.
const integrationMarket = (() => {
  const CAT_ICON = { installed: "✅", all: "🔌", code: "💻", google: "🔎", media: "🎬", ai: "🧠", crm: "🤝", cloud: "☁️", security: "🛡️", work: "📋", data: "📊", payments: "💳", support: "💬", web: "🌐", docs: "📚", automation: "⚙️", custom: "🧩" };
  const st = { view: "market", cat: "all", q: "", method: "all", sel: null, custom: false, list: null, cats: [], error: "", busy: new Set(), err: {}, form: { auth: "none" }, dense: false };
  let root = null, open = false, poll = 0, pending = null, channel = null;

  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const esc = (s) => escapeHtml(String(s ?? ""));
  const one = (id) => (st.list || []).find((x) => x.id === id);
  const descOf = (x) => (x.desc && (x.desc[PO.locale] || x.desc.en)) || "";
  const catName = (c) => t(`ui.integrations.cat.${c}`);
  const errText = (e) => { const [code, ...rest] = String(e || "").split(":"); return t(["auth", "timeout", "offline", "reauth", "denied", "expired", "badBody"].includes(code) ? `ui.integrations.err.${code}` : "ui.integrations.err.error", { detail: rest.join(":") }); };
  const employees = () => { const out = []; for (const [oid, o] of state.offices) for (const e of o.employees.values()) out.push({ office: oid, officeName: o.info?.name || oid, e }); return out; };
  const holders = (id) => employees().filter((x) => (x.e.integrations || []).includes(id));

  // ---------- the logo: the real mark as a mask in the brand's colour (a light one when the brand is too dark for the night background) ----------
  function luma(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return 1; const n = parseInt(m[1], 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; }
  function hueOf(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  function logo(x, size = "") {
    if (x.icon && /\.(png|svg)$/.test(x.icon)) return `<span class="ig-logo pic ${size}" style="--brand:${esc(x.brand || "#8b8f9e")}"><img src="/logos/int/${esc(x.icon)}" alt="" loading="lazy" /></span>`;
    if (x.icon) {
      const brand = x.brand || "#e8e6df", dark = luma(brand) < 0.32;
      return `<span class="ig-logo ${size}" style="--brand:${esc(brand)}"><i class="${dark ? "dark" : ""}" style="--logo:url(/logos/int/${esc(x.icon)}.svg)"></i></span>`;
    }
    const h = hueOf(x.id);
    return `<span class="ig-logo mono ${size}" style="--brand:hsl(${h} 60% 62%)"><b>${esc(x.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "?")}</b></span>`;
  }
  const dot = (e) => `<span class="ig-av" title="${esc(e.name)}" style="background:${esc(e.color || "var(--idle)")}"></span>`;

  // ---------- data ----------
  async function load() {
    try { const r = await api("GET", "/api/integrations"); st.list = r.integrations; st.cats = r.categories; st.error = ""; }
    catch (err) { st.error = err.message; }
    render();
  }
  function replace(x) { st.list = st.list.map((y) => (y.id === x.id ? x : y)); }
  async function run(id, name, fn) {
    st.busy.add(`${id}:${name}`); st.err[id] = ""; render();
    try { await fn(); } catch (err) { st.err[id] = errText(err.message); }
    st.busy.delete(`${id}:${name}`); render();
  }
  const busy = (id, name) => st.busy.has(`${id}:${name}`);

  // ---------- sign in with the account ----------
  function watchSignIn(id) {
    clearInterval(poll); pending = id;
    const until = Date.now() + 10 * 60e3;
    poll = setInterval(async () => {
      if (Date.now() > until || !open) { clearInterval(poll); pending = null; render(); return; }
      try { const r = await api("GET", "/api/integrations"); st.list = r.integrations; if (one(id)?.added) { clearInterval(poll); pending = null; toast(t("ui.integrations.connected", { name: one(id).name })); } render(); } catch {}
    }, 2500);
  }
  function signIn(id) {
    const w = window.open("", "po-oauth", "width=560,height=760"); // opened inside the click, so it is not taken for a pop-up ad
    run(id, "oauth", async () => {
      let r;
      try { r = await api("POST", `/api/integrations/${id}/oauth/start`); } catch (err) { if (w) w.close(); throw err; }
      if (!r.url) { await load(); toast(t("ui.integrations.connected", { name: one(id).name })); return; } // (still signed in from before)
      if (w) w.location.href = r.url; else st.err[id] = t("ui.integrations.popupBlocked");
      st.signInUrl = { id, url: r.url };
      watchSignIn(id);
    });
  }
  function onSignedIn(m) {
    if (!m || m.type !== "po-oauth") return;
    clearInterval(poll); pending = null;
    load().then(() => { if (m.ok && m.id) { st.sel = m.id; toast(t("ui.integrations.connected", { name: one(m.id)?.name || "" })); } else if (m.id) st.err[m.id] = errText(m.error); render(); });
  }
  try { channel = new BroadcastChannel("po-oauth"); channel.onmessage = (ev) => onSignedIn(ev.data); } catch {}
  window.addEventListener("message", (ev) => { if (ev.origin === location.origin) onSignedIn(ev.data); });

  // ---------- who gets it ----------
  async function grant(officeId, emp, id, on) {
    const cur = new Set(emp.integrations || []);
    if (on) cur.add(id); else cur.delete(id);
    const r = await api("PUT", `/api/offices/${encodeURIComponent(officeId)}/employees/${encodeURIComponent(emp.id)}/integrations`, { ids: [...cur] });
    emp.integrations = r.ids;
    return r;
  }
  async function toggle(officeId, empId, id, on) {
    const emp = state.offices.get(officeId)?.employees.get(empId);
    if (!emp) return;
    try { const r = await grant(officeId, emp, id, on); toast(t(r.applies === "next" ? "ui.profile.connectorsNext" : "ui.profile.connectorsSaved")); } catch (err) { toast(err.message); }
    render();
  }
  async function everyone(id, on) {
    for (const { office, e } of employees()) if (!!(e.integrations || []).includes(id) !== on) { try { await grant(office, e, id, on); } catch (err) { toast(err.message); break; } }
    render();
  }

  // ---------- the market page ----------
  function matches(x) {
    if (st.cat === "installed" ? !x.added : st.cat !== "all" && x.category !== st.cat) return false;
    if (st.method !== "all" && !x.methods.includes(st.method)) return false;
    const q = st.q.trim().toLowerCase();
    return !q || `${x.name} ${x.host} ${descOf(x)} ${catName(x.category)}`.toLowerCase().includes(q);
  }
  const statusOf = (x) => (!x.added ? "" : x.ok === false ? "bad" : "ok");
  const statusText = (x) => (x.ok === false ? errText(x.error) : x.readOnly ? t("ui.integrations.readOnlyOn") : t("ui.integrations.state.connected"));

  function renderTop() {
    const n = (st.list || []).filter((x) => x.added).length;
    root.querySelector("#igTop").innerHTML = `
      <div class="ig-brand"><b>${esc(t("ui.integrations.title"))}</b><span>${esc(t("ui.integrations.sub"))}</span></div>
      <div class="ig-views" role="tablist">
        <button type="button" class="${st.view === "market" ? "on" : ""}" data-view="market" role="tab">${esc(t("ui.integrations.viewMarket"))}</button>
        <button type="button" class="${st.view === "perms" ? "on" : ""}" data-view="perms" role="tab">${esc(t("ui.integrations.viewPerms"))}${n ? ` <em>${n}</em>` : ""}</button>
      </div>
      <input class="ig-search" id="igSearch" type="search" autocomplete="off" placeholder="${esc(t("ui.integrations.search"))}" value="${esc(st.q)}" />
      <button type="button" class="btn small" id="igCustom">＋ ${esc(t("ui.integrations.custom.btn"))}</button>
      <button type="button" class="icon-btn small" id="igClose" aria-label="${esc(t("ui.integrations.close"))}">✕</button>`;
    root.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => { st.view = b.dataset.view; if (st.view === "perms") st.sel = null; render(); }));
    const s = root.querySelector("#igSearch");
    s.oninput = () => { st.q = s.value; if (st.view !== "market") st.view = "market"; renderMain(); renderRail(); };
    root.querySelector("#igCustom").onclick = () => { st.custom = true; st.form = { auth: "none" }; renderCustom(); };
    root.querySelector("#igClose").onclick = close;
  }
  function renderRail() {
    const list = st.list || [];
    const counts = { all: list.length, installed: list.filter((x) => x.added).length };
    for (const c of st.cats) counts[c] = list.filter((x) => x.category === c).length;
    const rail = root.querySelector("#igRail");
    const on = (c) => (st.view === "market" && st.cat === c ? " on" : "");
    const hue = (c) => (st.cats.indexOf(c) * 47 + 20) % 360;
    rail.innerHTML = `<div class="ig-tiles"><button type="button" class="ig-tile${on("all")}" data-cat="all"><b>${counts.all}</b><span>${esc(t("ui.integrations.cat.all"))}</span></button><button type="button" class="ig-tile conn${on("installed")}" data-cat="installed"><b>${counts.installed}</b><span>${esc(t("ui.integrations.cat.installed"))}</span></button></div>`
      + `<div class="ig-rail-h">${esc(t("ui.integrations.categories"))}</div>`
      + st.cats.filter((c) => counts[c]).map((c) => `<button type="button" class="ig-cat${on(c)}" data-cat="${c}" style="--h:${hue(c)}"><i></i><span>${esc(catName(c))}</span><em>${counts[c]}</em></button>`).join("");
    rail.querySelectorAll("[data-cat]").forEach((b) => (b.onclick = () => { st.cat = b.dataset.cat; st.view = "market"; render(); }));
  }
  function card(x, big) {
    const who = holders(x.id).slice(0, 5).map((h) => dot(h.e)).join("");
    const badges = x.methods.map((m) => `<span class="ig-badge ${m}">${esc(t(`ui.integrations.method.${m}`))}</span>`).join("");
    const b = el("button", `ig-card${st.sel === x.id ? " sel" : ""}${x.added ? " added" : ""}${big ? " big" : ""}`);
    b.type = "button"; b.dataset.id = x.id;
    b.style.setProperty("--brand", x.brand && luma(x.brand) >= 0.32 ? x.brand : "#8b8f9e");
    b.innerHTML = `<div class="ig-card-top">${logo(x)}<div class="ig-card-name"><b>${esc(x.name)}</b><small>${esc(x.host)}</small></div>${x.added ? `<span class="ig-pill ${statusOf(x)}">${esc(x.ok === false ? t("ui.integrations.state.failed") : t("ui.integrations.state.connected"))}</span>` : ""}</div>
      <p>${esc(descOf(x))}</p>
      <div class="ig-card-foot"><span class="ig-badges">${badges}${x.beta ? `<span class="ig-badge beta" title="${esc(t("ui.integrations.betaTip"))}">${esc(t("ui.integrations.beta"))}</span>` : ""}</span>${who ? `<span class="ig-avs" title="${esc(t("ui.integrations.who"))}">${who}</span>` : ""}</div>`;
    b.onclick = () => { st.sel = x.id; render(); };
    return b;
  }
  function toolbar() {
    const bar = el("div", "ig-bar");
    bar.innerHTML = `<div class="ig-methods">${["all", "oauth", "token", "open"].map((m) => `<button type="button" class="ig-chip ${st.method === m ? "on" : ""}" data-method="${m}">${esc(t(`ui.integrations.method.${m}`))}</button>`).join("")}</div>
      <div class="ig-dens" role="group"><button type="button" class="${st.dense ? "" : "on"}" data-dense="0" aria-label="${esc(t("ui.integrations.denseGrid"))}" title="${esc(t("ui.integrations.denseGrid"))}">▦</button><button type="button" class="${st.dense ? "on" : ""}" data-dense="1" aria-label="${esc(t("ui.integrations.denseList"))}" title="${esc(t("ui.integrations.denseList"))}">☰</button></div>`;
    bar.querySelectorAll("[data-method]").forEach((b) => (b.onclick = () => { st.method = b.dataset.method; renderMain(); }));
    bar.querySelectorAll("[data-dense]").forEach((b) => (b.onclick = () => { st.dense = b.dataset.dense === "1"; renderMain(); }));
    return bar;
  }
  function section(title, list, cls = "", big = false, count = true) {
    const sec = el("section", "ig-sec-block");
    sec.append(el("h3", "ig-sh", `<span>${esc(title)}</span>${count ? `<small>${list.length}</small>` : ""}`));
    const grid = el("div", `ig-grid${st.dense ? " dense" : ""} ${cls}`);
    for (const x of list) grid.append(card(x, big));
    sec.append(grid);
    return sec;
  }
  function renderMain() {
    const main = root.querySelector("#igMain");
    const top = main.scrollTop;
    main.innerHTML = "";
    if (!st.list) { main.append(el("div", "ig-empty", esc(st.error ? t("ui.settings.unavailable", { message: st.error }) : t("ui.settings.loading")))); return; }
    if (st.view === "perms") { renderPerms(main); return; }
    const browsing = st.cat === "all" && !st.q.trim() && st.method === "all";
    const list = st.list.filter(matches);
    main.append(el("div", "ig-head", `<h2>${esc(st.cat === "all" ? t("ui.integrations.cat.all") : st.cat === "installed" ? t("ui.integrations.cat.installed") : catName(st.cat))}</h2><small>${esc(t("ui.integrations.count", { n: list.length }))}</small>`));
    main.append(toolbar());
    if (!list.length) main.append(el("div", "ig-empty", esc(st.cat === "installed" ? t("ui.integrations.noneInstalled") : t("ui.integrations.noMatch"))));
    else if (browsing) {
      const conn = list.filter((x) => x.added), feat = list.filter((x) => x.featured && !x.added);
      if (conn.length) main.append(section(t("ui.integrations.shelfConnected"), conn, "shelf"));
      if (feat.length) main.append(section(t("ui.integrations.shelfFeatured"), feat, "shelf feat", true, false));
      for (const c of st.cats) { const inCat = list.filter((x) => x.category === c && !x.added); if (inCat.length) main.append(section(catName(c), inCat)); }
    } else {
      const grid = el("div", `ig-grid${st.dense ? " dense" : ""}`);
      for (const x of list) grid.append(card(x));
      main.append(grid);
    }
    main.scrollTop = top;
  }

  // ---------- who may use what: the matrix ----------
  function renderPerms(main) {
    const conn = st.list.filter((x) => x.added), emps = employees();
    main.append(el("div", "ig-head", `<h2>${esc(t("ui.integrations.viewPerms"))}</h2><small>${esc(t("ui.integrations.permsNote"))}</small>`));
    if (!conn.length) { main.append(el("div", "ig-empty", esc(t("ui.integrations.noneInstalled")))); return; }
    const tbl = el("div", "ig-matrix");
    tbl.style.setProperty("--cols", emps.length);
    let html = `<div class="ig-mx-row head"><div class="ig-mx-name"></div>${emps.map(({ e, officeName }) => `<div class="ig-mx-emp" title="${esc(e.name)} · ${esc(officeName)}">${dot(e)}<span>${esc(e.name)}</span></div>`).join("")}<div class="ig-mx-all"></div></div>`;
    for (const x of conn) {
      html += `<div class="ig-mx-row" data-id="${x.id}"><div class="ig-mx-name">${logo(x, "sm")}<span><b>${esc(x.name)}</b><small class="${statusOf(x)}">${esc(statusText(x))}</small></span></div>`
        + emps.map(({ office, e }) => `<label class="ig-mx-cell" title="${esc(e.name)}"><input type="checkbox" data-o="${esc(office)}" data-e="${esc(e.id)}" ${(e.integrations || []).includes(x.id) ? "checked" : ""} ${x.ok === false ? "disabled" : ""} /><i></i></label>`).join("")
        + `<div class="ig-mx-all"><button type="button" class="btn small ghost" data-all="1">${esc(t("ui.integrations.all"))}</button><button type="button" class="btn small ghost" data-all="0">${esc(t("ui.integrations.none"))}</button></div></div>`;
    }
    tbl.innerHTML = html;
    tbl.querySelectorAll("input[type=checkbox]").forEach((c) => (c.onchange = () => toggle(c.dataset.o, c.dataset.e, c.closest(".ig-mx-row").dataset.id, c.checked)));
    tbl.querySelectorAll("[data-all]").forEach((b) => (b.onclick = () => everyone(b.closest(".ig-mx-row").dataset.id, b.dataset.all === "1")));
    main.append(tbl);
  }

  // ---------- the detail drawer ----------
  function renderDrawer() {
    const d = root.querySelector("#igDrawer"), x = st.sel && one(st.sel);
    root.classList.toggle("has-drawer", !!x && st.view === "market");
    if (!x || st.view !== "market") { d.innerHTML = ""; return; }
    const keep = d.querySelector("[data-int-token]")?.value; // a half-typed key survives a re-render
    const err = st.err[x.id];
    let connect = "";
    if (!x.added) {
      const parts = [];
      const oc = x.ownClient;
      if (oc && (!oc.set || st.editClient === oc.group)) parts.push(`<div class="ig-own"><b>${esc(t("ui.integrations.own.title", { name: x.name }))}</b><ol>${[1, 2, 3].map((n) => `<li>${esc(t(`ui.integrations.own.step${n}`))}</li>`).join("")}</ol><label><span>${esc(t("ui.integrations.own.redirect"))}</span><input readonly data-copy value="${esc(location.origin + "/api/integrations/oauth/callback")}" /></label><label><span>${esc(t("ui.integrations.own.clientId"))}</span><input autocomplete="off" data-own-id placeholder="${esc(oc.idHint || "…apps.googleusercontent.com")}" /></label><label><span>${esc(t("ui.integrations.own.clientSecret"))}</span><input type="password" autocomplete="off" data-own-secret /></label><div class="ig-key-act"><button type="button" class="btn primary" data-act="ownsave">${esc(t("ui.integrations.own.save"))}</button><a class="ig-link" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">${esc(t("ui.integrations.own.open"))}</a></div><p class="ig-note">${esc(t("ui.integrations.own.note"))}</p></div>`);
      else if (x.methods.includes("oauth")) parts.push(`<button type="button" class="btn primary" data-act="oauth" ${busy(x.id, "oauth") || pending === x.id ? "disabled" : ""}>${esc(t(busy(x.id, "oauth") || pending === x.id ? "ui.integrations.waiting" : "ui.integrations.signInWith", { name: x.name }))}</button>${oc ? `<button type="button" class="ig-link ig-linkbtn" data-act="ownedit">${esc(t("ui.integrations.own.change"))}</button>` : ""}${pending === x.id && st.signInUrl?.id === x.id ? `<a class="ig-link" href="${esc(st.signInUrl.url)}" target="po-oauth" rel="noopener">${esc(t("ui.integrations.openAgain"))}</a>` : ""}`);
      if (x.methods.includes("token")) parts.push(`<div class="ig-key"><label><span>${esc(t(x.methods.includes("oauth") ? "ui.integrations.orKey" : "ui.integrations.key"))}${x.tokenSpec?.optional ? ` <small>${esc(t("ui.integrations.keyOptional"))}</small>` : ""}</span><input type="password" autocomplete="off" data-int-token placeholder="${esc(x.tokenSpec?.hint || "")}" /></label><div class="ig-key-act"><button type="button" class="btn ${x.methods.includes("oauth") ? "" : "primary"}" data-act="save" ${busy(x.id, "save") ? "disabled" : ""}>${esc(t(busy(x.id, "save") ? "ui.integrations.saving" : "ui.integrations.keyAdd"))}</button>${x.tokenSpec?.help ? `<a class="ig-link" href="${esc(x.tokenSpec.help)}" target="_blank" rel="noopener">${esc(t("ui.integrations.getKey"))}</a>` : ""}</div></div>`);
      if (x.methods.includes("open")) parts.push(`<button type="button" class="btn ${parts.length ? "" : "primary"}" data-act="add" ${busy(x.id, "add") ? "disabled" : ""}>${esc(t(busy(x.id, "add") ? "ui.integrations.saving" : x.methods.length > 1 ? "ui.integrations.addWithout" : "ui.integrations.add"))}</button>`);
      connect = `<div class="ig-sec"><h4>${esc(t("ui.integrations.connect"))}</h4>${parts.join('<div class="ig-or"></div>')}${x.beta ? `<p class="ig-note">${esc(t("ui.integrations.betaTip"))}</p>` : ""}</div>`;
    } else {
      const reauth = x.error === "reauth" || (x.method === "oauth" && x.ok === false && x.error === "auth");
      connect = `<div class="ig-sec"><h4>${esc(t("ui.integrations.connection"))}</h4>
        <div class="ig-conn ${statusOf(x)}"><span class="ig-state ${statusOf(x)}"></span><span>${esc(statusText(x))}</span><small>${esc(t(`ui.integrations.method.${x.method || "open"}`))}${x.keyHint ? ` · ${esc(x.keyHint)}` : ""}</small></div>
        <div class="ig-actions">
          ${reauth && x.methods.includes("oauth") ? `<button type="button" class="btn primary" data-act="oauth">${esc(t("ui.integrations.reconnect"))}</button>` : ""}
          <button type="button" class="btn ghost" data-act="check" ${busy(x.id, "check") ? "disabled" : ""}>${esc(t(busy(x.id, "check") ? "ui.integrations.checking" : "ui.integrations.check"))}</button>
          ${x.methods.includes("token") ? `<button type="button" class="btn ghost" data-act="rekey">${esc(t("ui.integrations.keyUpdate"))}</button>` : ""}
          <button type="button" class="btn danger ghost" data-act="remove">${esc(t("ui.integrations.remove"))}</button>
        </div>
        ${st.rekey === x.id ? `<div class="ig-key"><label><span>${esc(t("ui.integrations.key"))}</span><input type="password" autocomplete="off" data-int-token placeholder="${esc(x.keyHint ? t("ui.integrations.keyReplace", { hint: x.keyHint }) : "")}" /></label><div class="ig-key-act"><button type="button" class="btn primary" data-act="save">${esc(t("ui.integrations.keyAdd"))}</button></div></div>` : ""}
        ${x.tools && x.tools.write ? `<label class="ig-switch"><input type="checkbox" data-act="ro" ${x.readOnly ? "checked" : ""} /><i></i><span><b>${esc(t("ui.integrations.readOnly"))}</b><small>${esc(t("ui.integrations.readOnlyNote"))}</small></span></label>` : ""}
      </div>`;
    }
    const tools = x.tools ? `<div class="ig-sec"><h4>${esc(t("ui.integrations.toolsLine", { total: x.tools.total, read: x.tools.read, write: x.tools.write }))}</h4><div class="ig-tools">${x.tools.names.map((n) => `<span class="ig-tool${n.readOnly ? "" : " w"}" title="${esc(n.desc || n.name)}">${esc(n.name)}</span>`).join("")}</div><p class="ig-note">${esc(t("ui.integrations.toolsNote"))}</p></div>` : "";
    let access = "";
    if (x.added && x.ok !== false) {
      const groups = new Map();
      for (const it of employees()) { if (!groups.has(it.office)) groups.set(it.office, { name: it.officeName, list: [] }); groups.get(it.office).list.push(it); }
      access = `<div class="ig-sec"><h4>${esc(t("ui.integrations.access"))}</h4><div class="ig-actions tight"><button type="button" class="btn small ghost" data-every="1">${esc(t("ui.integrations.all"))}</button><button type="button" class="btn small ghost" data-every="0">${esc(t("ui.integrations.none"))}</button></div>`
        + [...groups].map(([oid, g]) => `${groups.size > 1 ? `<div class="ig-office">${esc(g.name)}</div>` : ""}${g.list.map(({ e }) => `<label class="ig-emp"><input type="checkbox" data-o="${esc(oid)}" data-e="${esc(e.id)}" ${(e.integrations || []).includes(x.id) ? "checked" : ""} /><i></i>${dot(e)}<span><b>${esc(e.name)}</b>${e.role ? `<small>${esc(e.role)}</small>` : ""}</span></label>`).join("")}`).join("")
        + `<p class="ig-note">${esc(t("ui.integrations.accessNote"))}</p></div>`;
    }
    d.innerHTML = `<div class="ig-d-top">${logo(x, "lg")}<div><h3>${esc(x.name)}</h3><a class="ig-host" href="https://${esc(x.host)}" target="_blank" rel="noopener">${esc(x.host)}</a></div><button type="button" class="icon-btn small" data-act="closeDrawer" aria-label="${esc(t("ui.integrations.close"))}">✕</button></div>
      <p class="ig-d-desc">${esc(descOf(x))}</p>${err ? `<div class="ig-err">${esc(err)}</div>` : ""}${connect}${access}${tools}`;
    d.querySelectorAll("[data-copy]").forEach((i) => (i.onfocus = () => i.select()));
    const inp = d.querySelector("[data-int-token]"); if (inp && keep) inp.value = keep;
    d.querySelectorAll("[data-act]").forEach((b) => { const act = b.dataset.act; if (act === "ro") b.onchange = () => run(x.id, "ro", async () => replace((await api("PUT", `/api/integrations/${x.id}`, { readOnly: b.checked })).integration)); else b.onclick = () => act === "oauth" ? signIn(x.id) : act === "ownsave" ? run(x.id, "own", async () => { const id = d.querySelector("[data-own-id]").value.trim(); if (!id) return; st.list = (await api("PUT", `/api/oauth-clients/${x.ownClient.group}`, { clientId: id, clientSecret: d.querySelector("[data-own-secret]").value })).integrations; st.editClient = null; toast(t("ui.settings.saved")); }) : act === "ownedit" ? (st.editClient = x.ownClient.group, renderDrawer()) : act === "closeDrawer" ? (st.sel = null, render()) : act === "add" ? run(x.id, "add", async () => { replace((await api("PUT", `/api/integrations/${x.id}`, { add: true })).integration); toast(t("ui.integrations.connected", { name: x.name })); })
      : act === "save" ? run(x.id, "save", async () => { const v = d.querySelector("[data-int-token]").value.trim(); if (!v) return; replace((await api("PUT", `/api/integrations/${x.id}`, { token: v })).integration); st.rekey = null; toast(t("ui.integrations.keyOk")); })
      : act === "check" ? run(x.id, "check", async () => replace((await api("POST", `/api/integrations/${x.id}/check`)).integration))
      : act === "rekey" ? (st.rekey = st.rekey === x.id ? null : x.id, renderDrawer())
      : act === "remove" ? removeIt(x) : 0; });
    d.querySelectorAll("input[data-o]").forEach((c) => (c.onchange = () => toggle(c.dataset.o, c.dataset.e, x.id, c.checked)));
    d.querySelectorAll("[data-every]").forEach((b) => (b.onclick = () => everyone(x.id, b.dataset.every === "1")));
  }
  async function removeIt(x) {
    if (!confirm(t("ui.integrations.removeAsk", { name: x.name }))) return;
    await run(x.id, "remove", async () => {
      const r = await api("DELETE", `/api/integrations/${x.id}`);
      for (const { e } of employees()) if (e.integrations) e.integrations = e.integrations.filter((i) => i !== x.id);
      if (r.integration) replace(r.integration); else st.list = st.list.filter((y) => y.id !== x.id);
      if (!r.integration) st.sel = null;
      toast(t("ui.integrations.removed"));
    });
  }

  // ---------- add a server of your own ----------
  function renderCustom() {
    const host = root.querySelector("#igCustomDlg");
    host.hidden = !st.custom;
    if (!st.custom) { host.innerHTML = ""; return; }
    const f = st.form;
    host.innerHTML = `<form class="ig-dlg" autocomplete="off"><h3>${esc(t("ui.integrations.custom.title"))}</h3><p class="ig-note">${esc(t("ui.integrations.custom.note"))}</p>
      <label><span>${esc(t("ui.integrations.custom.name"))}</span><input name="name" maxlength="60" required value="${esc(f.name)}" /></label>
      <label><span>${esc(t("ui.integrations.custom.url"))}</span><input name="url" type="url" required placeholder="https://mcp.example.com/mcp" value="${esc(f.url)}" /></label>
      <fieldset><legend>${esc(t("ui.integrations.signIn"))}</legend>${["none", "token", "oauth"].map((a) => `<label class="ig-radio"><input type="radio" name="auth" value="${a}" ${f.auth === a ? "checked" : ""} /><span>${esc(t(`ui.integrations.custom.auth.${a}`))}</span></label>`).join("")}</fieldset>
      ${f.auth === "token" ? `<label><span>${esc(t("ui.integrations.custom.header"))}</span><input name="header" placeholder="Authorization" value="${esc(f.header)}" /></label><label><span>${esc(t("ui.integrations.key"))}</span><input name="token" type="password" required /></label>` : ""}
      <label><span>${esc(t("ui.integrations.custom.desc"))}</span><input name="desc" maxlength="200" value="${esc(f.desc)}" /></label>
      ${f.error ? `<div class="ig-err">${esc(f.error)}</div>` : ""}
      <div class="ig-actions"><button type="submit" class="btn primary" ${f.busy ? "disabled" : ""}>${esc(t(f.busy ? "ui.integrations.checking" : "ui.integrations.custom.add"))}</button><button type="button" class="btn ghost" data-cancel>${esc(t("ui.integrations.cancel"))}</button></div></form>`;
    const form = host.querySelector("form");
    const snap = () => { const d = new FormData(form); for (const k of ["name", "url", "header", "desc"]) if (d.has(k)) f[k] = String(d.get(k)); };
    form.querySelectorAll("input[name=auth]").forEach((r) => (r.onchange = () => { snap(); f.auth = r.value; renderCustom(); }));
    host.querySelector("[data-cancel]").onclick = () => { st.custom = false; renderCustom(); };
    host.onclick = (ev) => { if (ev.target === host) { st.custom = false; renderCustom(); } };
    form.onsubmit = async (ev) => {
      ev.preventDefault(); snap(); f.busy = true; f.error = ""; renderCustom();
      try {
        const d = new FormData(form);
        const r = await api("POST", "/api/integrations/custom", { name: f.name, url: f.url, auth: f.auth, header: f.header || undefined, token: d.has("token") ? String(d.get("token")) : undefined, desc: f.desc || undefined });
        st.custom = false; await load(); st.sel = r.integration.id; st.cat = "installed"; render();
        toast(t(f.auth === "oauth" ? "ui.integrations.custom.signInNext" : "ui.integrations.connected", { name: r.integration.name }));
      } catch (err) { f.busy = false; f.error = errText(err.message); renderCustom(); }
    };
    form.querySelector("input")?.focus();
  }

  function render() { if (!root) return; renderTop(); renderRail(); renderMain(); renderDrawer(); renderCustom(); }
  function build() {
    root = el("div", "igm");
    root.hidden = true;
    root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true");
    root.innerHTML = `<div class="ig-top" id="igTop"></div><div class="ig-body"><nav class="ig-rail" id="igRail"></nav><main class="ig-main" id="igMain"></main><aside class="ig-drawer" id="igDrawer"></aside></div><div class="ig-dlg-host" id="igCustomDlg" hidden></div>`;
    document.body.append(root);
    document.addEventListener("keydown", (ev) => {
      if (!open) return;
      if (ev.key === "Escape") { if (st.custom) { st.custom = false; renderCustom(); } else if (st.sel) { st.sel = null; render(); } else close(); ev.preventDefault(); ev.stopPropagation(); }
      else if (ev.key === "/" && !/^(INPUT|SELECT|TEXTAREA)$/.test((ev.target && ev.target.tagName) || "")) { root.querySelector("#igSearch")?.focus(); ev.preventDefault(); }
    }, true);
  }
  function openMarket(opts = {}) {
    if (!root) build();
    open = true; root.hidden = false;
    document.body.classList.add("igm-open");
    if (opts.id) { st.sel = opts.id; st.view = "market"; }
    if (opts.view) st.view = opts.view;
    render();
    load().then(() => { if (opts.id && !one(opts.id)) st.sel = null; render(); });
  }
  function close() { if (!open) return; open = false; root.hidden = true; clearInterval(poll); pending = null; document.body.classList.remove("igm-open"); }
  // employees arrive (or change) after the page opens: the drawer and the matrix follow
  panelHooks.push((what) => { if (what === "office" && open && st.list && !st.custom) { renderRail(); renderMain(); renderDrawer(); } });
  const btn = document.getElementById("btnIntegrations");
  if (btn) btn.onclick = () => (open ? close() : openMarket());
  const deep = params.get("settings") === "integrations" ? "" : params.get("integrations");
  if (deep !== null) openMarket(deep ? { id: deep } : {});
  return { open: openMarket, close, isOpen: () => open };
})();
window.integrationMarket = integrationMarket;
