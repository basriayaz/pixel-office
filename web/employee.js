const qs = new URLSearchParams(location.search);
const id = qs.get("id");
const officeId = qs.get("office") || PO.defaultOffice;
const API = `/api/offices/${encodeURIComponent(officeId)}`;
if (!id) location.href = "/";
let detail = null;
let editor = null;
let look = null;
let editingSkill = null;
const settings = { model: "", effort: "", perm: "default" };

for (const b of document.querySelectorAll("#tabs button")) {
  b.onclick = () => {
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll(".tab").forEach((tab) => (tab.hidden = tab.dataset.tab !== b.dataset.tab));
    history.replaceState(null, "", `#${b.dataset.tab}`);
  };
}
if (location.hash) document.querySelector(`#tabs button[data-tab="${location.hash.slice(1)}"]`)?.click();
$("fireHint").innerHTML = t("ui.profile.fireHint", { archive: "_archive" });
resetSkillForm();

async function load() {
  detail = await api("GET", `${API}/employees/${encodeURIComponent(id)}/detail`);
  renderHead();
  if (!editor) {
    editor = new CharEditor($("editor"), detail.look, (l) => { look = l; });
    $("fName").value = detail.name;
    $("fRole").value = detail.role;
    $("fPrompt").value = detail.prompt;
    settings.model = detail.configuredModel ?? "";
    settings.effort = detail.effort ?? "";
    settings.perm = detail.permissionMode;
    buildChoiceCards($("fModel"), [{ value: "", name: t("ui.profile.modelDefault"), desc: t("ui.profile.modelDefaultDesc"), tag: "" }, ...modelItems()], settings.model, (v) => { settings.model = v; });
    buildSegment($("fEffort"), [{ value: "", name: t("ui.profile.effortDefault") }, ...effortItems()], settings.effort, (v) => { settings.effort = v; $("effortHint").textContent = EFFORT_INFO[v]?.desc || ""; });
    $("effortHint").textContent = EFFORT_INFO[settings.effort]?.desc || "";
    buildChoiceCards($("fPerm"), permItems(), settings.perm, (v) => { settings.perm = v; });
    $("fRefresh").value = detail.refreshHours;
    $("fCwd").value = detail.cwd === detail.officeCwd ? "" : detail.cwd;
  }
  $("memory").value = detail.memory;
  $("memPath").textContent = detail.memoryFile || "";
  $("skillsPath").textContent = detail.skillsDir || "";
  $("refreshInfo").textContent = detail.lastRefresh ? t("ui.profile.lastRefresh", { date: fmtDate(detail.lastRefresh) }) : t("ui.profile.neverRefreshed");
  renderSkills();
  renderRecent();
}

function renderHead() {
  document.title = `${detail.name} — ${t("ui.title")}`;
  $("crumb").textContent = PO.multiOffice ? `${detail.officeName} · ${detail.name}` : detail.name;
  $("chatLink").href = `/?office=${encodeURIComponent(officeId)}&open=${encodeURIComponent(id)}`;
  $("bigPortrait").src = portraitOf(detail, 5, true);
  $("pName").textContent = detail.name;
  $("pRole").textContent = detail.role;
  const st = $("pStatus");
  st.className = "chip " + detail.status;
  st.textContent = STATUS_T[detail.status] || detail.status;
  const days = daysSince(detail.hired);
  $("pMeta").innerHTML = [
    detail.hired ? `${t("ui.profile.hiredOn", { date: new Date(detail.hired).toLocaleDateString(LOCALE_TAG) })} (${days === 0 ? t("ui.profile.startedToday") : t("ui.profile.withUs", { n: days })})` : "",
    `${t("ui.profile.workdir")} <code>${escapeHtml(detail.cwd)}</code>`,
  ].filter(Boolean).join("<br>");
  const model = detail.model || detail.configuredModel;
  $("pBadges").innerHTML = [
    `<span class="badge">${escapeHtml(model ? model.replace("claude-", "") : t("ui.profile.defaultModel"))}</span>`,
    detail.effort ? `<span class="badge">${escapeHtml(t("ui.profile.effortBadge", { v: detail.effort }))}</span>` : "",
    `<span class="badge">${escapeHtml(PERM_INFO[detail.permissionMode]?.name || detail.permissionMode)}</span>`,
    detail.skills.length ? `<span class="badge">${escapeHtml(t("ui.profile.skillsBadge", { n: detail.skills.length }))}</span>` : "",
  ].join("");
  $("pStats").innerHTML = `
    <div><b>${detail.stats.tasks}</b><span>${t("ui.profile.stats.tasks")}</span></div>
    <div><b>${detail.stats.messages}</b><span>${t("ui.profile.stats.messages")}</span></div>
    <div><b>$${(detail.cost || 0).toFixed(2)}</b><span>${t("ui.profile.stats.cost")}</span></div>
    <div><b>${detail.stats.lastActivity ? new Date(detail.stats.lastActivity).toLocaleDateString(LOCALE_TAG) : "—"}</b><span>${t("ui.profile.stats.last")}</span></div>`;
}

function renderSkills() {
  const host = $("skillList");
  host.innerHTML = detail.skills.length ? "" : `<div class="muted">${t("ui.profile.noSkills")}</div>`;
  for (const s of detail.skills) {
    const row = document.createElement("div");
    row.className = "skill";
    row.innerHTML = `<div><b>${escapeHtml(s.name)}</b><div class="muted">${escapeHtml(s.description)}</div></div>
      <div class="skill-actions"><button class="btn small" data-act="edit">${t("ui.profile.edit")}</button><button class="btn small danger" data-act="del">${t("ui.profile.delete")}</button></div>`;
    row.querySelector('[data-act="edit"]').onclick = async () => {
      const full = await api("GET", `${API}/employees/${encodeURIComponent(id)}/skills/${encodeURIComponent(s.name)}`);
      editingSkill = s.name;
      $("skillFormTitle").textContent = t("ui.profile.editSkill", { name: s.name });
      $("sName").value = full.name; $("sName").disabled = true;
      $("sDesc").value = full.description; $("sBody").value = full.body;
      $("skillSave").textContent = t("ui.profile.save"); $("skillCancel").hidden = false;
      $("sDesc").focus();
    };
    row.querySelector('[data-act="del"]').onclick = async () => {
      const btn = row.querySelector('[data-act="del"]');
      if (row.dataset.armed !== "1") { row.dataset.armed = "1"; btn.textContent = t("ui.profile.sure"); setTimeout(() => { row.dataset.armed = ""; btn.textContent = t("ui.profile.delete"); }, 3000); return; }
      await api("DELETE", `${API}/employees/${encodeURIComponent(id)}/skills/${encodeURIComponent(s.name)}`);
      toast(t("ui.profile.skillDeleted"));
      load();
    };
    host.appendChild(row);
  }
}

function resetSkillForm() {
  editingSkill = null;
  $("skillFormTitle").textContent = t("ui.profile.newSkill");
  $("sName").value = ""; $("sName").disabled = false; $("sDesc").value = ""; $("sBody").value = "";
  $("skillSave").textContent = t("ui.profile.add"); $("skillCancel").hidden = true;
}
$("skillCancel").onclick = resetSkillForm;
$("skillForm").onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    await api("POST", `${API}/employees/${encodeURIComponent(id)}/skills`, { name: editingSkill || $("sName").value, description: $("sDesc").value, body: $("sBody").value });
    toast(editingSkill ? t("ui.profile.skillSaved") : t("ui.profile.skillAdded"));
    resetSkillForm();
    load();
  } catch (err) { toast(t("ui.profile.error", { message: err.message })); }
};

function renderRecent() {
  const host = $("recent");
  host.innerHTML = detail.recent.length ? "" : `<div class="muted">${t("ui.profile.noHistory")}</div>`;
  const who = { user: t("ui.profile.you"), assistant: detail.name, activity: t("ui.profile.action"), system: t("ui.profile.system"), auto: t("ui.profile.auto"), colleague: t("ui.profile.colleague") };
  for (const m of [...detail.recent].reverse()) {
    const row = document.createElement("div");
    row.className = "recent-row " + m.role;
    row.innerHTML = `<div class="recent-meta">${escapeHtml(who[m.role] || m.role)} · ${fmtDate(m.ts)}</div><div class="recent-text">${escapeHtml(m.text).slice(0, 600)}</div>`;
    host.appendChild(row);
  }
}

$("saveProfile").onclick = async () => {
  try {
    await api("PUT", `${API}/employees/${encodeURIComponent(id)}`, { name: $("fName").value, role: $("fRole").value, prompt: $("fPrompt").value, look, color: look?.top });
    toast(t("ui.profile.profileSaved"));
    load();
  } catch (err) { toast(t("ui.profile.error", { message: err.message })); }
};

$("saveSettings").onclick = async () => {
  try {
    await api("PUT", `${API}/employees/${encodeURIComponent(id)}`, { model: settings.model, effort: settings.effort, permissionMode: settings.perm, refreshHours: Number($("fRefresh").value), cwd: $("fCwd").value.trim() });
    toast(t("ui.profile.settingsSaved"));
    load();
  } catch (err) { toast(t("ui.profile.error", { message: err.message })); }
};

$("saveMemory").onclick = async () => {
  try {
    await api("PUT", `${API}/employees/${encodeURIComponent(id)}/memory`, { text: $("memory").value });
    toast(t("ui.profile.memorySaved"));
  } catch (err) { toast(t("ui.profile.error", { message: err.message })); }
};

$("refreshBtn").onclick = async () => {
  try {
    await api("POST", `${API}/employees/${encodeURIComponent(id)}/refresh`);
    toast(t("ui.profile.refreshing", { name: detail.name }));
    setTimeout(load, 1500);
  } catch (err) { toast(t("ui.profile.error", { message: err.message })); }
};

$("fireConfirm").oninput = () => { $("fireBtn").disabled = $("fireConfirm").value.trim().toLowerCase() !== detail?.name.toLowerCase(); };
$("fireBtn").onclick = async () => {
  try {
    await api("DELETE", `${API}/employees/${encodeURIComponent(id)}`);
    location.href = `/?office=${encodeURIComponent(officeId)}`;
  } catch (err) { toast(t("ui.profile.error", { message: err.message })); }
};

load().catch((err) => { toast(t("ui.profile.loadError", { message: err.message })); });
setInterval(() => { if (document.visibilityState === "visible") api("GET", `${API}/employees/${encodeURIComponent(id)}/detail`).then((d) => { detail = d; renderHead(); }).catch(() => {}); }, 8000);
