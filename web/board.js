// Board: the office task list and the shared notebook. Tasks listed here are a plan: nobody starts one until
// the boss presses Start or the project manager starts it. Loaded after app.js, before meeting.js.
const boardUI = (() => {
  const STATUSES = ["blocked", "review", "doing", "todo", "done"];
  let tab = "tasks", ownerFilter = "", showDone = false, noteFilter = "";
  const open = new Set();      // expanded task / note ids ("t3", "n7")
  const editing = new Set();   // note ids being edited

  const board = () => cur()?.board || { tasks: [], notes: [] };
  const emps = () => [...(cur()?.employees.values() || [])];
  const emp = (id) => cur()?.employees.get(id);
  const who = (id) => (id === "user" ? t("ui.board.you") : emp(id)?.name || id);
  const API = () => `/api/offices/${encodeURIComponent(state.office)}/board`;
  const call = async (method, url, body) => { try { return await api(method, url, body); } catch (err) { toast(err.message); } };
  const when = (ts) => new Date(ts).toLocaleString(LOCALE_TAG, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  // What an open task's owner is up to, when that matters: waiting for the boss's permission, fallen over, gone, or not working at all.
  function alertOf(k) {
    if (k.status === "done") return null;
    const e = emp(k.owner);
    if (!e) return "orphan";
    if (k.status !== "doing") return null;
    if (e.status === "waiting") return "waiting";
    if (e.status === "error") return "error";
    if (e.status === "sick") return "sick";
    if (e.status === "idle" && Date.now() - k.updated > 60e3) return "stalled";
    return null;
  }

  function badge() {
    const n = board().tasks.filter((k) => k.status === "blocked" || k.status === "review" || ["waiting", "error", "orphan", "stalled"].includes(alertOf(k))).length; // what needs the boss
    const el = $("boardBadge");
    el.hidden = !n; el.textContent = n;
  }

  let deepLink = params.get("board"); // /?board=tasks or /?board=notes opens the panel straight away
  function refresh(officeId) {
    if (officeId && officeId !== state.office) return;
    badge();
    if (deepLink && cur()?.board) { tab = deepLink === "notes" ? "notes" : "tasks"; deepLink = null; show(); return; }
    if (!$("boardModal").hidden) render();
  }

  function show() { $("boardModal").hidden = false; render(); }
  function hide() { $("boardModal").hidden = true; }

  function render() {
    document.querySelectorAll("#boardTabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    $("boardTasks").hidden = tab !== "tasks";
    $("boardNotes").hidden = tab !== "notes";
    const mgr = emps().find((e) => e.manager);
    $("boardManager").textContent = mgr ? t("ui.board.managerIs", { name: mgr.name }) : t("ui.board.noManager");
    if (tab === "tasks") renderTasks(); else renderNotes();
  }

  const ownerOptions = (selected, withAll) => (withAll ? `<option value="">${escapeHtml(t("ui.board.filterAll"))}</option>` : "") + emps().map((e) => `<option value="${escapeHtml(e.id)}"${e.id === selected ? " selected" : ""}>${escapeHtml(e.name)} — ${escapeHtml(e.role)}</option>`).join("");

  // ---------- tasks ----------
  function renderTasks() {
    $("taskOwnerFilter").innerHTML = ownerOptions(ownerFilter, true);
    $("taskShowDone").checked = showDone;
    if (!$("newTaskOwner").options.length || [...$("newTaskOwner").options].length !== emps().length) $("newTaskOwner").innerHTML = ownerOptions($("newTaskOwner").value, false);
    const host = $("taskList");
    host.innerHTML = "";
    let tasks = board().tasks.filter((k) => !ownerFilter || k.owner === ownerFilter);
    // with one person selected: a single "do your open tasks" instead of starting each task separately
    const waiting = ownerFilter ? tasks.filter((k) => k.status === "todo").length : 0;
    const all = $("taskStartAll");
    all.hidden = !waiting || !emp(ownerFilter);
    if (waiting && emp(ownerFilter)) {
      all.textContent = t("ui.board.startAll", { name: emp(ownerFilter).name, n: waiting });
      all.onclick = async () => { if (await call("POST", `${API()}/start-all`, { owner: ownerFilter })) toast(t("ui.board.startedAll", { name: emp(ownerFilter).name })); };
    }
    if (!tasks.length) { host.innerHTML = `<div class="muted board-empty">${escapeHtml(t("ui.board.noTasks"))}</div>`; return; }
    for (const st of STATUSES) {
      if (st === "done" && !showDone) continue;
      const group = tasks.filter((k) => k.status === st).sort((a, b) => b.updated - a.updated);
      if (!group.length) continue;
      const h = document.createElement("div");
      h.className = "board-group " + st;
      h.innerHTML = `<i class="tdot ${st}"></i>${escapeHtml(t(`ui.board.status.${st}`))} <span>${group.length}</span>`;
      host.appendChild(h);
      for (const k of group) host.appendChild(taskCard(k));
    }
    const doneCount = tasks.filter((k) => k.status === "done").length;
    if (!showDone && doneCount) { const m = document.createElement("div"); m.className = "muted board-more"; m.textContent = `${t("ui.board.status.done")}: ${doneCount}`; host.appendChild(m); }
  }

  function taskCard(k) {
    const key = "t" + k.id, isOpen = open.has(key);
    const owner = emp(k.owner);
    const card = document.createElement("div");
    card.className = "task-card " + k.status + (isOpen ? " open" : "");
    const last = k.notes[k.notes.length - 1];
    const alert = alertOf(k);
    if (alert) card.classList.add("alert-" + alert);
    card.innerHTML = `
      <div class="task-head">
        ${owner ? `<img src="${office.portrait(k.owner)}" alt="" />` : ""}
        <div class="task-main"><div class="task-title"><b>#${k.id}</b> ${escapeHtml(k.title)}${k.review ? ` <span class="tag" title="${escapeHtml(t("ui.board.reviewHint"))}">${escapeHtml(t("ui.board.reviewTag"))}</span>` : ""}${k.after?.length ? ` <span class="tag" title="${escapeHtml(t("ui.board.afterHint"))}">${escapeHtml(t("ui.board.afterTag", { ids: k.after.map((d) => "#" + d).join(", ") }))}</span>` : ""}${k.autoStart && k.status === "todo" ? ` <span class="tag" title="${escapeHtml(t("ui.board.queuedHint"))}">${escapeHtml(t("ui.board.queuedTag"))}</span>` : ""}${alert ? ` <span class="tag alert">${escapeHtml(t(`ui.board.alert.${alert}`))}</span>` : ""}</div>
          <div class="task-meta">${escapeHtml(owner?.name || t("ui.board.noOwner"))} · ${escapeHtml(t("ui.board.by", { name: who(k.createdBy) }))} · ${when(k.updated)}${last && !isOpen ? ` · <i>${escapeHtml(last.text.slice(0, 90))}</i>` : ""}</div></div>
        <div class="task-actions"></div>
      </div>
      <div class="task-body"${isOpen ? "" : " hidden"}>
        ${k.detail ? `<div class="task-detail">${md(k.detail)}</div>` : ""}
        ${k.notes.map((n) => `<div class="task-note"><span>${escapeHtml(who(n.by))} · ${when(n.ts)}</span>${escapeHtml(n.text)}</div>`).join("")}
        <div class="task-edit">
          <select class="t-status">${STATUSES.slice().reverse().map((s) => `<option value="${s}"${s === k.status ? " selected" : ""}>${escapeHtml(t(`ui.board.status.${s}`))}</option>`).join("")}</select>
          <select class="t-owner">${owner ? "" : `<option value="" selected>${escapeHtml(t("ui.board.noOwner"))}</option>`}${ownerOptions(k.owner, false)}</select>
          <label class="check"><input type="checkbox" class="t-review"${k.review ? " checked" : ""} /> <span>${escapeHtml(t("ui.board.needsReview"))}</span></label>
          <button class="btn small danger t-del" type="button">${escapeHtml(t("ui.board.delete"))}</button>
        </div>
      </div>`;
    card.querySelector(".task-main").onclick = () => { isOpen ? open.delete(key) : open.add(key); renderTasks(); };
    const actions = card.querySelector(".task-actions");
    const btn = (label, cls, fn, tip) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn small " + cls; b.textContent = label; if (tip) b.title = tip; b.onclick = (ev) => { ev.stopPropagation(); fn(); }; actions.appendChild(b); };
    if (alert === "waiting" || alert === "error") btn(t("ui.board.openChat"), "always", () => { hide(); openChat(k.owner); });
    if (alert === "stalled") btn(t("ui.board.restart"), "ghost", async () => { if (await call("POST", `${API()}/tasks/${k.id}/start`)) toast(t("ui.board.started", { id: k.id, name: owner?.name || k.owner })); }, t("ui.board.startTip"));
    if (owner && (k.status === "todo" || k.status === "blocked")) btn(t("ui.board.start"), "primary", async () => { if (await call("POST", `${API()}/tasks/${k.id}/start`)) toast(t("ui.board.started", { id: k.id, name: owner?.name || k.owner })); }, t("ui.board.startTip"));
    if (k.status === "review") btn(t("ui.board.sendBack"), "ghost", () => call("PUT", `${API()}/tasks/${k.id}`, { status: "todo" }));
    if (k.status === "review" || k.status === "doing") btn(t(k.status === "review" ? "ui.board.approve" : "ui.board.markDone"), "ok", () => call("PUT", `${API()}/tasks/${k.id}`, { status: "done" }));
    if (k.status === "done") btn(t("ui.board.reopen"), "ghost", () => call("PUT", `${API()}/tasks/${k.id}`, { status: "todo" }));
    card.querySelector(".t-status").onchange = (ev) => call("PUT", `${API()}/tasks/${k.id}`, { status: ev.target.value });
    card.querySelector(".t-owner").onchange = (ev) => { if (ev.target.value) call("PUT", `${API()}/tasks/${k.id}`, { owner: ev.target.value, ...(k.status === "blocked" && !owner ? { status: "todo" } : {}) }); };
    card.querySelector(".t-review").onchange = (ev) => call("PUT", `${API()}/tasks/${k.id}`, { review: ev.target.checked });
    const del = card.querySelector(".t-del");
    del.onclick = () => { if (del.dataset.armed) call("DELETE", `${API()}/tasks/${k.id}`); else { del.dataset.armed = "1"; del.textContent = t("ui.board.deleteConfirm"); setTimeout(() => { delete del.dataset.armed; del.textContent = t("ui.board.delete"); }, 3000); } };
    return card;
  }

  // ---------- notes ----------
  function renderNotes() {
    const authors = new Map(board().notes.map((n) => [n.by, n.byName]));
    $("noteAuthorFilter").innerHTML = `<option value="">${escapeHtml(t("ui.board.filterAll"))}</option>` + [...authors].map(([id, name]) => `<option value="${escapeHtml(id)}"${id === noteFilter ? " selected" : ""}>${escapeHtml(name)}</option>`).join("");
    const host = $("noteList");
    host.innerHTML = "";
    const notes = board().notes.filter((n) => !noteFilter || n.by === noteFilter).slice().reverse();
    $("notesCount").textContent = t("ui.board.notesCount", { n: notes.length });
    if (!notes.length) { host.innerHTML = `<div class="muted board-empty">${escapeHtml(t("ui.board.noNotes"))}</div>`; return; }
    for (const n of notes) host.appendChild(noteCard(n));
  }

  function noteCard(n) {
    const key = "n" + n.id, isOpen = open.has(key), isEdit = editing.has(n.id);
    const card = document.createElement("div");
    card.className = "note-card" + (isOpen ? " open" : "");
    const avatar = n.by !== "user" && emp(n.by) ? `<img src="${office.portrait(n.by)}" alt="" />` : `<span class="note-you">★</span>`;
    if (isEdit) {
      card.innerHTML = `<input class="n-title" maxlength="140" value="${escapeHtml(n.title)}" /><textarea class="n-text" rows="6">${escapeHtml(n.text)}</textarea><input class="n-tags" value="${escapeHtml(n.tags.join(", "))}" placeholder="${escapeHtml(t("ui.board.noteTags"))}" /><div class="actions right"><button class="btn small ghost n-cancel" type="button">${escapeHtml(t("ui.board.cancel"))}</button><button class="btn small primary n-save" type="button">${escapeHtml(t("ui.board.save"))}</button></div>`;
      card.querySelector(".n-cancel").onclick = () => { editing.delete(n.id); renderNotes(); };
      card.querySelector(".n-save").onclick = async () => { if (await call("PUT", `${API()}/notes/${n.id}`, { title: card.querySelector(".n-title").value, text: card.querySelector(".n-text").value, tags: card.querySelector(".n-tags").value.split(",") })) { editing.delete(n.id); renderNotes(); } };
      return card;
    }
    card.innerHTML = `<div class="note-head">${avatar}<div class="task-main"><div class="task-title"><b>#${n.id}</b> ${escapeHtml(n.title)}</div><div class="task-meta">${escapeHtml(n.byName)} · ${when(n.ts)}${n.tags.map((x) => ` <span class="tag">${escapeHtml(x)}</span>`).join("")}</div></div></div>
      <div class="note-text${isOpen ? "" : " clamp"}">${md(n.text)}</div>
      <div class="note-actions"${isOpen ? "" : " hidden"}><button class="btn small ghost n-edit" type="button">${escapeHtml(t("ui.board.edit"))}</button><button class="btn small danger n-del" type="button">${escapeHtml(t("ui.board.delete"))}</button></div>`;
    card.querySelector(".note-head").onclick = card.querySelector(".note-text").onclick = () => { isOpen ? open.delete(key) : open.add(key); renderNotes(); };
    card.querySelector(".n-edit").onclick = () => { editing.add(n.id); renderNotes(); };
    const del = card.querySelector(".n-del");
    del.onclick = () => { if (del.dataset.armed) call("DELETE", `${API()}/notes/${n.id}`); else { del.dataset.armed = "1"; del.textContent = t("ui.board.deleteConfirm"); setTimeout(() => { delete del.dataset.armed; del.textContent = t("ui.board.delete"); }, 3000); } };
    return card;
  }

  // ---------- wiring ----------
  $("btnBoard").onclick = show;
  $("boardClose").onclick = hide;
  document.querySelectorAll("#boardTabs button").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); }));
  $("taskOwnerFilter").onchange = (ev) => { ownerFilter = ev.target.value; renderTasks(); };
  $("taskShowDone").onchange = (ev) => { showDone = ev.target.checked; renderTasks(); };
  $("noteAuthorFilter").onchange = (ev) => { noteFilter = ev.target.value; renderNotes(); };
  $("newTaskForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const title = $("newTaskTitle").value.trim(), owner = $("newTaskOwner").value;
    if (!title || !owner) return;
    if (await call("POST", `${API()}/tasks`, { title, detail: $("newTaskDetail").value, owner, review: $("newTaskReview").checked })) { $("newTaskTitle").value = ""; $("newTaskDetail").value = ""; }
  };
  $("newNoteForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const title = $("newNoteTitle").value.trim(), text = $("newNoteText").value.trim();
    if (!title || !text) return;
    if (await call("POST", `${API()}/notes`, { title, text, tags: $("newNoteTags").value.split(",") })) { $("newNoteTitle").value = ""; $("newNoteText").value = ""; $("newNoteTags").value = ""; }
  };
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !$("boardModal").hidden) hide(); });

  setInterval(() => refresh(), 30e3); // "stalled" depends on the clock

  return { refresh, show };
})();
