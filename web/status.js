// Status list: a compact one-row-per-employee view of the roster (toggle ☰ / ▦, remembered in this browser). Shows
// everyone, also those beyond the 12 desks the office has room for, with task, time on it, context, spend and unread.
window.statusUI = (() => {
  const DESKS = 12; // office.js seats this many
  const KEY = "po.rosterList";
  let list = false;
  try { list = localStorage.getItem(KEY) === "1"; } catch {}

  function toggle(on = !list) {
    list = on;
    try { localStorage.setItem(KEY, list ? "1" : "0"); } catch {}
    renderRoster();
    setTimeout(() => office.fit(), 0); // the roster's height changed
  }
  function toggleBtn(el) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "icon-btn small roster-toggle";
    b.textContent = list ? "▦" : "☰";
    b.title = t(list ? "ui.status.chips" : "ui.status.list");
    b.onclick = () => toggle();
    el.appendChild(b);
  }

  // chips view: the switch, and a hint when some employees have no desk (they are not drawn in the office)
  function decorate(el) {
    el.classList.remove("list");
    const n = cur()?.employees.size || 0;
    if (n > DESKS) {
      const h = document.createElement("button");
      h.type = "button"; h.className = "roster-chip roster-more";
      h.textContent = t("ui.status.noDesk", { n: n - DESKS });
      h.title = t("ui.status.noDeskTip");
      h.onclick = () => toggle(true);
      el.appendChild(h);
    }
    toggleBtn(el);
  }

  const taskTitle = (id) => cur()?.board?.tasks?.find((k) => k.id === id)?.title || "";
  function renderList(el) {
    if (!list) return false;
    el.classList.add("list");
    const today = new Map((costsUI.report()?.byEmployee || []).map((x) => [x.emp, x]));
    costsUI.ensureReport();
    [...cur().employees.values()].forEach((e, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "srow" + (e.id === state.selected ? " selected" : "");
      const st = e.compacting ? t("ui.chat.compacting") : STATUS_T[e.status] || e.status;
      const busy = e.status === "working" || e.status === "waiting";
      const task = e.task != null ? `<span class="stask"><b>#${e.task}</b> ${escapeHtml(taskTitle(e.task))}</span>` : `<span class="stask muted">${escapeHtml(t("ui.status.noTask"))}</span>`;
      const c = today.get(e.id);
      const pic = office.portrait(e.id); // only employees at a desk have a drawn portrait
      const cost = c ? (e.engine === "codex" ? (c.codexTokens ? fmtTokens(c.codexTokens) : "") : c.today >= 0.01 ? usd(c.today) : "") : "";
      row.innerHTML = `<i class="dot ${e.status}"></i>${pic ? `<img src="${pic}" alt="" />` : `<span class="spic" style="background:${escapeHtml(e.color || "var(--idle)")}"></span>`}<span class="sname"><b>${escapeHtml(e.name)}</b><small>${escapeHtml(e.role || "")}</small></span>`
        + `<span class="sstate">${escapeHtml(st)}${busy && e.since ? ` · ${fmtDur(Date.now() - e.since)}` : ""}</span>${task}`
        + `<span class="snum" title="${escapeHtml(t("ui.status.contextTip"))}">${e.context >= 1000 ? `${Math.round(e.context / 1000)}k` : ""}</span>`
        + `<span class="snum" title="${escapeHtml(t("ui.status.costTip"))}">${escapeHtml(cost)}</span>`
        + `${i >= DESKS ? `<span class="tag" title="${escapeHtml(t("ui.status.noDeskTip"))}">${escapeHtml(t("ui.status.noDeskTag"))}</span>` : ""}${e.unread ? `<span class="badge">${e.unread}</span>` : ""}`;
      row.onclick = () => openChat(e.id);
      el.appendChild(row);
    });
    toggleBtn(el);
    return true;
  }

  // time on the current work moves on by itself
  setInterval(() => { if (list && cur()) renderRoster(); }, 30e3);
  return { renderList, decorate, get list() { return list; } };
})();
