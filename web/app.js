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
// "Take back" clicked in this tab, by message id: the words return to the input box only once the server confirms the
// message was still waiting (message_removed). If it already went out, they stay out, so nothing is sent twice.
const undoing = new Map();

const cur = () => state.offices.get(state.office);
// The header strip, inbox, activity, costs and status list (inbox.js, activity.js, costs.js, status.js) listen here.
const panelHooks = [];
function panelsChanged(what, officeId, data) { for (const f of panelHooks) { try { f(what, officeId, data); } catch (err) { console.error(err); } } }
const officeApi = (path) => `/api/offices/${encodeURIComponent(state.office)}${path}`;
// A task opens in the board's task drawer when the board offers one, else the board itself.
function openTask(id) {
  if (typeof window.openTaskDrawer === "function") window.openTaskDrawer(id);
  else boardUI.show();
}
// Plain modals of the panels: close with ×, Esc or a click on the backdrop.
function wireModal(id, closeId, onClose) {
  const m = $(id);
  const hide = () => { if (m.hidden) return; m.hidden = true; onClose?.(); };
  $(closeId).onclick = hide;
  m.addEventListener("click", (ev) => { if (ev.target === m) hide(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !m.hidden) hide(); });
  return { show: () => { m.hidden = false; }, hide, get open() { return !m.hidden; } };
}
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

// true when the message went out; false (with a toast) while the server is unreachable, so callers keep what was typed
const isOnline = () => state.ws?.readyState === WebSocket.OPEN;
function send(payload) {
  if (isOnline()) { state.ws.send(JSON.stringify({ office: state.office, ...payload })); return true; }
  toast(t("ui.toast.noConnection"));
  return false;
}

function mergeRoster(officeId, list, info) {
  const prev = state.offices.get(officeId);
  const employees = new Map();
  for (const e of list) {
    const old = prev?.employees.get(e.id);
    // the server keeps asks and unread counts (they survive a reload); the open chat counts as read
    const unread = officeId === state.office && e.id === state.selected ? 0 : typeof e.unread === "number" ? e.unread : old?.unread ?? 0;
    const since = e.statusSince ?? (old && old.status === e.status ? old.since : old ? Date.now() : null);
    employees.set(e.id, { ...e, messages: old?.messages ?? [], pending: Array.isArray(e.pendingAsks) ? e.pendingAsks : old?.pending ?? [], queue: old?.queue ?? [], loaded: old?.loaded ?? false, unread, since });
  }
  state.offices.set(officeId, { info: info ?? prev?.info ?? { id: officeId, name: officeId }, employees, meeting: prev?.meeting ?? null, board: prev?.board ?? null, costs: prev?.costs ?? null, progress: prev?.progress ?? null });
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
  panelsChanged("office", officeId);
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
    // a reconnect: whatever happened while we were away is missing from the chats already loaded, so fetch them again when opened
    if (state.inited) for (const o of state.offices.values()) for (const e of o.employees.values()) e.loaded = false;
    for (const o of m.offices) { mergeRoster(o.id, o.employees, { id: o.id, name: o.name, cwd: o.cwd, theme: o.theme }); state.offices.get(o.id).meeting = o.meeting ?? null; state.offices.get(o.id).board = o.board ?? null; }
    const hired = params.get("hired");
    if (hired && !state.inited) { state.entering = new Set([hired]); history.replaceState(null, "", `/?office=${encodeURIComponent(state.office)}`); }
    if ("quota" in m) state.quota = m.quota;
    for (const o of m.offices) { if (o.costs) state.offices.get(o.id).costs = o.costs; if (o.progress) state.offices.get(o.id).progress = o.progress; }
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
    if (!$("settingsModal").hidden) renderOfficeList();
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
  if (m.type === "board") { const o = state.offices.get(m.office); if (o) { o.board = m.board; boardUI.refresh(m.office); if (m.office === state.office) renderIdeaCtx(); } panelsChanged("board", m.office); return; }
  // spend today and the daily cap; plan limits (global); one line of the office's activity log
  if (m.type === "costs") { const o = state.offices.get(m.office); if (o) o.costs = { today: m.today, todayTokens: m.todayTokens, cap: m.cap }; panelsChanged("costs", m.office); return; }
  if (m.type === "progress") { const o = state.offices.get(m.office); if (o) o.progress = m.progress; panelsChanged("progress", m.office); return; }
  if (m.type === "quota") { state.quota = m.quota; panelsChanged("quota"); return; }
  if (m.type === "activity") { panelsChanged("activity", m.office, m.event); return; }
  // something the server could not do for us (a websocket request that failed): say so instead of failing silently
  if (m.type === "error") { if (lastSend && m.id === lastSend.emp && Date.now() - lastSend.ts < 8000 && !input.value.trim()) { input.value = lastSend.text; autoGrow(); lastSend = null; } toast(t("ui.toast.error", { message: m.error || "?" })); return; }
  const e = employeesOf(m.office)?.get(m.id);
  if (!e) return;
  const current = m.office === state.office;
  const selected = current && m.id === state.selected;
  switch (m.type) {
    case "status":
      if (e.status !== m.status) e.since = Date.now();
      e.status = m.status;
      e.sickUntil = m.sickUntil || 0;
      if (current) { meetingUI.onStatus(); boardUI.refresh(undefined, "status"); }
      if (current) { office.setStatus(m.id, m.status, m.reason); renderRoster(); }
      renderOfficeTabs();
      if (selected) { renderHead(e); updateTyping(e); }
      panelsChanged("status", m.office);
      break;
    case "history":
      e.messages = m.messages;
      e.older = []; // pages read back from the archive; the live list starts over, so they are fetched again
      e.olderMore = !!m.older;
      e.pending = m.pending;
      e.loaded = true;
      if (m.queue) setQueue(e, m.queue);
      if (selected) renderChat(e);
      break;
    // boss messages waiting for the running turn to end; whatever is no longer listed went out (or was taken back)
    case "queue":
      setQueue(e, m.queue || []);
      if (selected) { refreshQueued(e); renderHead(e); }
      if (current) renderRoster();
      break;
    case "message_removed": {
      e.messages = e.messages.filter((x) => x.id !== m.msgId);
      if (selected) chatBody.querySelector(`[data-msg="${CSS.escape(m.msgId)}"]`)?.remove();
      // the words come back to the input box, so taking a message back to fix it costs no retyping
      const text = undoing.get(m.msgId);
      undoing.delete(m.msgId);
      if (selected && text && !input.value.trim()) { input.value = text; autoGrow(); input.focus(); }
      break;
    }
    // the server could not do what a queue button asked: the message already went out, or the employee is in a meeting
    case "queue_ack":
      if (m.op === "unqueue") { undoing.delete(m.msgId); toast(t("ui.chat.alreadySent")); }
      else if (m.op === "deliver_now") toast(t("ui.chat.nowInMeeting", { name: e.name }));
      if (selected) refreshQueued(e);
      break;
    // the server's unread count for one employee (it survives a reload); the open chat is read already
    case "unread":
      e.unread = selected ? 0 : Number(m.unread) || 0;
      if (current) { office.setUnread(e.id, e.unread); renderRoster(); }
      renderOfficeTabs();
      panelsChanged("unread", m.office);
      break;
    case "compacting":
      e.compacting = !!m.on;
      if (selected) renderHead(e);
      if (current) renderRoster();
      break;
    case "message":
      e.messages.push(m.message);
      if (current && m.message.role === "activity" && m.message.kind) office.setTool(m.id, m.message.kind);
      if (selected) {
        endStream();
        appendMessage(e, m.message);
        updateTyping(e);
        scrollDown(m.message.role === "user");
        if (m.message.role === "assistant" && isOnline()) send({ type: "seen", id: e.id }); // read as it arrives: the server keeps the count at zero
      } else if (m.message.role === "colleague") { // the server counts assistant replies itself (the "unread" message)
        e.unread++;
        if (current) { office.setUnread(e.id, e.unread); renderRoster(); }
        renderOfficeTabs();
        panelsChanged("unread", m.office);
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
      panelsChanged("ask", m.office);
      break;
    case "ask_done":
      e.pending = e.pending.filter((p) => p.requestId !== m.requestId);
      if (selected) document.querySelector(`[data-ask="${m.requestId}"]`)?.remove();
      panelsChanged("ask", m.office);
      break;
    case "usage":
      e.context = m.context; e.task = m.task;
      if (selected) renderHead(e);
      break;
    case "result":
      e.cost = m.cost;
      if (m.context !== undefined) e.context = m.context;
      if (m.model) e.model = m.model;
      if (selected) renderHead(e);
      else if (m.durationMs > 0 && !meetingUI.has(e.id)) toast(t("ui.toast.done", { name: e.name }));
      if (current) renderRoster();
      panelsChanged("result", m.office);
      break;
  }
}

// The queue is the truth: a message is shown as queued only while the server still holds it.
function setQueue(e, queue) {
  e.queue = queue;
  e.queued = queue.length;
  const ids = new Set(queue.map((q) => q.id));
  for (const msg of e.messages) if (msg.queued && !ids.has(msg.id)) delete msg.queued;
}
function refreshQueued(e) {
  for (const row of chatBody.querySelectorAll(".row.user[data-msg]")) {
    const msg = e.messages.find((x) => x.id === row.dataset.msg);
    if (!msg) continue;
    if (!!msg.queued !== row.classList.contains("queued") || msg.queued) row.replaceWith(buildRow(e, msg));
  }
}
// Where a queued message will go: the running board task's own session, or the chat.
const queueTask = (e) => e.queue?.find((q) => q.task != null)?.task ?? null;

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
  if (state.selected !== id) { clearAttachments(); if (state.chatIdea && state.chatIdea.emp !== id) clearIdeaCtx(); }
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
  panelsChanged("unread", state.office);
  if (e.loaded) renderChat(e);
  else { chatBody.innerHTML = ""; send({ type: "open", id }); }
  renderIdeaCtx();
  setTimeout(() => { office.fit(); $("chatInput").focus(); }, 260);
}

function closeChat() {
  clearAttachments();
  clearIdeaCtx();
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
  $("chatModel").textContent = modelName(e.model);
  $("chatModel").title = e.model || "";
  $("chatRole").textContent = e.role;
  // a board task runs in a clean session of its own: what the boss writes now goes there, and comes back to the chat when it ends
  const task = e.task ?? queueTask(e);
  $("chatTask").hidden = task == null;
  if (task != null) { $("chatTask").textContent = t("ui.chat.taskSession", { id: task }); $("chatTask").title = t("ui.chat.taskSessionTip", { id: task }); }
  const chip = $("chatStatus");
  // while the conversation is summarized in place, that is what the employee is doing
  chip.className = "chip " + (e.compacting ? "compacting" : e.status);
  const label = e.compacting ? t("ui.chat.compacting") : e.status === "sick" ? t("ui.chat.sickChip", { min: Math.max(1, Math.ceil(((e.sickUntil || 0) - Date.now()) / 60e3)) }) : STATUS_T[e.status] || e.status;
  // context = how much the model re-reads at every step; it is what makes an employee slow and expensive
  chip.textContent = label + (e.context >= 1000 ? ` · ${Math.round(e.context / 1000)}k` : "") + (e.cost ? ` · $${e.cost.toFixed(2)}` : "");
  chip.title = e.compacting ? t("ui.chat.compactingTip") : e.context >= 1000 ? t("ui.chat.contextTip", { k: Math.round(e.context / 1000) }) : "";
  $("btnCure").hidden = e.status !== "sick";
  $("btnStop").classList.toggle("active", e.status === "working" || e.status === "waiting");
}

function renderRoster() {
  const el = $("roster");
  el.innerHTML = "";
  const o = cur();
  if (!o) return;
  // the compact list view (status.js) shows everyone, also those without a desk
  if (typeof statusUI !== "undefined" && statusUI.renderList(el)) return;
  for (const e of o.employees.values()) {
    const chip = document.createElement("button");
    chip.className = "roster-chip" + (e.id === state.selected ? " selected" : "");
    const rs = e.compacting ? t("ui.chat.compacting") : (STATUS_T[e.status] || e.status) + (e.queued ? ` · ${t("ui.chat.queuedCount", { n: e.queued })}` : "");
    const pic = office.portrait(e.id); // no desk, no drawn portrait (the office seats 12): a color swatch instead
    chip.innerHTML = `${pic ? `<img src="${pic}" alt="" />` : `<span class="spic" style="background:${escapeHtml(e.color || "var(--idle)")}"></span>`}<i class="dot ${e.status}"></i><span class="rn">${escapeHtml(e.name)}</span><span class="rs">${escapeHtml(rs)}</span>${e.unread ? `<span class="badge">${e.unread}</span>` : ""}`;
    chip.onclick = () => openChat(e.id);
    el.appendChild(chip);
  }
  if (typeof statusUI !== "undefined") statusUI.decorate(el);
}

function renderChat(e) {
  endStream();
  removeTyping();
  chatBody.innerHTML = "";
  const older = e.older || [];
  if (e.olderMore) chatBody.appendChild(olderButton(e));
  if (e.messages.length === 0 && !older.length && !e.olderMore) {
    const hint = document.createElement("div");
    hint.className = "empty";
    hint.innerHTML = `<img src="${office.portrait(e.id)}" alt="" /><div>${t("ui.chat.empty", { name: escapeHtml(e.name) })}</div>`;
    chatBody.appendChild(hint);
  }
  let lastDay = null;
  for (const msg of older.length ? [...older, ...e.messages] : e.messages) {
    const day = new Date(msg.ts).toDateString();
    if (day !== lastDay) { chatBody.appendChild(daySep(msg.ts)); lastDay = day; }
    appendMessage(e, msg, true);
  }
  for (const ask of e.pending) chatBody.appendChild(renderAsk(e, ask));
  updateTyping(e);
  scrollDown(true);
}

// Lines past the newest 1000 live in the archive; this reads them back a page at a time, keeping the view where it was.
function olderButton(e) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "older-btn";
  b.textContent = t("ui.chat.older");
  b.onclick = async () => {
    b.disabled = true;
    const first = (e.older?.[0] || e.messages[0])?.ts ?? Date.now();
    try {
      const r = await api("GET", officeApi(`/employees/${encodeURIComponent(e.id)}/history?before=${first}&limit=200`));
      if (state.selected !== e.id) return;
      e.older = [...r.messages, ...(e.older || [])];
      e.olderMore = r.more;
      const fromBottom = chatBody.scrollHeight - chatBody.scrollTop;
      renderChat(e);
      chatBody.scrollTop = chatBody.scrollHeight - fromBottom;
    } catch { b.disabled = false; toast(t("ui.chat.olderFailed")); }
  };
  return b;
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

// A boss message written from an idea card carries a visible "Idea #N" tag that leads back to the card.
const ideaTag = (msg) => msg.ideaId != null ? `<button type="button" class="idea-tag" data-idea="${Number(msg.ideaId)}" title="${escapeHtml(t("ui.chat.ideaBack"))}">💡 ${escapeHtml(t("ui.chat.ideaTag", { id: msg.ideaId }))}</button>` : "";
function ideaWaitReason(e, meeting) {
  if (meeting) return t("ui.chat.ideaWaitMeeting");
  if (e.task != null) return t("ui.chat.ideaWaitTask", { id: e.task });
  return t("ui.chat.ideaWaitBusy", { name: e.name });
}
chatBody.addEventListener("click", (ev) => { const b = ev.target.closest(".idea-tag"); if (b) boardUI.focusIdea(Number(b.dataset.idea)); });

// ---- talking an idea over with its proposer: the chat carries "Idea #N" until the boss drops it ----
function ideaOf(id) { return cur()?.board?.ideas?.find((x) => x.id === id); }
function renderIdeaCtx() {
  const box = $("ideaCtx"), c = state.chatIdea;
  const show = !!c && c.office === state.office && c.emp === state.selected;
  box.hidden = !show;
  if (!show) return;
  const x = ideaOf(c.id);
  $("ideaCtxLabel").textContent = t("ui.chat.ideaCtx", { id: c.id, title: x?.title ?? "" });
  input.placeholder = t("ui.chat.ideaPlaceholder", { id: c.id });
}
function clearIdeaCtx() { state.chatIdea = null; renderIdeaCtx(); input.placeholder = t("ui.chat.placeholder"); }
function startChatAbout(idea, empId) {
  state.chatIdea = { id: idea.id, office: state.office, emp: empId };
  openChat(empId);
  renderIdeaCtx();
}
$("ideaCtxBack").onclick = () => { if (state.chatIdea) boardUI.focusIdea(state.chatIdea.id); };
$("ideaCtxDrop").onclick = () => { clearIdeaCtx(); input.focus(); };

function buildRow(e, msg) {
  const row = document.createElement("div");
  row.className = "row " + msg.role;
  if (msg.role === "assistant") {
    row.innerHTML = `<img class="row-avatar" src="${office.portrait(e.id)}" alt="" /><div class="row-main"><div class="row-meta">${escapeHtml(e.name)} · ${timeStr(msg.ts)}</div><div class="bubble">${md(msg.text)}</div></div>`;
  } else if (msg.role === "user") {
    const imgs = msg.images?.length ? `<div class="images">${msg.images.map((u) => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener"><img src="${escapeHtml(u)}" alt="" /></a>`).join("")}</div>` : "";
    if (msg.id) row.dataset.msg = msg.id;
    if (msg.queued) {
      // held until the running turn ends; no model has seen it yet, so it can still be taken back
      row.classList.add("queued");
      const task = e.queue?.find((q) => q.id === msg.id)?.task ?? null;
      // no "interrupt" while the employee sits in a meeting: that turn is the meeting answer, and the queue waits for the end anyway
      const meeting = typeof meetingUI !== "undefined" && meetingUI.has(e.id);
      const where = msg.ideaId != null ? ideaWaitReason(e, meeting) : task != null ? t("ui.chat.queuedTask", { id: task }) : t("ui.chat.queued");
      const now = meeting ? "" : `<button type="button" class="queue-btn now" title="${escapeHtml(t("ui.chat.deliverNowTip"))}">${escapeHtml(t("ui.chat.deliverNow"))}</button>`;
      row.innerHTML = `<div class="row-main"><div class="bubble">${ideaTag(msg)}${imgs}${escapeHtml(msg.text)}</div><div class="row-meta queue-meta"><span class="queue-label" title="${escapeHtml(t("ui.chat.queuedTip"))}">⏳ ${escapeHtml(where)}</span><button type="button" class="queue-btn undo" title="${escapeHtml(t("ui.chat.unqueueTip"))}">${escapeHtml(t("ui.chat.unqueue"))}</button>${now}</div></div>`;
      row.querySelector(".undo").onclick = (ev) => {
        ev.currentTarget.disabled = true;
        if (msg.text) undoing.set(msg.id, msg.text);
        if (!send({ type: "unqueue", id: e.id, msgId: msg.id })) { undoing.delete(msg.id); ev.currentTarget.disabled = false; }
      };
      row.querySelector(".undo").textContent = msg.ideaId != null ? t("ui.chat.ideaGiveUp") : t("ui.chat.unqueue");
      const nowBtn = row.querySelector(".now");
      if (nowBtn) nowBtn.onclick = (ev) => { ev.currentTarget.disabled = true; if (!send({ type: "deliver_now", id: e.id })) ev.currentTarget.disabled = false; };
    } else row.innerHTML = `<div class="row-main"><div class="bubble">${ideaTag(msg)}${imgs}${escapeHtml(msg.text)}</div><div class="row-meta">${timeStr(msg.ts)}</div></div>`;
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

// ---- office management (Settings → Offices, settings.js) ----
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
attachFolderPicker($("oCwd"));

// ---- desktop notifications (Settings → General) ----
const notifyPref = () => { try { return localStorage.getItem("po.notify") === "1"; } catch { return false; } };
const notifyOn = () => notifyPref() && "Notification" in window && Notification.permission === "granted";
// Switches them on (asking the browser for permission first) or off; resolves to whether they are on now.
async function setNotify(on) {
  if (!("Notification" in window)) return false;
  if (!on) { try { localStorage.setItem("po.notify", "0"); } catch {} toast(t("ui.notify.off")); return false; }
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (perm !== "granted") { toast(t("ui.notify.denied")); return false; }
  try { localStorage.setItem("po.notify", "1"); } catch {}
  toast(t("ui.notify.on"));
  return true;
}
function notify(e, officeId, title, body) {
  if (!notifyPref() || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body: String(body || "").replace(/[*_`#>]/g, "").slice(0, 140), icon: office.portrait(e.id), tag: `${officeId}:${e.id}` });
    n.onclick = () => { window.focus(); if (officeId !== state.office) showOffice(officeId); openChat(e.id); n.close(); };
  } catch {}
}

// ---- welcome card (first run only) ----
const welcomed = () => { try { return localStorage.getItem("po.welcomed") === "1"; } catch { return false; } };
if (PO.firstRun && !welcomed()) $("welcomeModal").hidden = false;
$("welcomeGo").onclick = () => { $("welcomeModal").hidden = true; try { localStorage.setItem("po.welcomed", "1"); } catch {} };

// ---- shutdown (Settings → Server) ----
function askShutdown() { $("shutdownModal").hidden = false; $("shutdownConfirm").focus(); }
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

let lastSend = null; // the last idea message, to give the text back if the server refuses it
$("chatForm").onsubmit = (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if ((!text && !chatAttachments.length) || !state.selected) return;
  if (!isOnline()) { toast(t("ui.toast.noConnection")); return; } // keep the text and the images until the server is back
  const c = state.chatIdea && state.chatIdea.office === state.office && state.chatIdea.emp === state.selected ? state.chatIdea : null;
  if (c && !ideaOf(c.id)) { toast(t("ui.chat.ideaGone", { id: c.id })); clearIdeaCtx(); return; } // the card is gone: nothing goes out, the text stays
  const images = chatAttachments.take();
  if (!send({ type: "send", id: state.selected, text, ...(c ? { ideaId: c.id } : {}), ...(images.length ? { images } : {}) })) return;
  lastSend = c ? { text, ts: Date.now(), emp: state.selected } : null;
  input.value = "";
  autoGrow();
};
input.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { // Enter that confirms an IME composition is not a send
    ev.preventDefault();
    $("chatForm").requestSubmit();
  }
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !$("shutdownModal").hidden) { $("shutdownModal").hidden = true; ev.stopImmediatePropagation(); return; }
  // Esc closes the top-most thing only: an open modal (board, meeting cards…) handles it, the chat behind it stays
  if (ev.key === "Escape" && state.selected && document.activeElement?.tagName !== "INPUT" && !document.querySelector(".modal:not([hidden])")) closeChat();
});

function tickClock() {
  $("clock").textContent = new Date().toLocaleTimeString(LOCALE_TAG, { hour: "2-digit", minute: "2-digit" });
  const e = state.selected && cur()?.employees.get(state.selected);
  if (e && e.status === "sick") renderHead(e); // minutes left on the chip
}
tickClock();
setInterval(tickClock, 10000);
// connect() is called at the end of meeting.js, once every script is in place
