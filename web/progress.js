// Progress (⭐ in the header strip): finished tasks earn XP. Per-employee levels, office XP that unlocks decor in the office
// scene (office.setProgress), and a daily badge. Server figures only (progress.json); every failure is silent.
const progressUI = (() => {
  const modal = wireModal("progressModal", "progressClose");
  const BADGE_ICON = ["", "🥉", "🥈", "🥇"];
  const seen = new Map(); // office id → last snapshot, so a toast only follows a real change
  const failed = new Set();

  const pOf = (id = state.office) => state.offices.get(id)?.progress;
  const badgeName = (n) => t(`ui.progress.badge.${n}`);

  function renderChip() {
    const p = pOf(), el = $("stripProgress");
    el.hidden = !p;
    if (!p) return;
    const top = Object.values(p.emps || {}).reduce((m, e) => Math.max(m, e.level), 1);
    el.className = "strip-chip" + (p.badge ? " on" : "");
    const nu = p.unlocks.find((n) => p.total < n), pu = [...p.unlocks].reverse().find((n) => p.total >= n) || 0;
    const f = nu ? (p.total - pu) / (nu - pu) : 1;
    el.innerHTML = `<span class="pxp-star">⭐</span><b>${escapeHtml(String(p.total))}</b> <span class="lbl">XP</span><span class="pxp-mini"><i style="width:${Math.round(f * 100)}%"></i></span>${p.badge ? `<span>${BADGE_ICON[p.badge]}</span>` : ""}`;
    el.title = `${t("ui.progress.chipTip")}\n${t("ui.progress.today", { n: p.today })} · ${t("ui.progress.level", { n: top })}`;
  }

  function render() {
    const host = $("progressBody"), p = pOf();
    if (!p) { host.innerHTML = `<div class="muted panel-empty">${escapeHtml(t(failed.has(state.office) ? "ui.costs.unavailable" : "ui.activity.loading"))}</div>`; return; }
    const nextIdx = p.unlocks.findIndex((n) => p.total < n);
    // hero: one bar segment per unlock, each filling between the previous threshold and its own
    const segs = p.unlocks.map((xp, i) => {
      const from = i ? p.unlocks[i - 1] : 0;
      const f = Math.max(0, Math.min(1, (p.total - from) / Math.max(1, xp - from)));
      return `<i class="pxp-seg${f >= 1 ? " full" : ""}${i === nextIdx ? " next" : ""}" title="${escapeHtml(t(`ui.progress.unlock.${i + 1}`))} · ${xp} XP"><b style="width:${Math.round(f * 100)}%"></b></i>`;
    }).join("");
    const toGo = nextIdx >= 0
      ? `<div class="pxp-next">${escapeHtml(t("ui.progress.nextUp", { name: t(`ui.progress.unlock.${nextIdx + 1}`), n: p.unlocks[nextIdx] - p.total }))}</div>`
      : `<div class="pxp-next done">${escapeHtml(t("ui.progress.allUnlocked"))}</div>`;
    // daily badge: three medal slots
    const medals = p.badges.map((n, i) => {
      const on = p.today >= n;
      return `<div class="pxp-medal${on ? " on" : ""}"><span class="mi">${BADGE_ICON[i + 1]}</span><b>${escapeHtml(badgeName(i + 1))}</b><small>${escapeHtml(t("ui.progress.medalNeed", { n }))}</small></div>`;
    }).join("");
    const cards = p.unlocks.map((xp, i) => {
      const on = p.total >= xp;
      return `<div class="pxp-card${on ? " on" : ""}${i === nextIdx ? " next" : ""}"><i>${on ? "✔" : "🔒"}</i><span>${escapeHtml(t(`ui.progress.unlock.${i + 1}`))}</span><small>${on ? "" : escapeHtml(t("ui.progress.locked", { xp }))}</small></div>`;
    }).join("");
    const emps = Object.entries(p.emps || {}).filter(([id]) => cur()?.employees.has(id)).sort((a, b) => b[1].xp - a[1].xp);
    const rows = emps.map(([id, e]) => {
      const m = cur().employees.get(id);
      const f = Math.max(0, Math.min(1, (e.xp - e.from) / Math.max(1, e.next - e.from)));
      return `<div class="pxp-row"><i class="dot" style="background:${escapeHtml(m.color || "var(--idle)")}"></i><span class="pname">${escapeHtml(m.name)}</span><b class="plvl">${escapeHtml(t("ui.progress.level", { n: e.level }))}</b><div class="pxp-bar"><i style="width:${Math.round(f * 100)}%"></i></div><small class="muted">${escapeHtml(t("ui.progress.empRow", { xp: e.xp, tasks: e.tasks ?? 0 }))}</small></div>`;
    }).join("");
    host.innerHTML = `
      <div class="pxp-hero">
        <div class="pxp-top"><b>${escapeHtml(String(p.total))}</b><span>${escapeHtml(t("ui.progress.officeXp"))}</span></div>
        <div class="pxp-track">${segs}</div>
        ${toGo}
      </div>
      <h3>${escapeHtml(t("ui.progress.badgesTitle"))} <small class="muted">${escapeHtml(t("ui.progress.today", { n: p.today }))}</small></h3>
      <div class="pxp-medals">${medals}</div>
      <h3>${escapeHtml(t("ui.progress.unlocks"))}</h3>
      <div class="pxp-cards">${cards}</div>
      <h3>${escapeHtml(t("ui.progress.team"))}</h3>
      <div class="pxp-team">${rows || `<div class="muted">${escapeHtml(t("ui.progress.none"))}</div>`}</div>`;
  }

  // Toasts for what just changed (never on the first snapshot of an office, which is only what was already earned).
  function announce(officeId, p) {
    const old = seen.get(officeId);
    seen.set(officeId, p);
    if (!old || officeId !== state.office) return;
    if (p.badge > old.badge && p.today > old.today) toast(t("ui.progress.toastBadge", { name: badgeName(p.badge) }));
    if (p.unlocked > old.unlocked) toast(t("ui.progress.toastUnlock", { name: t(`ui.progress.unlock.${p.unlocked}`) }));
    for (const [id, e] of Object.entries(p.emps || {})) {
      const was = old.emps?.[id]?.level ?? 1, m = cur()?.employees.get(id);
      if (m && e.level > was) toast(t("ui.progress.toastLevel", { name: m.name, n: e.level }));
    }
  }

  async function load(officeId = state.office) {
    try {
      const p = await api("GET", `/api/offices/${encodeURIComponent(officeId)}/progress`);
      const o = state.offices.get(officeId);
      if (o) { o.progress = p; seen.set(officeId, p); }
    } catch { failed.add(officeId); }
    if (officeId === state.office) { renderChip(); if (modal.open) render(); }
  }

  const show = () => { modal.show(); render(); load(); };
  $("stripProgress").onclick = show;

  panelHooks.push((what, officeId) => {
    if (what !== "office" && what !== "progress") return;
    if (officeId && officeId !== state.office) return;
    try {
      const p = pOf();
      if (what === "progress" && p) announce(state.office, p);
      else if (p && !seen.has(state.office)) seen.set(state.office, p);
      office.setProgress(p ? p.unlocked : 0);
      renderChip();
      if (modal.open) render();
    } catch (err) { console.error(err); }
  });
  return { show };
})();
