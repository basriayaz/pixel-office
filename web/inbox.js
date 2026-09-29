// Inbox (📥): every decision the office is waiting on, in one list, answerable in place. Built from what the client
// already holds (asks, board, statuses); the badge is the number of rows, also shown in the browser tab title.
const inboxUI = (() => {
  const modal = wireModal("inboxModal", "inboxClose");
  const host = $("inboxList");
  const sendingBack = new Set(); // review tasks whose "send back" reason box is open
  const ideaOwner = new Map();   // idea id → owner picked in the row
  let pending = false;
  const API = () => officeApi("/board");
  const call = async (method, url, body) => { try { return await api(method, url, body); } catch (err) { toast(err.message); } };
  const emp = (id) => cur()?.employees.get(id);

  const GROUPS = ["asks", "questions", "review", "blocked", "errors", "ideas"];
  function items() {
    const o = cur();
    if (!o) return [];
    const out = [];
    const b = o.board || {};
    for (const e of o.employees.values()) for (const a of e.pending || []) out.push({ group: a.kind === "question" ? "questions" : "asks", e, a });
    for (const k of b.tasks || []) if (k.status === "review" || k.status === "blocked") out.push({ group: k.status, k });
    for (const e of o.employees.values()) if (e.status === "error") out.push({ group: "errors", e });
    for (const x of b.ideas || []) if (x.status === "new") out.push({ group: "ideas", x });
    return out;
  }

  function badge() {
    const n = items().length;
    $("inboxBadge").hidden = !n;
    $("inboxBadge").textContent = n;
    $("btnInbox").classList.toggle("has", n > 0);
    document.title = n ? `(${n}) ${t("ui.title")}` : t("ui.title");
  }

  // background updates wait while something is being typed or picked in the list
  const busy = () => { const a = document.activeElement; return !!a && host.contains(a) && (a.tagName === "INPUT" || a.tagName === "SELECT"); };
  function refresh() {
    badge();
    if (!modal.open) return;
    if (busy()) { pending = true; return; }
    render();
  }
  host.addEventListener("focusout", () => setTimeout(() => { if (pending && !busy()) { pending = false; render(); } }, 300));

  const GROUP_ICON = { asks: "🔐", questions: "💬", review: "🔍", blocked: "⛔", errors: "⚠", ideas: "💡" };
  const portrait = (id) => `<span class="pav">${emp(id) && office.portrait(id) ? `<img src="${office.portrait(id)}" alt="" />` : `<span class="prow-icon">★</span>`}</span>`;
  function row(avatar, title, meta, cls = "") {
    const el = document.createElement("div");
    el.className = "prow " + cls;
    el.innerHTML = `<div class="prow-head">${avatar}<div class="prow-main"><div class="prow-title">${title}</div>${meta ? `<div class="prow-meta">${meta}</div>` : ""}</div></div><div class="prow-actions"></div>`;
    return el;
  }
  const button = (el, label, cls, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn small " + cls; b.textContent = label; b.onclick = fn; el.querySelector(".prow-actions").appendChild(b); return b; };
  const chat = (id) => { modal.hide(); openChat(id); };
  const reply = (e, a, extra) => send({ type: "reply", id: e.id, requestId: a.requestId, ...extra }); // the chat's own answer message

  function build(it) {
    if (it.group === "asks") {
      const { e, a } = it;
      const el = row(portrait(e.id), `<b>${escapeHtml(e.name)}</b> · ${escapeHtml(a.title || a.toolName)}`, escapeHtml(a.description || a.toolName || ""), "waiting");
      button(el, t("ui.chat.allow"), "ok", () => reply(e, a, { allow: true }));
      button(el, t("ui.chat.deny"), "no", () => reply(e, a, { allow: false }));
      button(el, t("ui.inbox.openChat"), "ghost", () => chat(e.id));
      return el;
    }
    if (it.group === "questions") {
      const { e, a } = it;
      const q = (a.input?.questions || [])[0]?.question || a.title || "";
      const el = row(portrait(e.id), `<b>${escapeHtml(e.name)}</b> · ${escapeHtml(t("ui.inbox.asksYou"))}`, escapeHtml(q), "waiting");
      button(el, t("ui.inbox.answer"), "always", () => chat(e.id));
      return el;
    }
    if (it.group === "errors") {
      const { e } = it;
      const el = row(portrait(e.id), `<b>${escapeHtml(e.name)}</b> · ${escapeHtml(STATUS_T.error || "error")}`, escapeHtml(e.role || ""), "error");
      button(el, t("ui.inbox.openChat"), "ghost", () => chat(e.id));
      return el;
    }
    if (it.group === "ideas") {
      const { x } = it;
      const el = row(portrait(x.by), `<b>#${x.id}</b> ${escapeHtml(x.title)}`, escapeHtml(x.byName || ""));
      const mgr = [...(cur()?.employees.values() || [])].find((e) => e.manager);
      const chosen = ideaOwner.get(x.id) ?? x.owner ?? mgr?.id ?? "";
      const sel = document.createElement("select");
      sel.className = "prow-select";
      sel.innerHTML = `<option value="">${escapeHtml(t("ui.board.ideaOwner"))}…</option>` + [...(cur()?.employees.values() || [])].map((e) => `<option value="${escapeHtml(e.id)}"${e.id === chosen ? " selected" : ""}>${escapeHtml(e.name)}</option>`).join("");
      sel.onchange = () => ideaOwner.set(x.id, sel.value);
      el.querySelector(".prow-actions").appendChild(sel);
      button(el, t("ui.board.ideaMove"), "primary", async () => {
        if (!sel.value) { toast(t("ui.board.ideaPickOwner")); sel.focus(); return; }
        const k = await call("POST", `${API()}/ideas/${x.id}/promote`, { owner: sel.value, start: false });
        if (k) toast(t("ui.board.ideaMovedToast", { id: k.id }));
      });
      button(el, t("ui.inbox.open"), "ghost", () => { modal.hide(); boardUI.show(); document.querySelector('#boardTabs [data-tab="ideas"]')?.click(); });
      return el;
    }
    // review / blocked tasks
    const { k } = it;
    const owner = emp(k.owner);
    const last = k.notes?.[k.notes.length - 1];
    const meta = `${escapeHtml(owner?.name || t("ui.board.noOwner"))}${last ? ` · <i>${escapeHtml(last.text.slice(0, 140))}</i>` : ""}`;
    const el = row(owner ? portrait(k.owner) : `<span class="pav"><span class="prow-icon">·</span></span>`, `<b>#${k.id}</b> ${escapeHtml(k.title)}`, meta, k.status);
    el.querySelector(".prow-main").onclick = () => { modal.hide(); openTask(k.id); };
    el.querySelector(".prow-main").classList.add("link");
    if (k.status === "review") {
      if (sendingBack.has(k.id)) {
        const box = document.createElement("div");
        box.className = "send-back";
        box.innerHTML = `<input maxlength="2000" placeholder="${escapeHtml(t("ui.board.sendBackPh"))}" /><button class="btn small ghost" type="button">${escapeHtml(t("ui.board.cancel"))}</button><button class="btn small primary" type="button">${escapeHtml(t("ui.board.sendBack"))}</button>`;
        const [cancel, go] = box.querySelectorAll("button");
        const input = box.querySelector("input");
        const close = () => { sendingBack.delete(k.id); render(); };
        const back = async () => { if (await call("PUT", `${API()}/tasks/${k.id}`, { status: "todo", ...(input.value.trim() ? { note: input.value.trim() } : {}) })) { toast(t("ui.board.sentBack", { id: k.id })); sendingBack.delete(k.id); } };
        cancel.onclick = close; go.onclick = back;
        input.onkeydown = (ev) => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); back(); } else if (ev.key === "Escape") { ev.stopPropagation(); close(); } };
        el.appendChild(box);
        setTimeout(() => input.focus(), 0);
      } else {
        button(el, t("ui.board.approve"), "ok", () => call("PUT", `${API()}/tasks/${k.id}`, { status: "done" }));
        button(el, t("ui.board.sendBack"), "ghost", () => { sendingBack.add(k.id); render(); });
      }
    }
    button(el, t("ui.inbox.open"), "ghost", () => { modal.hide(); openTask(k.id); });
    return el;
  }

  function render() {
    pending = false;
    host.innerHTML = "";
    const all = items();
    if (!all.length) { host.innerHTML = `<div class="panel-empty"><div class="empty-ico">✨</div><div class="muted">${escapeHtml(t("ui.inbox.empty").replace(/\s*✨\s*$/, ""))}</div></div>`; return; }
    // summary strip: how many decisions in total, one chip per kind that jumps to its group
    const sum = document.createElement("div");
    sum.className = "isum";
    sum.innerHTML = `<b>${escapeHtml(t("ui.inbox.count", { n: all.length }))}</b>`;
    host.appendChild(sum);
    const heads = {};
    for (const g of GROUPS) {
      const n = all.filter((it) => it.group === g).length;
      if (!n) continue;
      const chip = document.createElement("button");
      chip.type = "button"; chip.className = "ichip g-" + g; chip.title = t(`ui.inbox.g.${g}`);
      chip.innerHTML = `${GROUP_ICON[g]} <span>${n}</span>`;
      chip.onclick = () => heads[g]?.scrollIntoView({ block: "start", behavior: "smooth" });
      sum.appendChild(chip);
    }
    for (const g of GROUPS) {
      const list = all.filter((it) => it.group === g);
      if (!list.length) continue;
      const h = document.createElement("div");
      h.className = "pgroup g-" + g;
      h.innerHTML = `<i class="gico">${GROUP_ICON[g]}</i>${escapeHtml(t(`ui.inbox.g.${g}`))} <span>${list.length}</span>`;
      host.appendChild(h); heads[g] = h;
      for (const it of list) { const el = build(it); el.classList.add("g-" + g); host.appendChild(el); }
    }
  }

  $("btnInbox").onclick = () => { modal.show(); render(); };
  panelHooks.push((what, officeId) => { if (!officeId || officeId === state.office) refresh(); });
  return { refresh, items };
})();
