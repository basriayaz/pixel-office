// The Skill Market: ready-made skills (SKILL.md folders) from companies and communities, installed onto the employees the boss picks
// (🧩 in the top bar, /?skills). A skill can carry scripts, so nothing is installed blind: the drawer's preview shows the SKILL.md, the
// files and every script with the risky patterns marked, and a skill with scripts asks for that look before it can be installed.
// Look and structure follow the Integration Market (integrations.css).
const skillMarket = (() => {
  const st = { view: "market", cat: "all", q: "", sel: null, list: null, cats: [], installs: {}, error: "", busy: new Set(), err: {}, preview: {}, seen: new Set(), dense: false };
  let root = null, open = false;
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const esc = (s) => escapeHtml(String(s ?? ""));
  const one = (id) => (st.list || []).find((x) => x.id === id);
  const catName = (c) => t(`ui.skills.cat.${c}`);
  const employees = () => { const out = []; for (const [oid, o] of state.offices) for (const e of o.employees.values()) out.push({ office: oid, officeName: o.info?.name || oid, e }); return out; };
  const has = (id, office, emp) => (st.installs[id] || []).some((x) => x.office === office && x.id === emp);
  const holders = (id) => employees().filter((x) => has(id, x.office, x.e.id));
  const countOf = (office, emp) => Object.values(st.installs).filter((l) => l.some((x) => x.office === office && x.id === emp)).length;
  const errText = (e) => { const [code, ...rest] = String(e || "").split(":"); return t(code === "download" ? "ui.skills.err.download" : "ui.skills.err.error", { detail: rest.join(":") }); };
  const dot = (e) => `<span class="ig-av" title="${esc(e.name)}" style="background:${esc(e.color || "var(--idle)")}"></span>`;
  const tokens = (x) => Math.round((x.description.length + x.bodyChars) / 4);

  function luma(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return 1; const n = parseInt(m[1], 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; }
  function hueOf(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  function logo(x, size = "") {
    if (x.icon && /\.(png|svg)$/.test(x.icon)) return `<span class="ig-logo pic ${size}"><img src="/logos/int/${esc(x.icon)}" alt="" loading="lazy" /></span>`;
    if (x.icon) { const brand = x.brand || "#e8e6df"; return `<span class="ig-logo ${size}" style="--brand:${esc(brand)}"><i class="${luma(brand) < 0.32 ? "dark" : ""}" style="--logo:url(/logos/int/${esc(x.icon)}.svg)"></i></span>`; }
    return `<span class="ig-logo mono ${size}" style="--brand:hsl(${hueOf(x.vendor)} 60% 62%)"><b>${esc(x.vendor.replace(/[^A-Za-z0-9]/g, "").slice(0, 2))}</b></span>`;
  }

  async function load() {
    try { const r = await api("GET", "/api/skills"); st.list = r.skills; st.cats = r.categories; st.installs = r.installs; st.error = ""; }
    catch (err) { st.error = err.message; }
    render();
  }
  async function change(id, targets, op) {
    st.busy.add(id); st.err[id] = ""; render();
    try {
      const r = await api("POST", `/api/skills/${id}/${op}`, { targets });
      const bad = r.results.find((x) => x.result === "conflict" || x.result.startsWith("error"));
      if (bad) st.err[id] = bad.result === "conflict" ? t("ui.skills.err.conflict", { name: one(id).name }) : errText(bad.result.replace(/^error:/, ""));
      else toast(t(op === "install" ? "ui.skills.installedToast" : "ui.skills.removedToast"));
      await load();
    } catch (err) { st.err[id] = errText(err.message); }
    st.busy.delete(id); render();
  }
  async function loadPreview(id) {
    st.preview[id] = { loading: true }; renderDrawer();
    try { st.preview[id] = await api("GET", `/api/skills/${id}/preview`); st.seen.add(id); }
    catch (err) { st.preview[id] = { error: errText(err.message) }; }
    renderDrawer();
  }

  function matches(x) {
    if (st.cat === "installed" ? !(st.installs[x.id] || []).length : st.cat !== "all" && x.category !== st.cat) return false;
    const q = st.q.trim().toLowerCase();
    return !q || `${x.name} ${x.vendor} ${x.description} ${catName(x.category)}`.toLowerCase().includes(q);
  }

  function renderTop() {
    const n = Object.values(st.installs).filter((l) => l.length).length;
    root.querySelector("#skTop").innerHTML = `
      <div class="ig-brand"><b>${esc(t("ui.skills.title"))}</b><span>${esc(t("ui.skills.sub"))}</span></div>
      <div class="ig-views" role="tablist">
        <button type="button" class="${st.view === "market" ? "on" : ""}" data-view="market" role="tab">${esc(t("ui.skills.viewMarket"))}</button>
        <button type="button" class="${st.view === "perms" ? "on" : ""}" data-view="perms" role="tab">${esc(t("ui.skills.viewPerms"))}${n ? ` <em>${n}</em>` : ""}</button>
      </div>
      <input class="ig-search" id="skSearch" type="search" autocomplete="off" placeholder="${esc(t("ui.skills.search"))}" value="${esc(st.q)}" />
      <button type="button" class="icon-btn small" id="skClose" aria-label="${esc(t("ui.integrations.close"))}">✕</button>`;
    root.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => { st.view = b.dataset.view; if (st.view === "perms") st.sel = null; render(); }));
    const s = root.querySelector("#skSearch");
    s.oninput = () => { st.q = s.value; st.view = "market"; renderMain(); renderRail(); };
    root.querySelector("#skClose").onclick = close;
  }
  function renderRail() {
    const list = st.list || [];
    const counts = { all: list.length, installed: list.filter((x) => (st.installs[x.id] || []).length).length };
    for (const c of st.cats) counts[c] = list.filter((x) => x.category === c).length;
    const on = (c) => (st.view === "market" && st.cat === c ? " on" : "");
    const hue = (c) => (st.cats.indexOf(c) * 47 + 20) % 360;
    const rail = root.querySelector("#skRail");
    rail.innerHTML = `<div class="ig-tiles"><button type="button" class="ig-tile${on("all")}" data-cat="all"><b>${counts.all}</b><span>${esc(t("ui.skills.cat.all"))}</span></button><button type="button" class="ig-tile conn${on("installed")}" data-cat="installed"><b>${counts.installed}</b><span>${esc(t("ui.skills.cat.installed"))}</span></button></div>`
      + `<div class="ig-rail-h">${esc(t("ui.integrations.categories"))}</div>`
      + st.cats.filter((c) => counts[c]).map((c) => `<button type="button" class="ig-cat${on(c)}" data-cat="${c}" style="--h:${hue(c)}"><i></i><span>${esc(catName(c))}</span><em>${counts[c]}</em></button>`).join("");
    rail.querySelectorAll("[data-cat]").forEach((b) => (b.onclick = () => { st.cat = b.dataset.cat; st.view = "market"; render(); }));
  }
  function card(x) {
    const who = holders(x.id).slice(0, 5).map((h) => dot(h.e)).join("");
    const b = el("button", `ig-card${st.sel === x.id ? " sel" : ""}${who ? " added" : ""}`);
    b.type = "button"; b.dataset.id = x.id;
    b.style.setProperty("--brand", x.brand && luma(x.brand) >= 0.32 ? x.brand : "#8b8f9e");
    b.innerHTML = `<div class="ig-card-top">${logo(x)}<div class="ig-card-name"><b>${esc(x.name)}</b><small>${esc(x.vendor)}</small></div>${who ? `<span class="ig-pill">${esc(t("ui.skills.installedPill"))}</span>` : ""}</div>
      <p>${esc(x.description)}</p>
      <div class="ig-card-foot"><span class="ig-badges"><span class="ig-badge">${esc(x.license)}</span>${x.scripts ? `<span class="ig-badge warn" title="${esc(t("ui.skills.scriptsTip"))}">${esc(t("ui.skills.scripts"))}</span>` : ""}</span>${who ? `<span class="ig-avs">${who}</span>` : ""}</div>`;
    b.onclick = () => { st.sel = x.id; render(); };
    return b;
  }
  function renderMain() {
    const main = root.querySelector("#skMain");
    const top = main.scrollTop;
    main.innerHTML = "";
    if (!st.list) { main.append(el("div", "ig-empty", esc(st.error ? t("ui.settings.unavailable", { message: st.error }) : t("ui.settings.loading")))); return; }
    if (st.view === "perms") { renderPerms(main); return; }
    const list = st.list.filter(matches);
    main.append(el("div", "ig-head", `<h2>${esc(st.cat === "all" ? t("ui.skills.cat.all") : st.cat === "installed" ? t("ui.skills.cat.installed") : catName(st.cat))}</h2><small>${list.length}</small>`));
    main.append(el("p", "ig-note ig-intro", esc(t("ui.skills.intro"))));
    if (!list.length) main.append(el("div", "ig-empty", esc(st.cat === "installed" ? t("ui.skills.noneInstalled") : t("ui.integrations.noMatch"))));
    else {
      const grid = el("div", "ig-grid");
      for (const x of list) grid.append(card(x));
      main.append(grid);
    }
    main.scrollTop = top;
  }
  function renderPerms(main) {
    const conn = st.list.filter((x) => (st.installs[x.id] || []).length), emps = employees();
    main.append(el("div", "ig-head", `<h2>${esc(t("ui.skills.viewPerms"))}</h2><small>${esc(t("ui.skills.permsNote"))}</small>`));
    if (!conn.length) { main.append(el("div", "ig-empty", esc(t("ui.skills.noneInstalled")))); return; }
    const tbl = el("div", "ig-matrix");
    tbl.style.setProperty("--cols", emps.length);
    let html = `<div class="ig-mx-row head"><div class="ig-mx-name"></div>${emps.map(({ e, officeName }) => `<div class="ig-mx-emp" title="${esc(e.name)} · ${esc(officeName)}">${dot(e)}<span>${esc(e.name)}</span></div>`).join("")}<div class="ig-mx-all"></div></div>`;
    for (const x of conn) {
      html += `<div class="ig-mx-row" data-id="${x.id}"><div class="ig-mx-name">${logo(x, "sm")}<span><b>${esc(x.name)}</b><small>${esc(x.vendor)}</small></span></div>`
        + emps.map(({ office, e }) => `<label class="ig-mx-cell" title="${esc(e.name)}"><input type="checkbox" data-o="${esc(office)}" data-e="${esc(e.id)}" ${has(x.id, office, e.id) ? "checked" : ""} /><i></i></label>`).join("")
        + `<div class="ig-mx-all"></div></div>`;
    }
    tbl.innerHTML = html;
    tbl.querySelectorAll("input[type=checkbox]").forEach((c) => (c.onchange = () => toggle(c.closest(".ig-mx-row").dataset.id, c.dataset.o, c.dataset.e, c.checked)));
    main.append(tbl);
  }

  function toggle(id, office, empId, on) {
    const x = one(id);
    if (on && x.scripts && !st.seen.has(id)) { st.sel = id; st.view = "market"; toast(t("ui.skills.previewFirst")); render(); loadPreview(id); return; }
    change(id, [{ office, id: empId }], on ? "install" : "uninstall");
  }
  const FLAG_TIP = (f) => t(`ui.skills.flag.${f}`);
  function renderDrawer() {
    const d = root.querySelector("#skDrawer"), x = st.sel && one(st.sel);
    root.classList.toggle("has-drawer", !!x && st.view === "market");
    if (!x || st.view !== "market") { d.innerHTML = ""; return; }
    const err = st.err[x.id], pv = st.preview[x.id];
    let preview = "";
    if (!pv) preview = `<button type="button" class="btn" data-act="preview">${esc(t("ui.skills.preview"))}</button>`;
    else if (pv.loading) preview = `<div class="ig-note">${esc(t("ui.settings.loading"))}</div>`;
    else if (pv.error) preview = `<div class="ig-err">${esc(pv.error)}</div><button type="button" class="btn" data-act="preview">${esc(t("ui.skills.preview"))}</button>`;
    else {
      const fl = [...new Set(pv.flags.map((f) => f.flag))];
      preview = `${fl.length ? `<div class="ig-err">${esc(t("ui.skills.flagsTitle"))}<ul>${fl.map((f) => `<li><b>${esc(FLAG_TIP(f))}</b> <small>${esc(pv.flags.filter((y) => y.flag === f).map((y) => y.file).slice(0, 4).join(", "))}</small></li>`).join("")}</ul></div>` : `<div class="ig-note">${esc(t("ui.skills.clean"))}</div>`}
        <details open><summary>SKILL.md</summary><pre class="sk-pre">${esc(pv.skillMd)}</pre></details>
        <details><summary>${esc(t("ui.skills.filesTitle", { n: pv.files.length }))}</summary><div class="sk-files">${pv.files.map((f) => `<div class="${f.script ? "w" : ""}"><span>${esc(f.path)}</span><small>${(f.bytes / 1024).toFixed(1)} KB</small></div>`).join("")}</div></details>
        ${pv.scripts.map((s) => `<details><summary class="sk-warn">${esc(s.path)}</summary><pre class="sk-pre">${esc(s.text)}${s.truncated ? "\n…" : ""}</pre></details>`).join("")}`;
    }
    const groups = new Map();
    for (const it of employees()) { if (!groups.has(it.office)) groups.set(it.office, { name: it.officeName, list: [] }); groups.get(it.office).list.push(it); }
    const access = `<div class="ig-sec"><h4>${esc(t("ui.skills.installOn"))}</h4><div class="ig-actions tight"><button type="button" class="btn small ghost" data-every="1">${esc(t("ui.skills.everyone"))}</button><button type="button" class="btn small ghost" data-every="0">${esc(t("ui.integrations.none"))}</button></div>`
      + [...groups].map(([oid, g]) => `${groups.size > 1 ? `<div class="ig-office">${esc(g.name)}</div>` : ""}${g.list.map(({ e }) => `<label class="ig-emp"><input type="checkbox" data-o="${esc(oid)}" data-e="${esc(e.id)}" ${has(x.id, oid, e.id) ? "checked" : ""} ${st.busy.has(x.id) ? "disabled" : ""} /><i></i>${dot(e)}<span><b>${esc(e.name)}</b><small>${esc(t("ui.skills.count", { n: countOf(oid, e.id) }))}${countOf(oid, e.id) >= 6 ? ` · ${esc(t("ui.skills.many"))}` : ""}</small></span></label>`).join("")}`).join("")
      + `<p class="ig-note">${esc(t("ui.skills.installNote"))}</p></div>`;
    d.innerHTML = `<div class="ig-d-top">${logo(x, "lg")}<div><h3>${esc(x.name)}</h3><a class="ig-host" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.vendor)} · ${esc(x.repo)}@${esc(x.sha.slice(0, 7))}</a></div><button type="button" class="icon-btn small" data-act="closeDrawer" aria-label="${esc(t("ui.integrations.close"))}">✕</button></div>
      <p class="ig-d-desc">${esc(x.description)}</p>
      <div class="ig-badges sk-meta"><span class="ig-badge">${esc(x.license)}</span><span class="ig-badge">${esc(t("ui.skills.meta", { files: x.files, kb: x.kb }))}</span><span class="ig-badge" title="${esc(t("ui.skills.tokensTip"))}">~${tokens(x)} ${esc(t("ui.skills.tokens"))}</span>${x.scripts ? `<span class="ig-badge warn">${esc(t("ui.skills.scripts"))}</span>` : ""}</div>
      ${err ? `<div class="ig-err">${esc(err)}</div>` : ""}
      <div class="ig-sec"><h4>${esc(t("ui.skills.previewTitle"))}</h4>${x.scripts ? `<p class="ig-note">${esc(t("ui.skills.scriptsTip"))}</p>` : ""}${preview}</div>${access}`;
    d.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => (b.dataset.act === "preview" ? loadPreview(x.id) : (st.sel = null, render()))));
    d.querySelectorAll("input[data-o]").forEach((c) => (c.onchange = () => toggle(x.id, c.dataset.o, c.dataset.e, c.checked)));
    d.querySelectorAll("[data-every]").forEach((b) => (b.onclick = () => {
      const on = b.dataset.every === "1";
      if (on && x.scripts && !st.seen.has(x.id)) { toast(t("ui.skills.previewFirst")); loadPreview(x.id); return; }
      const targets = employees().filter((it) => has(x.id, it.office, it.e.id) !== on).map((it) => ({ office: it.office, id: it.e.id }));
      if (targets.length) change(x.id, targets, on ? "install" : "uninstall");
    }));
  }

  function render() { if (!root) return; renderTop(); renderRail(); renderMain(); renderDrawer(); }
  function build() {
    root = el("div", "igm");
    root.hidden = true;
    root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true");
    root.innerHTML = `<div class="ig-top" id="skTop"></div><div class="ig-body"><nav class="ig-rail" id="skRail"></nav><main class="ig-main" id="skMain"></main><aside class="ig-drawer" id="skDrawer"></aside></div>`;
    document.body.append(root);
    document.addEventListener("keydown", (ev) => {
      if (!open) return;
      if (ev.key === "Escape") { if (st.sel) { st.sel = null; render(); } else close(); ev.preventDefault(); ev.stopPropagation(); }
      else if (ev.key === "/" && !/^(INPUT|SELECT|TEXTAREA)$/.test((ev.target && ev.target.tagName) || "")) { root.querySelector("#skSearch")?.focus(); ev.preventDefault(); }
    }, true);
  }
  function openMarket(opts = {}) {
    if (!root) build();
    open = true; root.hidden = false;
    document.body.classList.add("igm-open");
    if (opts.id) { st.sel = opts.id; st.view = "market"; }
    render();
    load().then(() => { if (opts.id && !one(opts.id)) st.sel = null; render(); });
  }
  function close() { if (!open) return; open = false; root.hidden = true; document.body.classList.remove("igm-open"); }
  panelHooks.push((what) => { if (what === "office" && open && st.list) { renderRail(); renderMain(); renderDrawer(); } });
  const btn = document.getElementById("btnSkills");
  if (btn) btn.onclick = () => (open ? close() : openMarket());
  const deep = params.get("skills");
  if (deep !== null) openMarket(deep ? { id: deep } : {});
  return { open: openMarket, close, isOpen: () => open };
})();
window.skillMarket = skillMarket;
