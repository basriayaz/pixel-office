// The 🧰 menu in the top bar: the office's editor, the shop, and the two markets live behind one button instead of four icons.
// Each item keeps its own id (btnLayout, btnShop, btnIntegrations, btnSkills); their scripts bind to those as before.
(() => {
  const btn = document.getElementById("btnTools"), pop = document.getElementById("toolsPop");
  if (!btn || !pop) return;
  const setOpen = (on) => { pop.hidden = !on; btn.setAttribute("aria-expanded", String(on)); };
  btn.onclick = (ev) => { ev.stopPropagation(); setOpen(pop.hidden); if (!pop.hidden) pop.querySelector(".menu-item")?.focus(); };
  pop.addEventListener("click", (ev) => { if (ev.target.closest(".menu-item")) setOpen(false); });
  document.addEventListener("click", (ev) => { if (!pop.hidden && !ev.target.closest("#toolsMenu")) setOpen(false); });
  document.addEventListener("keydown", (ev) => {
    if (pop.hidden) return;
    if (ev.key === "Escape") { setOpen(false); btn.focus(); ev.stopPropagation(); return; }
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      const items = [...pop.querySelectorAll(".menu-item")], i = items.indexOf(document.activeElement);
      items[(i + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus(); ev.preventDefault();
    }
  }, true);
})();
