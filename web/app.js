const office = new Office($("office"), $("labels"));
office.start();
document.title = t("ui.title");

const state = { employees: new Map(), selected: null, ws: null, online: false };
const chatBody = $("chatBody");
let streamEl = null;
let typingEl = null;

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  state.ws = ws;
  ws.onopen = () => {
    state.online = true;
    office.setOffline(false);
    document.body.classList.remove("offline");
  };
  ws.onclose = () => {
    if (state.online) toast(t("ui.toast.disconnected"));
    state.online = false;
    office.setOffline(true);
    document.body.classList.add("offline");
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

function send(payload) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
  else toast(t("ui.toast.noConnection"));
}

function handle(m) {
  const e = m.id ? state.employees.get(m.id) : null;
  switch (m.type) {
    case "init": {
      const prev = state.employees;
      state.employees = new Map();
      for (const info of m.employees) {
        const old = prev.get(info.id);
        state.employees.set(info.id, { ...info, messages: old?.messages ?? [], pending: old?.pending ?? [], loaded: old?.loaded ?? false, unread: old?.unread ?? 0 });
      }
      office.setEmployees(m.employees);
      for (const emp of state.employees.values()) office.setUnread(emp.id, emp.unread);
      renderRoster();
      if (state.selected) {
        const sel = state.employees.get(state.selected);
        if (sel) { renderHead(sel); send({ type: "open", id: state.selected }); }
        else closeChat();
      } else {
        const open = new URLSearchParams(location.search).get("open");
        if (open && state.employees.has(open)) { openChat(open); history.replaceState(null, "", "/"); }
      }
      break;
    }
    case "status":
      if (!e) return;
      e.status = m.status;
      office.setStatus(m.id, m.status, m.reason);
      renderRoster();
      if (m.id === state.selected) { renderHead(e); updateTyping(e); }
      break;
    case "history":
      if (!e) return;
      e.messages = m.messages;
      e.pending = m.pending;
      e.loaded = true;
      if (m.id === state.selected) renderChat(e);
      break;
    case "message":
      if (!e) return;
      e.messages.push(m.message);
      if (m.id === state.selected) {
        endStream();
        appendMessage(e, m.message);
        updateTyping(e);
        scrollDown();
      } else if (m.message.role === "assistant") {
        e.unread++;
        office.setUnread(e.id, e.unread);
        renderRoster();
      }
      break;
    case "chunk":
      if (m.id === state.selected) {
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
      if (m.id === state.selected) { endStream(); updateTyping(e); }
      break;
    case "ask":
      if (!e) return;
      e.pending.push(m.request);
      if (m.id === state.selected) { removeTyping(); chatBody.appendChild(renderAsk(e, m.request)); scrollDown(); }
      else toast(t("ui.toast.waiting", { name: e.name }));
      break;
    case "ask_done":
      if (!e) return;
      e.pending = e.pending.filter((p) => p.requestId !== m.requestId);
      document.querySelector(`[data-ask="${m.requestId}"]`)?.remove();
      break;
    case "result":
      if (!e) return;
      e.cost = m.cost;
      if (m.model) e.model = m.model;
      if (m.id === state.selected) renderHead(e);
      else if (m.durationMs > 0) toast(t("ui.toast.done", { name: e.name }));
      renderRoster();
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

function scrollDown() {
  chatBody.scrollTop = chatBody.scrollHeight;
}

function openChat(id) {
  const e = state.employees.get(id);
  if (!e) return;
  state.selected = id;
  e.unread = 0;
  office.setUnread(id, 0);
  office.setSelected(id);
  document.body.classList.add("chat-open");
  renderHead(e);
  renderRoster();
  if (e.loaded) renderChat(e);
  else { chatBody.innerHTML = ""; send({ type: "open", id }); }
  setTimeout(() => { office.fit(); $("chatInput").focus(); }, 260);
}

function closeChat() {
  state.selected = null;
  office.setSelected(null);
  document.body.classList.remove("chat-open");
  renderRoster();
  setTimeout(() => office.fit(), 260);
}

function renderHead(e) {
  $("chatAvatar").style.backgroundImage = `url(${office.portrait(e.id)})`;
  $("chatAvatar").style.backgroundColor = e.color;
  $("chatAvatar").href = `employee.html?id=${encodeURIComponent(e.id)}`;
  $("btnProfile").href = `employee.html?id=${encodeURIComponent(e.id)}`;
  $("chatName").textContent = e.name;
  $("chatModel").textContent = e.model ? e.model.replace("claude-", "") : "";
  $("chatRole").textContent = e.role;
  const chip = $("chatStatus");
  chip.className = "chip " + e.status;
  chip.textContent = (STATUS_T[e.status] || e.status) + (e.cost ? ` · $${e.cost.toFixed(2)}` : "");
  $("btnStop").classList.toggle("active", e.status === "working" || e.status === "waiting");
}

function renderRoster() {
  const el = $("roster");
  el.innerHTML = "";
  for (const e of state.employees.values()) {
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
  scrollDown();
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
    row.innerHTML = `<div class="row-main"><div class="bubble">${escapeHtml(msg.text)}</div><div class="row-meta">${timeStr(msg.ts)}</div></div>`;
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

office.onClick(openChat);
$("btnClose").onclick = closeChat;
$("btnStop").onclick = () => { if (state.selected) send({ type: "interrupt", id: state.selected }); };

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
$("chatForm").onsubmit = (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text || !state.selected) return;
  send({ type: "send", id: state.selected, text });
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
  if (ev.key === "Escape" && state.selected && document.activeElement?.tagName !== "INPUT") closeChat();
});

function tickClock() {
  $("clock").textContent = new Date().toLocaleTimeString(LOCALE_TAG, { hour: "2-digit", minute: "2-digit" });
}
tickClock();
setInterval(tickClock, 10000);

connect();
