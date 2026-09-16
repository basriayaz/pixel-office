// Shared helpers for the office pages. Strings/options come from /i18n.js (window.PO), served by the server.
const PO = window.PO || { locale: "en", strings: { ui: {}, rooms: {}, status: {} }, models: [], efforts: [], permissions: [] };
const $ = (id) => document.getElementById(id);

function tget(key) {
  return key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), PO.strings);
}
const GLOBAL_VARS = { project: PO.projectDisplay || "." };
function t(key, vars = {}) {
  const v = tget(key);
  const s = typeof v === "string" ? v : key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : k in GLOBAL_VARS ? GLOBAL_VARS[k] : `{${k}}`));
}
function applyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => { el.innerHTML = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.documentElement.lang = PO.locale;
}
applyI18n();

const STATUS_T = PO.strings.status || {};
const MODEL_INFO = (PO.strings.ui && PO.strings.ui.models) || {};
const EFFORT_INFO = (PO.strings.ui && PO.strings.ui.efforts) || {};
const PERM_INFO = (PO.strings.ui && PO.strings.ui.perms) || {};
const PRESETS = (PO.strings.ui && PO.strings.ui.presets) || [];

function toast(text) {
  const el = $("toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2800);
}

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

// Adds a "Choose…" button next to a folder input; opens the native folder dialog on the server's machine.
function attachFolderPicker(input) {
  if (!input || input.dataset.picker) return;
  input.dataset.picker = "1";
  const row = document.createElement("div");
  row.className = "pick-row";
  input.parentNode.insertBefore(row, input);
  row.appendChild(input);
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "btn small pick-btn"; btn.textContent = "📁 " + t("ui.pick.btn"); btn.title = t("ui.pick.title");
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await api("POST", "/api/pick-folder", { start: input.value.trim() || ".", prompt: t("ui.pick.prompt") });
      if (r.cancelled) { if (r.error) toast(t("ui.pick.error", { message: r.error })); else toast(t("ui.pick.cancelled")); }
      else { input.value = r.relative === "." ? "" : r.display; input.dispatchEvent(new Event("input", { bubbles: true })); input.focus(); }
    } catch (e) { toast(t("ui.pick.error", { message: e.message })); }
    btn.disabled = false;
  };
  row.appendChild(btn);
}

// Radio-style choice cards: items = [{value, name, desc, tag}]
function buildChoiceCards(host, items, current, onChange) {
  host.innerHTML = "";
  const cards = [];
  for (const it of items) {
    const c = document.createElement("button");
    c.type = "button"; c.className = "choice" + (it.value === current ? " on" : ""); c.dataset.value = it.value;
    const tagClass = it.tag === "risky" ? "warn" : it.tag === "recommended" ? "good" : "";
    const tagText = it.tag ? (tget(`ui.tags.${it.tag}`) || it.tag) : "";
    c.innerHTML = `<div class="choice-top"><b>${escapeHtml(it.name)}</b>${tagText ? `<span class="choice-tag ${tagClass}">${escapeHtml(tagText)}</span>` : ""}</div><small>${escapeHtml(it.desc)}</small>`;
    c.onclick = () => { cards.forEach((x) => x.classList.toggle("on", x === c)); onChange(it.value); };
    host.appendChild(c); cards.push(c);
  }
  return { set: (v) => cards.forEach((x) => x.classList.toggle("on", x.dataset.value === v)) };
}

// Segmented control: items = [{value, name}]
function buildSegment(host, items, current, onChange) {
  host.innerHTML = "";
  const btns = [];
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "seg" + (it.value === current ? " on" : ""); b.dataset.value = it.value; b.textContent = it.name;
    b.onclick = () => { btns.forEach((x) => x.classList.toggle("on", x === b)); onChange(it.value); };
    host.appendChild(b); btns.push(b);
  }
  return { set: (v) => btns.forEach((x) => x.classList.toggle("on", x.dataset.value === v)) };
}

const modelItems = () => PO.models.map((m) => ({ value: m, name: MODEL_INFO[m]?.name || m, desc: MODEL_INFO[m]?.desc || "", tag: MODEL_INFO[m]?.tier || "" }));
const effortItems = () => PO.efforts.map((e) => ({ value: e, name: EFFORT_INFO[e]?.name || e }));
const permItems = () => PO.permissions.map((p) => ({ value: p, name: PERM_INFO[p]?.name || p, desc: PERM_INFO[p]?.desc || "", tag: PERM_INFO[p]?.tag || "" }));

function daysSince(iso) {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d < 0 ? 0 : d;
}

const LOCALE_TAG = PO.locale === "tr" ? "tr-TR" : "en-US";
function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(LOCALE_TAG, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Small, safe Markdown renderer for chat bubbles.
function md(text) {
  const src = String(text ?? "");
  const blocks = [];
  const PH = "";
  let s = src.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => { blocks.push(`<pre><code>${escapeHtml(code.trim())}</code></pre>`); return `${PH}${blocks.length - 1}${PH}`; });
  s = escapeHtml(s);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = s.split("\n");
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(list === "ul" ? "</ul>" : "</ol>"); list = null; } };
  for (const line of lines) {
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const hr = /^\s*---+\s*$/.test(line);
    if (h) { closeList(); out.push(`<h${Math.min(4, h[1].length + 2)}>${h[2]}</h${Math.min(4, h[1].length + 2)}>`); }
    else if (ul) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${ul[1]}</li>`); }
    else if (ol) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${ol[1]}</li>`); }
    else if (hr) { closeList(); out.push("<hr>"); }
    else if (line.trim() === "") { closeList(); out.push("<br>"); }
    else { closeList(); out.push(`<p>${line}</p>`); }
  }
  closeList();
  let html = out.join("").replace(/(<br>){2,}/g, "<br>").replace(/^<br>|<br>$/g, "");
  html = html.replace(new RegExp(`${PH}(\\d+)${PH}`, "g"), (_, i) => blocks[Number(i)]);
  return html;
}
