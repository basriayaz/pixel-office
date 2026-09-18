const office = new Office($("office"), $("labels"));
office.start();
document.title = t("ui.title");

const params = new URLSearchParams(location.search);
const state = {
  offices: new Map(),          // id -> { info, employees: Map }
  office: params.get("office") || localStorage.getItem("po.office") || PO.defaultOffice,
  selected: null, ws: null, online: false,
};
const chatBody = $("chatBody");
let streamEl = null;
let typingEl = null;

const cur = () => state.offices.get(state.office);
const employeesOf = (officeId) => state.offices.get(officeId)?.employees;

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  state.ws = ws;
  ws.onopen = () => {
    state.online = true;
    office.setOffline(false);
    document.body.classList.remove("offline");
  };
  ws.onclose = () => {
    if (state.online && !state.closed) toast(t("ui.toast.disconnected"));
    state.online = false;
    office.setOffline(true);
    document.body.classList.add("offline");
    if (!state.closed) setTimeout(connect, 1500); // after a deliberate shutdown, stay closed
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

function send(payload) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ office: state.office, ...payload }));
  else toast(t("ui.toast.noConnection"));
}

function mergeRoster(officeId, list, info) {
  const prev = state.offices.get(officeId);
  const employees = new Map();
  for (const e of list) {
    const old = prev?.employees.get(e.id);
    employees.set(e.id, { ...e, messages: old?.messages ?? [], pending: old?.pending ?? [], loaded: old?.loaded ?? false, unread: old?.unread ?? 0 });
  }
  state.offices.set(officeId, { info: info ?? prev?.info ?? { id: officeId, name: officeId }, employees, meeting: prev?.meeting ?? null, board: prev?.board ?? null });
}

function showOffice(officeId, keepChat = false) {
  if (!state.offices.has(officeId)) officeId = state.offices.keys().next().value;
  const changed = officeId !== state.office;
  state.office = officeId;
  localStorage.setItem("po.office", officeId);
  if (changed && !keepChat) closeChat();
  const o = cur();
  office.setTheme(o.info.theme || "default");
  office.setEmployees([...o.employees.values()], state.entering);
  if (state.entering) { for (const id of state.entering) { const e = o.employees.get(id); if (e) toast(t("ui.toast.hired", { name: e.name })); } state.entering = null; }
  for (const e of o.employees.values()) office.setUnread(e.id, e.unread);
  $("hireLink").href = `hire.html?office=${encodeURIComponent(officeId)}`;
  renderOfficeTabs();
  renderRoster();
  office.fit(); // roster height changes with head-count
  if (state.selected && o.employees.has(state.selected)) { renderHead(o.employees.get(state.selected)); send({ type: "open", id: state.selected }); }
  else if (state.selected) closeChat();
  meetingUI.sync();
  boardUI.refresh();
}

function renderOfficeTabs() {
  const host = $("offices");
  host.innerHTML = "";
  if (!PO.multiOffice) { host.hidden = true; return; }
  host.hidden = false;
  for (const o of state.offices.values()) {
    const b = document.createElement("button");
    b.className = "office-tab" + (o.info.id === state.office ? " on" : "");
    const unread = [...o.employees.values()].reduce((n, e) => n + (e.unread || 0), 0);
    const busy = [...o.employees.values()].some((e) => e.status === "working" || e.status === "waiting");
    b.innerHTML = `${busy ? '<i class="dot working"></i>' : ""}<span>${escapeHtml(o.info.name)}</span>${unread ? `<span class="badge">${unread}</span>` : ""}`;
    b.onclick = () => { showOffice(o.info.id); history.replaceState(null, "", `/?office=${encodeURIComponent(o.info.id)}`); };
    host.appendChild(b);
  }
}

function handle(m) {
  if (m.type === "shutdown") { markClosed(); return; }
  if (m.type === "reload") { setTimeout(() => location.reload(), 300); return; }
  if (m.type === "init") {
    for (const o of m.offices) { mergeRoster(o.id, o.employees, { id: o.id, name: o.name, cwd: o.cwd, theme: o.theme }); state.offices.get(o.id).meeting = o.meeting ?? null; state.offices.get(o.id).board = o.board ?? null; }
    const hired = params.get("hired");
    if (hired && !state.inited) { state.entering = new Set([hired]); history.replaceState(null, "", `/?office=${encodeURIComponent(state.office)}`); }
    state.inited = true;
    showOffice(state.office, true);
    const open = params.get("open");
    if (open && cur().employees.has(open) && !state.selected) { openChat(open); history.replaceState(null, "", `/?office=${encodeURIComponent(state.office)}`); }
    return;
  }
  if (m.type === "offices") {
    PO.multiOffice = m.multiOffice;
    const seen = new Set();
    for (const o of m.offices) { seen.add(o.id); mergeRoster(o.id, o.employees, { id: o.id, name: o.name, cwd: o.cwd, theme: o.theme }); }
    for (const id of [...state.offices.keys()]) if (!seen.has(id)) state.offices.delete(id);
    showOffice(state.offices.has(state.office) ? state.office : m.offices[0]?.id, true);
    if (!$("officesModal").hidden) renderOfficeList();
    return;
  }
  if (m.type === "roster") {
    const before = new Set(employeesOf(m.office)?.keys() ?? []);
    mergeRoster(m.office, m.employees);
    if (m.office === state.office) { state.entering = new Set(m.employees.map((e) => e.id).filter((id) => !before.has(id))); if (!state.entering.size) state.entering = null; showOffice(m.office, true); }
    else renderOfficeTabs();
    return;
  }
  if (m.type === "meeting" || m.type === "meeting_entry") { meetingUI.onMessage(m); return; }
  if (m.type === "board") { const o = state.offices.get(m.office); if (o) { o.board = m.board; boardUI.refresh(m.office); } return; }
  const e = employeesOf(m.office)?.get(m.id);
  if (!e) return;
  const current = m.office === state.office;
  const selected = current && m.id === state.selected;
  switch (m.type) {
    case "status":
      e.status = m.status;
      e.sickUntil = m.sickUntil || 0;
      if (current) { meetingUI.onStatus(); boardUI.refresh(); }
      if (current) { office.setStatus(m.id, m.status, m.reason); renderRoster(); }
      renderOfficeTabs();
      if (selected) { renderHead(e); updateTyping(e); }
      break;
    case "history":
      e.messages = m.messages;
      e.pending = m.pending;
      e.loaded = true;
      if (selected) renderChat(e);
      break;
    case "message":
      e.messages.push(m.message);
      if (selected) {
        endStream();
        appendMessage(e, m.message);
        updateTyping(e);
        scrollDown(m.message.role === "user");
      } else if (m.message.role === "assistant" || m.message.role === "colleague") {
        e.unread++;
        if (current) { office.setUnread(e.id, e.unread); renderRoster(); }
        renderOfficeTabs();
      }
      if ((m.message.role === "assistant" || m.message.role === "colleague") && (!selected || document.hidden)) notify(e, m.office, t("ui.notify.replied", { name: e.name }), m.message.text);
      break;
    case "chunk":
      if (selected) {
        removeTyping();
        if (!streamEl) {
          streamEl = buildRow(e, { role: "assistant", text: "", ts: Date.now() });
          streamEl.classList.add("streaming");
          streamEl.dataset.raw = "";
          chatBody.appendChild(streamEl);
        }
        streamEl.dataset.raw += m.text;
        streamEl.querySelector(".bubble").innerHTML = md(streamEl.dataset.raw);
        scrollDown();
      }
      break;
    case "chunk_end":
      if (selected) { endStream(); updateTyping(e); }
      break;
    case "ask":
      e.pending.push(m.request);
      if (selected) { removeTyping(); chatBody.appendChild(renderAsk(e, m.request)); scrollDown(); }
      else toast(t("ui.toast.waiting", { name: e.name }));
      if (!selected || document.hidden) notify(e, m.office, t("ui.notify.waiting", { name: e.name }), m.request.question || m.request.title || "");
      break;
    case "ask_done":
      e.pending = e.pending.filter((p) => p.requestId !== m.requestId);
      if (selected) document.querySelector(`[data-ask="${m.requestId}"]`)?.remove();
      break;
    case "result":
      e.cost = m.cost;
      if (m.model) e.model = m.model;
      if (selected) renderHead(e);
      else if (m.durationMs > 0 && !meetingUI.has(e.id)) toast(t("ui.toast.done", { name: e.name }));
      if (current) renderRoster();
      break;
  }
}

function endStream() {
  if (streamEl) { streamEl.remove(); streamEl = null; }
}

function removeTyping() {
  if (typingEl) { typingEl.remove(); typingEl = null; }
}

function updateTyping(e) {
  if (e.status === "working" && !streamEl && !e.pending.length) {
    if (!typingEl) {
      typingEl = document.createElement("div");
      typingEl.className = "row assistant typing";
      typingEl.innerHTML = `<img class="row-avatar" src="${office.portrait(e.id)}" alt="" /><div class="bubble"><span></span><span></span><span></span></div>`;
      chatBody.appendChild(typingEl);
      scrollDown();
    }
  } else removeTyping();
}

// Follow new messages only while the reader is already at the bottom; otherwise offer a "new messages ↓" jump.
const nearBottom = () => chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight < 80;
let jumpPending = 0;
function scrollDown(force = false) {
  if (force || nearBottom()) { chatBody.scrollTop = chatBody.scrollHeight; jumpPending = 0; $("jumpDown").hidden = true; return; }
  jumpPending++;
  $("jumpDown").hidden = false;
}
chatBody.addEventListener("scroll", () => { if (nearBottom() && !$("jumpDown").hidden) { jumpPending = 0; $("jumpDown").hidden = true; } });
$("jumpDown").onclick = () => scrollDown(true);

// ---- resizable chat panel (drag the left edge) ----
const CHAT_MIN = 320;
function applyChatW() {
  let w = 0; try { w = Number(localStorage.getItem("po.chatW")) || 0; } catch {}
  if (w && window.innerWidth > 900) document.body.style.setProperty("--chat-w", Math.min(w, window.innerWidth - 320) + "px");
  else document.body.style.removeProperty("--chat-w");
}
applyChatW();
window.addEventListener("resize", applyChatW);
for (const hid of ["chatResize", "meetResize"]) $(hid).addEventListener("pointerdown", (ev) => {
  if (window.innerWidth <= 900) return;
  ev.preventDefault();
  const handle = ev.currentTarget; handle.setPointerCapture(ev.pointerId); document.body.classList.add("resizing");
  const move = (e) => { const w = Math.max(CHAT_MIN, Math.min(window.innerWidth - 320, window.innerWidth - e.clientX)); document.body.style.setProperty("--chat-w", w + "px"); };
  const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); document.body.classList.remove("resizing"); const w = parseInt(getComputedStyle(document.body).getPropertyValue("--chat-w")); if (w) { try { localStorage.setItem("po.chatW", String(w)); } catch {} } office.fit(); };
  handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", up);
});

function clearAttachments() { chatAttachments.clear(); }

function openChat(id) {
  if (meetingUI.intercept(id)) return;
  if (state.selected !== id) clearAttachments();
  const e = cur()?.employees.get(id);
  if (!e) return;
  state.selected = id;
  e.unread = 0;
  office.setUnread(id, 0);
  office.setSelected(id);
  document.body.classList.add("chat-open");
  renderHead(e);
  renderRoster();
  renderOfficeTabs();
  if (e.loaded) renderChat(e);
  else { chatBody.innerHTML = ""; send({ type: "open", id }); }
  setTimeout(() => { office.fit(); $("chatInput").focus(); }, 260);
}

function closeChat() {
  clearAttachments();
  state.selected = null;
  office.setSelected(null);
  document.body.classList.remove("chat-open");
  endStream();
  removeTyping();
  renderRoster();
  setTimeout(() => office.fit(), 260);
}

const profileUrl = (id) => `employee.html?office=${encodeURIComponent(state.office)}&id=${encodeURIComponent(id)}`;

function renderHead(e) {
  $("chatAvatar").style.backgroundImage = `url(${office.portrait(e.id)})`;
  $("chatAvatar").style.backgroundColor = e.color;
  $("chatAvatar").href = profileUrl(e.id);
  $("btnProfile").href = profileUrl(e.id);
  $("chatName").textContent = e.name;
  $("chatModel").textContent = e.model ? e.model.replace("claude-", "") : "";
  $("chatRole").textContent = e.role;
  const chip = $("chatStatus");
  chip.className = "chip " + e.status;
  const label = e.status === "sick" ? t("ui.chat.sickChip", { min: Math.max(1, Math.ceil(((e.sickUntil || 0) - Date.now()) / 60e3)) }) : STATUS_T[e.status] || e.status;
  chip.textContent = label + (e.cost ? ` · $${e.cost.toFixed(2)}` : "");
  $("btnCure").hidden = e.status !== "sick";
  $("btnStop").classList.toggle("active", e.status === "working" || e.status === "waiting");
}

function renderRoster() {
  const el = $("roster");
  el.innerHTML = "";
  const o = cur();
  if (!o) return;
  for (const e of o.employees.values()) {
    const chip = document.createElement("button");
    chip.className = "roster-chip" + (e.id === state.selected ? " selected" : "");
    chip.innerHTML = `<img src="${office.portrait(e.id)}" alt="" /><i class="dot ${e.status}"></i><span class="rn">${escapeHtml(e.name)}</span><span class="rs">${STATUS_T[e.status] || e.status}</span>${e.unread ? `<span class="badge">${e.unread}</span>` : ""}`;
    chip.onclick = () => openChat(e.id);
    el.appendChild(chip);
  }
}

function renderChat(e) {
  endStream();
  removeTyping();
  chatBody.innerHTML = "";
  if (e.messages.length === 0) {
    const hint = document.createElement("div");
    hint.className = "empty";
    hint.innerHTML = `<img src="${office.portrait(e.id)}" alt="" /><div>${t("ui.chat.empty", { name: escapeHtml(e.name) })}</div>`;
    chatBody.appendChild(hint);
  }
  let lastDay = null;
  for (const msg of e.messages) {
    const day = new Date(msg.ts).toDateString();
    if (day !== lastDay) { chatBody.appendChild(daySep(msg.ts)); lastDay = day; }
    appendMessage(e, msg, true);
  }
  for (const ask of e.pending) chatBody.appendChild(renderAsk(e, ask));
  updateTyping(e);
  scrollDown(true);
}

function daySep(ts) {
  const el = document.createElement("div");
  el.className = "day-sep";
  const d = new Date(ts);
  const today = new Date();
  el.textContent = d.toDateString() === today.toDateString() ? t("ui.chat.today") : d.toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "long" });
  return el;
}

const timeStr = (ts) => new Date(ts).toLocaleTimeString(LOCALE_TAG, { hour: "2-digit", minute: "2-digit" });

// Consecutive tool activities collapse into one expandable card.
function appendMessage(e, msg, bulk = false) {
  if (msg.role === "activity") {
    const last = chatBody.lastElementChild;
    if (last && last.classList.contains("activity-group")) {
      const list = last.querySelector("ul");
      const li = document.createElement("li");
      li.textContent = msg.text;
      list.appendChild(li);
      last.querySelector("summary span").textContent = t("ui.chat.actions", { n: list.children.length });
      return;
    }
    const g = document.createElement("details");
    g.className = "activity-group";
    g.innerHTML = `<summary><i>⚙</i><span>${t("ui.chat.actions", { n: 1 })}</span></summary><ul></ul>`;
    const li = document.createElement("li");
    li.textContent = msg.text;
    g.querySelector("ul").appendChild(li);
    chatBody.appendChild(g);
    return;
  }
  if (!bulk) {
    const prevTs = e.messages.length > 1 ? e.messages[e.messages.length - 2].ts : 0;
    if (new Date(prevTs).toDateString() !== new Date(msg.ts).toDateString()) chatBody.appendChild(daySep(msg.ts));
  }
  chatBody.appendChild(buildRow(e, msg));
}

function buildRow(e, msg) {
  const row = document.createElement("div");
  row.className = "row " + msg.role;
  if (msg.role === "assistant") {
    row.innerHTML = `<img class="row-avatar" src="${office.portrait(e.id)}" alt="" /><div class="row-main"><div class="row-meta">${escapeHtml(e.name)} · ${timeStr(msg.ts)}</div><div class="bubble">${md(msg.text)}</div></div>`;
  } else if (msg.role === "user") {
    const imgs = msg.images?.length ? `<div class="images">${msg.images.map((u) => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener"><img src="${escapeHtml(u)}" alt="" /></a>`).join("")}</div>` : "";
    row.innerHTML = `<div class="row-main"><div class="bubble">${imgs}${escapeHtml(msg.text)}</div><div class="row-meta">${timeStr(msg.ts)}</div></div>`;
  } else if (msg.role === "colleague") {
    row.innerHTML = `<div class="row-main"><div class="row-meta">💬 ${escapeHtml(t("ui.chat.fromColleague", { name: msg.from || "" }))} · ${timeStr(msg.ts)}</div><div class="bubble">${md(msg.text)}</div></div>`;
  } else if (msg.role === "meeting") {
    row.innerHTML = `<div class="row-main"><div class="row-meta">👥 ${timeStr(msg.ts)}</div><div class="bubble">${md(msg.text)}</div></div>`;
  } else if (msg.role === "auto") {
    row.innerHTML = `<details class="auto-card"><summary>${t("ui.chat.autoRefresh")} · ${timeStr(msg.ts)}</summary><div class="auto-text">${escapeHtml(msg.text)}</div></details>`;
  } else {
    row.innerHTML = `<div class="sys">${escapeHtml(msg.text)}</div>`;
  }
  return row;
}

function renderAsk(e, ask) {
  const card = document.createElement("div");
  card.className = "ask";
  card.dataset.ask = ask.requestId;
  const reply = (extra) => send({ type: "reply", id: e.id, requestId: ask.requestId, ...extra });

  if (ask.kind === "question") {
    const questions = ask.input.questions || [];
    const answers = {};
    card.innerHTML = `<div class="ask-title"><img src="${office.portrait(e.id)}" alt="" /> ${t("ui.chat.asks", { name: escapeHtml(e.name) })}</div>`;
    for (const q of questions) {
      const qEl = document.createElement("div");
      qEl.className = "ask-q";
      qEl.textContent = q.question;
      card.appendChild(qEl);
      const opts = document.createElement("div");
      opts.className = "ask-opts";
      for (const o of q.options || []) {
        const btn = document.createElement("button");
        btn.className = "ask-opt";
        btn.innerHTML = `<b>${escapeHtml(o.label)}</b>${o.description ? `<small>${escapeHtml(o.description)}</small>` : ""}`;
        btn.onclick = () => {
          if (q.multiSelect) {
            btn.classList.toggle("on");
            answers[q.question] = [...opts.querySelectorAll("button.on b")].map((b) => b.textContent);
          } else {
            opts.querySelectorAll("button.on").forEach((b) => b.classList.remove("on"));
            btn.classList.add("on");
            answers[q.question] = o.label;
          }
        };
        opts.appendChild(btn);
      }
      const other = document.createElement("input");
      other.className = "ask-other";
      other.placeholder = t("ui.chat.other");
      other.oninput = () => { if (other.value.trim()) answers[q.question] = other.value.trim(); };
      opts.appendChild(other);
      card.appendChild(opts);
    }
    const actions = document.createElement("div");
    actions.className = "ask-actions";
    actions.innerHTML = `<button class="btn ok">${t("ui.chat.answer")}</button><button class="btn no">${t("ui.chat.skip")}</button>`;
    actions.querySelector(".ok").onclick = () => reply({ allow: true, answers });
    actions.querySelector(".no").onclick = () => reply({ allow: false });
    card.appendChild(actions);
  } else {
    card.innerHTML = `
      <div class="ask-title">${t("ui.chat.permission")}</div>
      <div class="ask-desc">${escapeHtml(ask.title)}${ask.description ? "\n" + escapeHtml(ask.description) : ""}</div>
      <div class="ask-actions">
        <button class="btn ok">${t("ui.chat.allow")}</button>
        ${ask.canAlwaysAllow ? `<button class="btn always" title="${escapeHtml(t("ui.chat.alwaysTitle"))}">${t("ui.chat.always")}</button>` : ""}
        <button class="btn no">${t("ui.chat.deny")}</button>
      </div>`;
    card.querySelector(".ok").onclick = () => reply({ allow: true });
    card.querySelector(".always")?.addEventListener("click", () => reply({ allow: true, always: true }));
    card.querySelector(".no").onclick = () => reply({ allow: false });
  }
  return card;
}

// ---- office management modal ----
function renderOfficeList() {
  const host = $("officeList");
  host.innerHTML = "";
  for (const o of state.offices.values()) {
    const row = document.createElement("div");
    row.className = "office-row";
    const n = o.employees.size;
    let rowTheme = o.info.theme || "default";
    row.innerHTML = `<div class="o-head"><input class="o-name" value="${escapeHtml(o.info.name)}" maxlength="60" /><input class="o-cwd" value="${escapeHtml(o.info.cwd === PO.project ? "" : o.info.cwd)}" placeholder="${escapeHtml(t("ui.offices.cwdPh"))}" maxlength="500" title="${escapeHtml(o.info.cwd)}" /><span class="count">${escapeHtml(t("ui.offices.employees", { n }))}</span><span class="office-actions"><button class="btn small o-save">${t("ui.offices.save")}</button> <button class="btn small danger o-del" ${n ? `disabled title="${escapeHtml(t("ui.offices.cannotDelete"))}"` : ""}>${t("ui.offices.delete")}</button></span></div><div class="theme-cards small"></div>`;
    attachFolderPicker(row.querySelector(".o-cwd"));
    buildThemeCards(row.querySelector(".theme-cards"), rowTheme, (v) => { rowTheme = v; });
    row.querySelector(".o-save").onclick = async () => {
      try { await api("PUT", `/api/offices/${encodeURIComponent(o.info.id)}`, { name: row.querySelector(".o-name").value, cwd: row.querySelector(".o-cwd").value.trim(), theme: rowTheme }); toast(t("ui.offices.saved")); }
      catch (err) { toast(t("ui.offices.error", { message: err.message })); }
    };
    const del = row.querySelector(".o-del");
    del.onclick = async () => {
      if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.textContent = t("ui.offices.sure"); setTimeout(() => { del.dataset.armed = ""; del.textContent = t("ui.offices.delete"); }, 3000); return; }
      try { await api("DELETE", `/api/offices/${encodeURIComponent(o.info.id)}`); toast(t("ui.offices.deleted")); }
      catch (err) { toast(t("ui.offices.error", { message: err.message })); }
    };
    host.appendChild(row);
  }
}
// Theme picker: rendered office previews, like choosing a map in a game.
const themePreviews = {};
const themePreview = (th) => (themePreviews[th] ??= renderThemePreview(th, 320));
function buildThemeCards(host, current, onChange) {
  host.innerHTML = "";
  const cards = [];
  for (const th of PO.themes || ["default"]) {
    const c = document.createElement("button");
    c.type = "button"; c.className = "theme-card" + (th === current ? " on" : ""); c.dataset.value = th;
    c.innerHTML = `<img src="${themePreview(th)}" alt="" /><span>${escapeHtml(t(`ui.themes.${th}`))}</span>`;
    c.onclick = () => { cards.forEach((x) => x.classList.toggle("on", x === c)); onChange(th); };
    host.appendChild(c); cards.push(c);
  }
}
let newTheme = "default";
buildThemeCards($("oTheme"), newTheme, (v) => { newTheme = v; });
$("btnOffices").onclick = () => { renderOfficeList(); $("officesModal").hidden = false; $("oName").focus(); };
attachFolderPicker($("oCwd"));

// ---- desktop notifications (🔔) ----
const notifyPref = () => { try { return localStorage.getItem("po.notify") === "1"; } catch { return false; } };
function renderNotifyBtn() {
  const on = notifyPref() && "Notification" in window && Notification.permission === "granted";
  $("btnNotify").classList.toggle("off", !on);
  $("btnNotify").title = `${t("ui.notify.title")} — ${on ? t("ui.notify.on") : t("ui.notify.off")}`;
}
$("btnNotify").onclick = async () => {
  if (!("Notification" in window)) return;
  if (notifyPref()) { try { localStorage.setItem("po.notify", "0"); } catch {} toast(t("ui.notify.off")); renderNotifyBtn(); return; }
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (perm !== "granted") { toast(t("ui.notify.denied")); return; }
  try { localStorage.setItem("po.notify", "1"); } catch {}
  toast(t("ui.notify.on")); renderNotifyBtn();
};
function notify(e, officeId, title, body) {
  if (!notifyPref() || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body: String(body || "").replace(/[*_`#>]/g, "").slice(0, 140), icon: office.portrait(e.id), tag: `${officeId}:${e.id}` });
    n.onclick = () => { window.focus(); if (officeId !== state.office) showOffice(officeId); openChat(e.id); n.close(); };
  } catch {}
}
renderNotifyBtn();

// ---- welcome card (first run only) ----
const welcomed = () => { try { return localStorage.getItem("po.welcomed") === "1"; } catch { return false; } };
if (PO.firstRun && !welcomed()) $("welcomeModal").hidden = false;
$("welcomeGo").onclick = () => { $("welcomeModal").hidden = true; try { localStorage.setItem("po.welcomed", "1"); } catch {} };

// ---- shutdown (⏻) ----
$("btnShutdown").onclick = () => { $("shutdownModal").hidden = false; $("shutdownConfirm").focus(); };
for (const id of ["shutdownClose", "shutdownCancel"]) $(id).onclick = () => { $("shutdownModal").hidden = true; };
$("shutdownModal").addEventListener("click", (ev) => { if (ev.target === $("shutdownModal")) $("shutdownModal").hidden = true; });
$("shutdownConfirm").onclick = async () => {
  $("shutdownConfirm").disabled = true;
  try { await api("POST", "/api/shutdown"); markClosed(); }
  catch (e) { toast(t("ui.offices.error", { message: e.message })); $("shutdownConfirm").disabled = false; }
};
function markClosed() {
  if (state.closed) return;
  state.closed = true;
  $("shutdownModal").hidden = true;
  document.body.classList.add("closed");
  document.querySelector(".offline-banner").innerHTML = t("ui.closedBanner");
  for (const o of state.offices.values()) for (const e of o.employees.values()) e.status = "idle";
  toast(t("ui.shutdown.done"));
}
$("officesClose").onclick = () => { $("officesModal").hidden = true; };
$("officesModal").addEventListener("click", (ev) => { if (ev.target === $("officesModal")) $("officesModal").hidden = true; });
$("officeAdd").onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    const o = await api("POST", "/api/offices", { name: $("oName").value.trim(), cwd: $("oCwd").value.trim(), theme: newTheme });
    $("oName").value = ""; $("oCwd").value = "";
    toast(t("ui.offices.added"));
    showOffice(o.id);
  } catch (err) { toast(t("ui.offices.error", { message: err.message })); }
};

office.onClick(openChat);
$("btnClose").onclick = closeChat;
$("btnStop").onclick = () => { if (state.selected) send({ type: "interrupt", id: state.selected }); };
$("btnCure").onclick = () => { if (state.selected) send({ type: "cure", id: state.selected }); };

let resetArmed = null;
$("btnReset").onclick = () => {
  if (!state.selected) return;
  const btn = $("btnReset");
  if (resetArmed === state.selected) {
    send({ type: "reset", id: state.selected });
    btn.classList.remove("armed");
    resetArmed = null;
    toast(t("ui.toast.reset"));
  } else {
    resetArmed = state.selected;
    btn.classList.add("armed");
    toast(t("ui.toast.resetArm"));
    setTimeout(() => { resetArmed = null; btn.classList.remove("armed"); }, 4000);
  }
};

const input = $("chatInput");
function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(160, input.scrollHeight) + "px";
}
input.addEventListener("input", autoGrow);
// ---- pasted / dropped images, sent along with the next message (chat and meeting panels share this) ----
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_SIDE = 2000;
function makeAttachments(inputEl, hostEl, dropEl, canDrop = () => true) {
  const list = []; // { media_type, data (base64), url (data URL for the preview) }
  const render = () => {
    hostEl.innerHTML = "";
    hostEl.hidden = list.length === 0;
    list.forEach((a, i) => {
      const d = document.createElement("div");
      d.className = "thumb";
      d.innerHTML = `<img src="${a.url}" alt="" /><button type="button" title="${escapeHtml(t("ui.chat.attachRemove"))}">×</button>`;
      d.querySelector("button").onclick = () => { list.splice(i, 1); render(); };
      hostEl.appendChild(d);
    });
  };
  // Reads an image file, shrinking very large ones so the payload stays small; gifs are kept as-is.
  const addFile = (file) => {
    if (!IMAGE_TYPES.includes(file.type) || list.length >= 10) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result;
      const done = (u, type) => { list.push({ media_type: type, data: u.slice(u.indexOf(",") + 1), url: u }); render(); inputEl.focus(); };
      if (file.type === "image/gif") return done(url, file.type);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        if (k === 1) return done(url, file.type);
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        const type = file.type === "image/png" ? "image/png" : "image/jpeg";
        done(c.toDataURL(type, 0.9), type);
      };
      img.onerror = () => done(url, file.type);
      img.src = url;
    };
    reader.readAsDataURL(file);
  };
  inputEl.addEventListener("paste", (ev) => {
    const files = [...(ev.clipboardData?.items || [])].filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter(Boolean);
    if (!files.length) return;
    ev.preventDefault();
    files.forEach(addFile);
  });
  dropEl.addEventListener("dragover", (ev) => { if (canDrop() && [...ev.dataTransfer.types].includes("Files")) { ev.preventDefault(); dropEl.classList.add("dragover"); } });
  dropEl.addEventListener("dragleave", () => dropEl.classList.remove("dragover"));
  dropEl.addEventListener("drop", (ev) => { ev.preventDefault(); dropEl.classList.remove("dragover"); [...ev.dataTransfer.files].forEach(addFile); });
  return {
    get length() { return list.length; },
    clear() { if (list.length) { list.length = 0; render(); } },
    take() { const out = list.map(({ media_type, data }) => ({ media_type, data })); list.length = 0; render(); return out; },
  };
}
const chatAttachments = makeAttachments(input, $("chatAttach"), $("chat"), () => !!state.selected);

$("chatForm").onsubmit = (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if ((!text && !chatAttachments.length) || !state.selected) return;
  const images = chatAttachments.take();
  send({ type: "send", id: state.selected, text, ...(images.length ? { images } : {}) });
  input.value = "";
  autoGrow();
};
input.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    $("chatForm").requestSubmit();
  }
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !$("officesModal").hidden) { $("officesModal").hidden = true; return; }
  if (ev.key === "Escape" && state.selected && document.activeElement?.tagName !== "INPUT") closeChat();
});

function tickClock() {
  $("clock").textContent = new Date().toLocaleTimeString(LOCALE_TAG, { hour: "2-digit", minute: "2-digit" });
  const e = state.selected && cur()?.employees.get(state.selected);
  if (e && e.status === "sick") renderHead(e); // minutes left on the chip
}
tickClock();
setInterval(tickClock, 10000);
// connect() is called at the end of meeting.js, once every script is in place
