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
    el.innerHTML = `⭐ ${escapeHtml(String(p.total))} <span class="lbl">XP</span>${p.badge ? ` <span>${BADGE_ICON[p.badge]}</span>` : ""}`;
    el.title = `${t("ui.progress.chipTip")}\n${t("ui.progress.today", { n: p.today })} · ${t("ui.progress.level", { n: top })}`;
  }

  function render() {
    const host = $("progressBody"), p = pOf();
    if (!p) { host.innerHTML = `<div class="muted panel-empty">${escapeHtml(t(failed.has(state.office) ? "ui.costs.unavailable" : "ui.activity.loading"))}</div>`; return; }
    const nextBadge = p.badges.findIndex((n) => p.today < n);
    const badgeLine = p.badge
      ? `<span class="pbadge">${BADGE_ICON[p.badge]}</span> <b>${escapeHtml(badgeName(p.badge))}</b>`
      : `<span class="muted">${escapeHtml(t("ui.progress.badgeNone"))}</span>`;
    const more = nextBadge >= 0 ? `<small class="muted">${escapeHtml(t("ui.progress.badgeNext", { n: p.badges[nextBadge] - p.today, name: badgeName(nextBadge + 1) }))}</small>` : "";
    const nextUnlock = p.unlocks.find((n) => p.total < n);
    const prevUnlock = [...p.unlocks].reverse().find((n) => p.total >= n) || 0;
    const pct = nextUnlock ? (p.total - prevUnlock) / (nextUnlock - prevUnlock) : 1;
    const unlocks = p.unlocks.map((xp, i) => {
      const on = p.total >= xp;
      return `<div class="punlock${on ? " on" : ""}"><i>${on ? "✔" : "🔒"}</i><span>${escapeHtml(t(`ui.progress.unlock.${i + 1}`))}</span><small class="muted">${on ? "" : escapeHtml(t("ui.progress.locked", { xp }))}</small></div>`;
    }).join("");
    const emps = Object.entries(p.emps || {}).filter(([id]) => cur()?.employees.has(id)).sort((a, b) => b[1].xp - a[1].xp);
    const rows = emps.map(([id, e]) => {
      const m = cur().employees.get(id);
      const f = Math.max(0, Math.min(1, (e.xp - e.from) / Math.max(1, e.next - e.from)));
      return `<div class="prow"><i class="dot" style="background:${escapeHtml(m.color || "var(--idle)")}"></i><span class="pname">${escapeHtml(m.name)}</span><b class="plvl">${escapeHtml(t("ui.progress.level", { n: e.level }))}</b><div class="cbar"><i style="width:${Math.round(f * 100)}%"></i></div><small class="muted">${escapeHtml(t("ui.progress.empRow", { xp: e.xp, tasks: e.tasks }))}</small></div>`;
    }).join("");
    host.innerHTML = `
      <div class="ctoday">
        <div class="ctop"><b>${escapeHtml(String(p.total))}</b> <span class="muted">${escapeHtml(t("ui.progress.officeXp"))}</span></div>
        <div class="cbar"><i style="width:${Math.round(pct * 100)}%"></i></div>
        <div class="pbadgeline">${badgeLine} <span class="muted">· ${escapeHtml(t("ui.progress.today", { n: p.today }))}</span></div>${more}
      </div>
      <h3>${escapeHtml(t("ui.progress.unlocks"))}</h3>
      <div class="punlocks">${unlocks}</div>
      <h3>${escapeHtml(t("ui.progress.team"))}</h3>
      ${rows || `<div class="muted">${escapeHtml(t("ui.progress.none"))}</div>`}`;
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
