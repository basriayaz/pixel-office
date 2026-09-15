const officeId = new URLSearchParams(location.search).get("office") || PO.defaultOffice;
const officeInfo = (PO.offices || []).find((o) => o.id === officeId) || { id: officeId, name: officeId };
const API = `/api/offices/${encodeURIComponent(officeId)}`;
document.title = `${t("ui.hire.crumb")} — ${t("ui.title")}`;
if (PO.multiOffice) { document.querySelector(".crumb").textContent = `${t("ui.hire.crumb")} · ${officeInfo.name}`; document.querySelector("a.btn.ghost").href = `/?office=${encodeURIComponent(officeId)}`; }
let look = null;
const sel = { model: PO.models[0] || "claude-opus-5", effort: "high", perm: "default" };

const editor = new CharEditor($("editor"), { fem: false, hairStyle: "short", top: "#61afef" }, (l) => { look = l; }, { previewEl: $("preview") });
$("pvDate").textContent = new Date().toLocaleDateString(LOCALE_TAG);

function updateCard() {
  const name = $("name").value.trim();
  const role = $("role").value.trim();
  $("pvName").textContent = name || t("ui.hire.noName");
  $("pvRole").textContent = role || t("ui.hire.noRole");
  $("pvBadges").innerHTML = [
    `<span class="badge">${escapeHtml(MODEL_INFO[sel.model]?.name || sel.model)}</span>`,
    `<span class="badge">effort: ${sel.effort}</span>`,
    `<span class="badge">${escapeHtml(PERM_INFO[sel.perm]?.name || sel.perm)}</span>`,
    $("cwd").value.trim() ? `<span class="badge">${escapeHtml(t("ui.hire.cwdBadge", { v: $("cwd").value.trim() }))}</span>` : "",
  ].join("");
  $("summary").innerHTML = name && role
    ? `<b>${escapeHtml(name)}</b> · ${escapeHtml(role)} · ${escapeHtml(MODEL_INFO[sel.model]?.name || sel.model)} · ${sel.effort} · ${escapeHtml(PERM_INFO[sel.perm]?.name || sel.perm)}`
    : `<span class="muted">${t("ui.hire.needNameRole")}</span>`;
  $("hireBtn").disabled = !(name && role);
  const n = $("prompt").value.length;
  $("promptCount").textContent = n ? t("ui.hire.chars", { n }) : "";
}
$("name").oninput = updateCard;
$("role").oninput = updateCard;
$("prompt").oninput = updateCard;
$("cwd").oninput = updateCard;

// preset chips fill role + prompt template
for (const p of PRESETS) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "preset";
  b.textContent = p.role;
  b.onclick = () => {
    document.querySelectorAll(".preset").forEach((x) => x.classList.toggle("on", x === b));
    $("role").value = p.role;
    const name = $("name").value.trim() || "[Name]";
    $("prompt").value = p.prompt.replace(/\{name\}/g, name);
    updateCard();
  };
  $("presets").appendChild(b);
}

buildChoiceCards($("modelCards"), modelItems(), sel.model, (v) => { sel.model = v; updateCard(); });
buildSegment($("effortSeg"), effortItems(), sel.effort, (v) => { sel.effort = v; $("effortHint").textContent = EFFORT_INFO[v]?.desc || ""; updateCard(); });
$("effortHint").textContent = EFFORT_INFO[sel.effort]?.desc || "";
buildChoiceCards($("permCards"), permItems(), sel.perm, (v) => { sel.perm = v; updateCard(); });
if (!officeInfo.employeesDir && !PO.offices?.length) toast(t("ui.hire.noDir"));
updateCard();

$("hireForm").onsubmit = async (ev) => {
  ev.preventDefault();
  const btn = $("hireBtn");
  btn.disabled = true;
  $("hireMsg").textContent = t("ui.hire.working");
  try {
    const e = await api("POST", `${API}/employees`, {
      name: $("name").value.trim(),
      role: $("role").value.trim(),
      prompt: $("prompt").value.trim(),
      look, color: look.top,
      model: sel.model, effort: sel.effort, permissionMode: sel.perm,
      cwd: $("cwd").value.trim() || undefined,
    });
    toast(t("ui.hire.hired", { name: e.name }));
    location.href = `/employee.html?office=${encodeURIComponent(officeId)}&id=${encodeURIComponent(e.id)}`;
  } catch (err) {
    $("hireMsg").textContent = t("ui.hire.error", { message: err.message });
    btn.disabled = false;
  }
};
