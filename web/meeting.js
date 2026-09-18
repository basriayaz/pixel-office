// Meeting panel: call everybody into the meeting room, talk to the whole room, give the floor, end with a summary.
// Loaded after app.js; shares its globals (state, cur, send, office, toast, t, md, …).
const meetingUI = (() => {
  const panel = $("meeting"), body = $("meetBody"), input = $("meetInput");
  const atts = makeAttachments(input, $("meetAttach"), panel, () => !!active());
  let past = null;          // { list } or { meeting } while browsing past meetings
  let mention = null;       // { start, items, index } while the @-picker is open
  const sentTasks = new Set();

  const meetingOf = () => cur()?.meeting || null;
  const active = () => { const m = meetingOf(); return m && !m.endedAt ? m : null; };
  const emp = (id) => cur()?.employees.get(id);
  const portrait = (id) => office.portrait(id);
  const nameOf = (m, id) => m.participants.find((p) => p.id === id)?.name || emp(id)?.name || id;
  const stuck = () => body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  const toBottom = () => { body.scrollTop = body.scrollHeight; };

  // ---------- opening / closing ----------
  function sync() {
    const m = meetingOf();
    const a = active();
    office.setMeeting(a ? a.participants.filter((p) => p.joined).map((p) => p.id) : null, a ? a.hands.map((h) => h.id) : []);
    $("btnMeeting").classList.toggle("primary", !!a);
    if (m) past = null;
    if (!m && !past) { close(); return; }
    if (state.selected) closeChat();
    if (!document.body.classList.contains("meeting-open")) {
      document.body.classList.add("meeting-open");
      setTimeout(() => { office.fit(); if (active()) input.focus(); }, 260);
    }
    render();
  }

  function close() {
    if (!document.body.classList.contains("meeting-open")) return;
    document.body.classList.remove("meeting-open");
    atts.clear();
    hideMentions();
    setTimeout(() => office.fit(), 260);
  }

  // ---------- rendering ----------
  function render() {
    if (past) return renderPast();
    const m = meetingOf();
    if (!m) return;
    renderHead(m);
    renderPeople(m);
    body.innerHTML = "";
    if (!m.transcript.length && !m.endedAt) {
      const hint = document.createElement("div");
      hint.className = "empty";
      hint.innerHTML = `<div>${escapeHtml(t("ui.meeting.empty"))}</div>`;
      body.appendChild(hint);
    }
    for (const entry of m.transcript) appendEntry(m, entry);
    if (m.endedAt) body.appendChild(summaryCard(m));
    renderTyping(m);
    renderHands(m);
    const over = !!m.endedAt;
    $("meetForm").hidden = over;
    $("meetHint").hidden = over;
    $("meetEnd").hidden = over;
    $("meetClose").hidden = !over || !!m.summarizing;
    $("meetHistory").hidden = !over;
    toBottom();
  }

  function renderHead(m) {
    $("meetTopic").textContent = m.topic || t("ui.meeting.title");
    const mins = Math.max(1, Math.round(((m.endedAt || Date.now()) - m.startedAt) / 60e3));
    const n = m.participants.filter((p) => p.joined).length;
    $("meetSub").textContent = m.endedAt ? `${t("ui.meeting.ended")} · ${t("ui.meeting.minutes", { n: mins })}` : `${t("ui.meeting.cost", { n })} · ${t("ui.meeting.minutes", { n: mins })}`;
  }

  function renderPeople(m) {
    const host = $("meetPeople");
    host.innerHTML = "";
    const hands = new Set(m.hands.map((h) => h.id));
    for (const p of m.participants) {
      const e = emp(p.id);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "meet-person" + (!p.joined ? " away" : "") + (e?.status === "working" && p.joined ? " talking" : "") + (hands.has(p.id) ? " hand" : "");
      b.dataset.away = t("ui.meeting.onTheWay");
      b.innerHTML = `<img src="${portrait(p.id)}" alt="" /><span>${hands.has(p.id) ? "✋ " : ""}${escapeHtml(p.name)}</span>`;
      b.onclick = () => insertMention(p.name);
      host.appendChild(b);
    }
  }

  function sysRow(text, cls = "") {
    const row = document.createElement("div");
    row.className = "row system " + cls;
    row.innerHTML = `<div class="sys">${escapeHtml(text)}</div>`;
    return row;
  }

  function appendEntry(m, entry) {
    body.querySelector(".empty")?.remove();
    const typing = body.querySelector(".typing-note");
    const add = (el) => (typing ? body.insertBefore(el, typing) : body.appendChild(el));
    if (entry.kind === "pass") {
      // consecutive passes share one line
      const last = typing ? typing.previousElementSibling : body.lastElementChild;
      if (last?.classList.contains("pass-note")) {
        const names = [...JSON.parse(last.dataset.names), entry.name];
        last.dataset.names = JSON.stringify(names);
        last.querySelector(".sys").textContent = names.length > 3 ? t("ui.meeting.passedN", { n: names.length }) : t("ui.meeting.passed", { names: names.join(", ") });
        return;
      }
      const row = sysRow(t("ui.meeting.passed", { names: entry.name }), "pass-note");
      row.dataset.names = JSON.stringify([entry.name]);
      add(row);
      return;
    }
    if (entry.kind === "hand") return void add(sysRow(t("ui.meeting.handRaised", { name: entry.name, reason: entry.text })));
    if (entry.kind === "floor") return void add(sysRow(t("ui.meeting.floorGiven", { name: entry.text })));
    if (entry.kind === "system") return void add(sysRow(entry.text));
    const row = document.createElement("div");
    if (entry.from === "user") {
      row.className = "row user";
      const to = entry.to?.length ? `<span class="to-tag">${escapeHtml(t("ui.meeting.toOnly", { names: entry.to.map((id) => nameOf(m, id)).join(", ") }))}</span>` : "";
      const imgs = entry.images?.length ? `<div class="images">${entry.images.map((u) => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener"><img src="${escapeHtml(u)}" alt="" /></a>`).join("")}</div>` : "";
      row.innerHTML = `<div class="row-main"><div class="bubble">${imgs}${escapeHtml(entry.text)}</div><div class="row-meta">${to}${timeStr(entry.ts)}</div></div>`;
    } else {
      row.className = "row assistant";
      row.innerHTML = `<img class="row-avatar" src="${portrait(entry.from)}" alt="" /><div class="row-main"><div class="row-meta">${escapeHtml(entry.name || "")} · ${timeStr(entry.ts)}</div><div class="bubble">${md(entry.text)}</div></div>`;
    }
    add(row);
  }

  function renderTyping(m) {
    body.querySelector(".typing-note")?.remove();
    if (m.endedAt) {
      if (m.summarizing) body.appendChild(sysRow(t("ui.meeting.summarizing"), "typing-note"));
      return;
    }
    const names = m.participants.filter((p) => p.joined && emp(p.id)?.status === "working").map((p) => p.name);
    if (names.length) body.appendChild(sysRow(t("ui.meeting.typing", { names: names.join(", ") }), "typing-note"));
    else if (!m.participants.some((p) => p.joined)) body.appendChild(sysRow(t("ui.meeting.nobodyYet"), "typing-note"));
  }

  function renderHands(m) {
    const host = $("meetHands");
    host.innerHTML = "";
    if (m.endedAt) return;
    for (const h of m.hands) {
      const card = document.createElement("div");
      card.className = "hand-card";
      card.innerHTML = `<img src="${portrait(h.id)}" alt="" /><div class="hc-text"><b>${escapeHtml(t("ui.meeting.wantsFloor", { name: nameOf(m, h.id) }))}</b><small title="${escapeHtml(h.reason)}">${escapeHtml(h.reason)}</small></div><button class="btn small primary" type="button">${escapeHtml(t("ui.meeting.give"))}</button><button class="btn small ghost" type="button">${escapeHtml(t("ui.meeting.later"))}</button>`;
      const [give, later] = card.querySelectorAll("button");
      give.onclick = () => send({ type: "meeting_grant", id: h.id });
      later.onclick = () => send({ type: "meeting_dismiss", id: h.id });
      host.appendChild(card);
    }
  }

  function summaryCard(m) {
    const card = document.createElement("div");
    card.className = "meet-summary";
    let html = "";
    if (m.summary) html += `<h4>${escapeHtml(t("ui.meeting.summaryTitle"))}</h4><div>${md(m.summary)}</div>`;
    else if (!m.summarizing) html += `<div class="muted">${escapeHtml(t("ui.meeting.ended"))}</div>`;
    if (m.tasks?.length) html += `<h4>${escapeHtml(t("ui.meeting.tasksTitle"))}</h4>` + m.tasks.map((k, i) => `<div class="meet-task"><b>${escapeHtml(k.name)}</b><span>${escapeHtml(k.task)}</span><button class="btn small" type="button" data-task="${i}">${escapeHtml(t("ui.meeting.sendTask"))}</button></div>`).join("");
    card.innerHTML = html;
    card.querySelectorAll("[data-task]").forEach((b) => {
      const k = m.tasks[Number(b.dataset.task)], key = `${m.id}:${b.dataset.task}`;
      const mark = () => { b.textContent = t("ui.meeting.taskSent"); b.disabled = true; };
      if (sentTasks.has(key) || past) { if (sentTasks.has(key)) mark(); else b.hidden = true; return; }
      b.onclick = () => { send({ type: "send", id: k.to, text: k.task }); sentTasks.add(key); mark(); };
    });
    if (!html) card.hidden = true;
    return card;
  }

  // ---------- past meetings ----------
  async function openHistory() {
    try {
      const list = await api("GET", `/api/offices/${encodeURIComponent(state.office)}/meetings`);
      past = { list };
      if (state.selected) closeChat();
      document.body.classList.add("meeting-open");
      setTimeout(() => office.fit(), 260);
      renderPast();
    } catch (err) { toast(err.message); }
  }

  function renderPast() {
    $("meetHands").innerHTML = "";
    $("meetPeople").innerHTML = "";
    $("meetForm").hidden = true; $("meetHint").hidden = true; $("meetEnd").hidden = true; $("meetHistory").hidden = true;
    $("meetClose").hidden = false;
    body.innerHTML = "";
    if (past.meeting) {
      const m = past.meeting;
      renderHead(m);
      const back = document.createElement("button");
      back.className = "btn small ghost"; back.type = "button"; back.textContent = "← " + t("ui.meeting.back");
      back.onclick = () => { past = { list: past.list }; renderPast(); };
      body.appendChild(back);
      for (const entry of m.transcript) appendEntry(m, entry);
      body.appendChild(summaryCard(m));
      return;
    }
    $("meetTopic").textContent = t("ui.meeting.history");
    $("meetSub").textContent = "";
    if (!past.list.length) { body.appendChild(sysRow(t("ui.meeting.historyEmpty"))); return; }
    const host = document.createElement("div");
    host.className = "history-list";
    for (const it of past.list) {
      const b = document.createElement("button");
      b.type = "button";
      const when = new Date(it.startedAt).toLocaleString(LOCALE_TAG, { dateStyle: "medium", timeStyle: "short" });
      b.innerHTML = `${escapeHtml(it.topic || t("ui.meeting.title"))}<small>${escapeHtml(when)}</small>`;
      b.onclick = async () => {
        try { past = { list: past.list, meeting: await api("GET", `/api/offices/${encodeURIComponent(state.office)}/meetings/${encodeURIComponent(it.id)}`) }; renderPast(); }
        catch (err) { toast(err.message); }
      };
      host.appendChild(b);
    }
    body.appendChild(host);
  }

  // ---------- server messages ----------
  function onMessage(m) {
    const o = state.offices.get(m.office);
    if (!o) return;
    if (m.type === "meeting") {
      o.meeting = m.meeting;
      if (m.office === state.office) sync();
      return;
    }
    const mt = o.meeting;
    if (!mt || mt.id !== m.meetingId) return;
    const en = m.entry;
    if (mt.transcript.some((x) => x.ts === en.ts && x.from === en.from && x.kind === en.kind)) return;
    mt.transcript.push(en);
    if (m.office !== state.office || past) return;
    const follow = stuck() || en.from === "user";
    appendEntry(mt, en);
    if (follow) toBottom();
    if (en.from !== "user" && en.kind === "say" && document.hidden && typeof notify === "function") { const e = emp(en.from); if (e) notify(e, m.office, en.name, en.text); }
  }

  function onStatus() {
    const m = active();
    if (!m || past) return;
    const follow = stuck();
    renderPeople(m);
    renderTyping(m);
    if (follow) toBottom();
  }

  // A click on somebody while the meeting is on mentions them instead of opening their chat.
  function intercept(id) {
    const m = meetingOf();
    if (past) { past = null; close(); return false; }
    if (!m) return false;
    if (m.endedAt) { if (m.summarizing) return true; send({ type: "meeting_close" }); cur().meeting = null; sync(); return false; }
    const p = m.participants.find((x) => x.id === id);
    if (p) insertMention(p.name);
    else toast(t("ui.meeting.running"));
    return true;
  }

  // ---------- @mentions ----------
  function insertMention(name) {
    if (!active()) return;
    const v = input.value;
    const tag = "@" + name + " ";
    if (mention) { input.value = v.slice(0, mention.start) + tag + v.slice(input.selectionStart); hideMentions(); }
    else if (!v.toLocaleLowerCase(LOCALE_TAG).includes(tag.trim().toLocaleLowerCase(LOCALE_TAG))) input.value = (v && !/\s$/.test(v) ? v + " " : v) + tag;
    input.focus();
    grow();
  }

  function hideMentions() { mention = null; $("meetMentions").hidden = true; }

  function updateMentions() {
    const m = active();
    const before = input.value.slice(0, input.selectionStart);
    const hit = before.match(/(^|\s)@([^\s@]*)$/);
    if (!m || !hit) return hideMentions();
    const q = hit[2].toLocaleLowerCase(LOCALE_TAG);
    const items = m.participants.filter((p) => p.name.toLocaleLowerCase(LOCALE_TAG).startsWith(q));
    if (!items.length) return hideMentions();
    mention = { start: before.length - hit[2].length - 1, items, index: Math.min(mention?.index ?? 0, items.length - 1) };
    const host = $("meetMentions");
    host.innerHTML = "";
    items.forEach((p, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = i === mention.index ? "on" : "";
      b.innerHTML = `<img src="${portrait(p.id)}" alt="" /><span>${escapeHtml(p.name)}</span>`;
      b.onmousedown = (ev) => { ev.preventDefault(); insertMention(p.name); };
      host.appendChild(b);
    });
    host.hidden = false;
  }

  // Everybody whose @name appears in the text; longer names first so "@Ali Can" is not read as "@Ali".
  function mentioned(m, text) {
    let rest = text.toLocaleLowerCase(LOCALE_TAG);
    const ids = [];
    for (const p of [...m.participants].sort((a, b) => b.name.length - a.name.length)) {
      const tag = "@" + p.name.toLocaleLowerCase(LOCALE_TAG);
      if (rest.includes(tag)) { ids.push(p.id); rest = rest.split(tag).join(" "); }
    }
    return ids;
  }

  // ---------- input ----------
  function grow() { input.style.height = "auto"; input.style.height = Math.min(160, input.scrollHeight) + "px"; }
  input.addEventListener("input", () => { grow(); updateMentions(); });
  input.addEventListener("click", updateMentions);
  input.addEventListener("blur", () => setTimeout(hideMentions, 120));
  input.addEventListener("keydown", (ev) => {
    if (mention) {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); mention.index = (mention.index + (ev.key === "ArrowDown" ? 1 : -1) + mention.items.length) % mention.items.length; updateMentions(); return; }
      if (ev.key === "Enter" || ev.key === "Tab") { ev.preventDefault(); insertMention(mention.items[mention.index].name); return; }
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); hideMentions(); return; }
    }
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); $("meetForm").requestSubmit(); }
  });
  $("meetForm").onsubmit = (ev) => {
    ev.preventDefault();
    const m = active();
    const text = input.value.trim();
    if (!m || (!text && !atts.length)) return;
    if (!m.participants.some((p) => p.joined)) { toast(t("ui.meeting.nobodyYet")); return; }
    const images = atts.take();
    const to = mentioned(m, text);
    send({ type: "meeting_say", text, ...(to.length ? { to } : {}), ...(images.length ? { images } : {}) });
    input.value = "";
    grow();
    hideMentions();
  };

  // ---------- start card ----------
  function openStart() {
    if (meetingOf()) { sync(); return; }
    const o = cur();
    if (!o || !o.employees.size) return;
    const host = $("meetPick");
    host.innerHTML = "";
    for (const e of o.employees.values()) {
      const busy = e.status === "working" || e.status === "waiting";
      const l = document.createElement("label");
      l.innerHTML = `<input type="checkbox" value="${escapeHtml(e.id)}" checked data-busy="${busy ? 1 : ""}" /><img src="${portrait(e.id)}" alt="" /><span class="mp-name">${escapeHtml(e.name)}<small>${escapeHtml(e.role)}${busy ? " · " + escapeHtml(t("ui.meeting.busy")) : ""}</small></span>`;
      host.appendChild(l);
    }
    host.onchange = refreshStart;
    $("meetTopicInput").value = "";
    refreshStart();
    $("meetStartModal").hidden = false;
    setTimeout(() => $("meetTopicInput").focus(), 50);
  }
  function picked() { return [...$("meetPick").querySelectorAll("input:checked")]; }
  function refreshStart() {
    const sel = picked();
    $("meetBusyField").hidden = !sel.some((c) => c.dataset.busy);
    $("meetCost").textContent = sel.length ? t("ui.meeting.cost", { n: sel.length }) : t("ui.meeting.noOne");
  }
  const closeStart = () => { $("meetStartModal").hidden = true; };
  $("btnMeeting").onclick = openStart;
  $("meetStartClose").onclick = closeStart;
  $("meetStartCancel").onclick = closeStart;
  $("meetStartHistory").onclick = () => { closeStart(); openHistory(); };
  $("meetAll").onclick = () => { $("meetPick").querySelectorAll("input").forEach((c) => (c.checked = true)); refreshStart(); };
  $("meetNone").onclick = () => { $("meetPick").querySelectorAll("input").forEach((c) => (c.checked = false)); refreshStart(); };
  $("meetStartForm").onsubmit = (ev) => {
    ev.preventDefault();
    const ids = picked().map((c) => c.value);
    if (!ids.length) { toast(t("ui.meeting.noOne")); return; }
    const interrupt = document.querySelector('input[name="meetBusy"]:checked')?.value === "interrupt";
    send({ type: "meeting_start", topic: $("meetTopicInput").value.trim(), ids, interrupt });
    closeStart();
  };

  // ---------- end card, close, history ----------
  const closeEnd = () => { $("meetEndModal").hidden = true; };
  $("meetEnd").onclick = () => { $("meetEndModal").hidden = false; };
  $("meetEndClose").onclick = closeEnd;
  $("meetEndCancel").onclick = closeEnd;
  $("meetOptSummary").onchange = () => { $("meetOptMemory").disabled = !$("meetOptSummary").checked; if (!$("meetOptSummary").checked) $("meetOptMemory").checked = false; };
  $("meetEndConfirm").onclick = () => { send({ type: "meeting_end", summary: $("meetOptSummary").checked, memory: $("meetOptMemory").checked }); closeEnd(); };
  $("meetClose").onclick = () => {
    if (past) { past = null; if (!meetingOf()) close(); else render(); return; }
    send({ type: "meeting_close" });
  };
  $("meetHistory").onclick = openHistory;
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!$("meetStartModal").hidden) closeStart();
    else if (!$("meetEndModal").hidden) closeEnd();
  });
  setInterval(() => { const m = active(); if (m && !past) renderHead(m); }, 30e3);

  // true while `id` sits in a running meeting of the office on screen
  const has = (id) => !!active()?.participants.some((p) => p.id === id);

  return { sync, onMessage, onStatus, intercept, openHistory, has };
})();

connect();
