// Coins from finished work (see src/server/progress.ts): the office keeps the running total, this browser's wallet (web/market.js) takes
// the part it has not been given yet, so opening a second browser or reloading never pays twice. The chip in the strip shows the balance
// and opens the market. While the layout editor is open the draft holds the wallet, so new earnings wait and are credited when it closes.
const marketCoins = (() => {
  const M = POMarket;
  const chip = $("stripCoins");
  const pOf = (id = state.office) => state.offices.get(id)?.progress;
  const editing = () => typeof layoutEditor !== "undefined" && layoutEditor.active;

  function render() {
    const p = pOf();
    chip.hidden = !p || typeof p.coins !== "number";
    if (chip.hidden) return;
    const w = editing() ? layoutEditor.api.wallet : M.load(state.office);
    chip.innerHTML = `<i class="mk-coin"></i><b>${escapeHtml(String(w.coins))}</b>`;
    const r = p.coinRates || {};
    chip.title = `${t("ui.coins.chipTip", { task: r.task ?? 20 })}\n${t("ui.coins.earnedTotal", { n: p.coins })}`;
  }

  // credit what the office has earned since this wallet last looked
  function sync(officeId = state.office) {
    if (officeId === state.office && editing()) return 0; // (the draft has the wallet: it is credited when the editor closes)
    const p = pOf(officeId);
    if (!p || typeof p.coins !== "number") return 0;
    const w = M.load(officeId), r = M.credit(w, p.coins);
    if (r.gained > 0 || r.wallet.earned !== w.earned) M.save(officeId, r.wallet);
    if (officeId === state.office) {
      render();
      if (r.gained > 0) {
        toast(t("ui.coins.gained", { n: r.gained }));
        chip.classList.remove("pulse"); void chip.offsetWidth; chip.classList.add("pulse");
      }
    }
    return r.gained;
  }

  chip.onclick = () => { if (window.marketShop) window.marketShop.open(); };
  panelHooks.push((what, officeId) => {
    if (what !== "progress" && what !== "office") return;
    if (officeId && officeId !== state.office) return;
    sync(state.office);
    render();
  });
  if (typeof layoutEditor !== "undefined") layoutEditor.api.subscribe(render); // (spending and selling while editing)
  return { sync, render };
})();
window.marketCoins = marketCoins;
