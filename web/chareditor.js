// Game-style character editor: live sprite preview + grouped pickers. Depends on office.js (portraitOf) and /i18n.js (window.PO).
(function () {
  const E = (window.PO && window.PO.strings && window.PO.strings.ui && window.PO.strings.ui.editor) || {};
  const L_ = (k, fallback) => E[k] || fallback;
  const SKINS = ["#fbe3d0", "#f6d3bd", "#f1c9a5", "#e9bd9a", "#d9a877", "#c68642", "#a0673f", "#6e4429"];
  const HAIRS = ["#1c1c1c", "#2b1d14", "#4a2c1a", "#7a5230", "#b8471f", "#d4a05a", "#e6c064", "#f2e2a0", "#8a8a8a", "#e8e8e8", "#c2185b", "#3f51b5"];
  const TOPS = ["#e06c75", "#61afef", "#98c379", "#c678dd", "#e5c07b", "#56b6c2", "#d19a66", "#f78fb3", "#7dd3fc", "#a3e635", "#fb923c", "#f472b6", "#f5f5f5", "#2b2b2b"];
  const BOTTOMS = ["#2f3548", "#23272f", "#3b3f4a", "#5a4634", "#8b3a3a", "#2e5d3a", "#6b7280", "#e8e8e8"];
  const BLAZERS = ["#2c3e5c", "#1f1f27", "#4a2c3a", "#3b3f4a", "#5c3d22"];
  const HATCOLORS = ["#3f51b5", "#d9534f", "#2b2b2b", "#f5f5f5", "#2e5d3a", "#ffd166", "#c678dd"];
  const STYLES = [["short", L_("short","Short")], ["long", L_("long","Long")], ["bun", L_("bun","Bun")], ["ponytail", L_("ponytail","Ponytail")], ["curly", L_("curly","Curly")]];
  const ACC = [["none", L_("no","None")], ["headphones", L_("headphonesOpt","Headphones")], ["headset", L_("headset","Mic headset")]];
  const GLASSES = [["none", L_("no","None")], ["square", L_("square","Square")], ["round", L_("round","Round")], ["sun", L_("sun","Sunglasses")]];
  const HATS = [["none", L_("no","None")], ["cap", L_("cap","Cap")], ["beanie", L_("beanie","Beanie")]];
  const TOPSTYLES = [["tshirt", L_("tshirt","T-shirt")], ["hoodie", L_("hoodie","Hoodie")], ["dress", L_("dress","Dress")]];
  const BOTTOMS_S = [["pants", L_("pants","Pants")], ["shorts", L_("shorts","Shorts")], ["skirt", L_("skirt","Skirt")]];
  const SHOES = [["dark", L_("dark","Classic")], ["sneakers", L_("sneakers","Sneakers")], ["boots", L_("boots","Boots")], ["heels", L_("heels","Heels")]];
  const BODIES = [["slim", L_("slim","Slim")], ["normal", L_("normal","Average")], ["muscular", L_("muscular","Muscular")], ["heavy", L_("heavy","Heavy")]];
  const GROUPS = [["face", (E.tabs && E.tabs.face) || "Face & Body"], ["hair", (E.tabs && E.tabs.hair) || "Hair"], ["clothes", (E.tabs && E.tabs.clothes) || "Clothes"]];
  const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function randomLook() {
    const fem = Math.random() < 0.5;
    const topStyle = pickOne(fem ? ["tshirt", "tshirt", "hoodie", "dress", "blazer"] : ["tshirt", "tshirt", "hoodie", "blazer"]);
    const look = {
      fem, body: pickOne(["normal", "normal", "slim", "muscular", "heavy"]), skin: pickOne(SKINS), hair: pickOne(HAIRS.slice(0, 8)),
      hairStyle: pickOne(fem ? ["long", "bun", "ponytail", "curly"] : ["short", "short", "curly"]),
      beard: !fem && Math.random() < 0.35,
      top: pickOne(TOPS.slice(0, 12)), bottom: pickOne(BOTTOMS.slice(0, 6)),
      topStyle: topStyle === "blazer" ? "blazer" : topStyle,
      bottomStyle: fem ? pickOne(["pants", "pants", "skirt", "shorts"]) : pickOne(["pants", "pants", "shorts"]),
      hat: Math.random() < 0.2 ? pickOne(["cap", "beanie"]) : "none", hatColor: pickOne(HATCOLORS),
      glasses: Math.random() < 0.3 ? pickOne(["square", "round", "sun"]) : "none",
      accessory: Math.random() < 0.2 ? pickOne(["headphones", "headset"]) : "none",
      shoes: pickOne(fem ? ["dark", "sneakers", "boots", "heels"] : ["dark", "sneakers", "boots"]),
    };
    if (topStyle === "blazer") look.blazer = pickOne(BLAZERS);
    return look;
  }

  function CharEditor(container, initial, onChange, opts = {}) {
    const look = Object.assign({ skin: "#f1c9a5", hair: "#3b2a20", hairStyle: "short", top: "#61afef", bottom: "#2f3548", accessory: "none", glasses: "none", hat: "none", hatColor: "#3f51b5", topStyle: "tshirt", bottomStyle: "pants", shoes: "dark", body: "normal", fem: false, beard: false }, initial || {});
    if (look.accessory === "glasses") { look.accessory = "none"; look.glasses = "square"; }
    if (look.blazer) look.topStyle = "blazer";

    const el = document.createElement("div");
    el.className = "ce" + (opts.previewEl ? " ce-noprev" : "");
    el.innerHTML = `
      <div class="ce-preview">
        <div class="ce-stage"><img class="ce-big" alt="" /></div>
        <div class="ce-mini"><img data-dir="left" alt="" /><img data-dir="up" alt="" /><img data-dir="right" alt="" /><img data-anim="type" alt="" /></div>
      </div>
      <div class="ce-side">
        <div class="ce-tabs"></div>
        <div class="ce-opts"></div>
      </div>`;
    container.appendChild(el);
    const preview = el.querySelector(".ce-preview");
    if (opts.previewEl) opts.previewEl.appendChild(preview);
    const opts_ = el.querySelector(".ce-opts");
    const tabsEl = el.querySelector(".ce-tabs");
    let group = "face";

    for (const [g, label] of GROUPS) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "ce-tab"; b.dataset.group = g; b.textContent = label;
      b.onclick = () => { group = g; render(); };
      tabsEl.appendChild(b);
    }
    const rnd = document.createElement("button");
    rnd.type = "button"; rnd.className = "ce-tab ce-random"; rnd.textContent = L_("random", "🎲 Random");
    rnd.onclick = () => { for (const k of Object.keys(look)) delete look[k]; Object.assign(look, randomLook()); render(); };
    tabsEl.appendChild(rnd);

    const row = (g, key, label, build) => {
      const r = document.createElement("div");
      r.className = "ce-row"; r.dataset.key = key; r.dataset.group = g;
      r.innerHTML = `<div class="ce-label">${label}</div><div class="ce-items"></div>`;
      build(r.querySelector(".ce-items"));
      opts_.appendChild(r);
      return r;
    };
    const swatch = (host, key, c, extra) => {
      const s = document.createElement("button");
      s.type = "button"; s.className = "ce-swatch"; s.style.background = c; s.dataset.value = c; s.title = c;
      Object.assign(s.dataset, extra || {});
      s.onclick = () => set(key, c);
      host.appendChild(s);
      return s;
    };
    const swatches = (key, items, custom) => (host) => {
      for (const c of items) swatch(host, key, c);
      if (custom) {
        const inp = document.createElement("input");
        inp.type = "color"; inp.className = "ce-color"; inp.title = L_("customColor", "Custom color");
        inp.oninput = () => set(key, inp.value);
        host.appendChild(inp);
      }
    };
    const chips = (key, items) => (host) => {
      for (const [v, label] of items) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "ce-chip"; b.dataset.value = String(v); b.textContent = label;
        b.onclick = () => set(key, v);
        host.appendChild(b);
      }
    };

    row("face", "fem", L_("gender","Gender"), (host) => {
      for (const [fem, label] of [[false, L_("male","Male")], [true, L_("female","Female")]]) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "ce-chip"; b.dataset.value = String(fem); b.textContent = label;
        b.onclick = () => {
          look.fem = fem;
          if (fem && ["short", "curly"].includes(look.hairStyle)) look.hairStyle = "long";
          if (!fem && ["long", "bun", "ponytail"].includes(look.hairStyle)) look.hairStyle = "short";
          if (fem) look.beard = false;
          if (!fem && look.topStyle === "dress") look.topStyle = "tshirt";
          if (!fem && (look.bottomStyle === "skirt" || look.shoes === "heels")) { look.bottomStyle = "pants"; look.shoes = "dark"; }
          render();
        };
        host.appendChild(b);
      }
    });
    row("face", "body", L_("body","Body"), chips("body", BODIES));
    row("face", "skin", L_("skin","Skin tone"), swatches("skin", SKINS, true));
    row("face", "beard", L_("beard","Beard"), chips("beard", [[false, L_("no","None")], [true, L_("yes","Yes")]]));
    row("face", "glasses", L_("glasses","Glasses"), chips("glasses", GLASSES));
    row("face", "accessory", L_("headphones","Headset"), chips("accessory", ACC));
    row("hair", "hair", L_("hairColor","Hair color"), swatches("hair", HAIRS, true));
    row("hair", "hairStyle", L_("hairStyle","Hair style"), chips("hairStyle", STYLES));
    row("hair", "hat", L_("hat","Hat"), chips("hat", HATS));
    row("hair", "hatColor", L_("hatColor","Hat color"), swatches("hatColor", HATCOLORS, true));
    row("clothes", "topStyle", L_("topStyle","Top"), (host) => {
      for (const [v, label] of TOPSTYLES) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "ce-chip"; b.dataset.value = v; b.textContent = label;
        b.onclick = () => { delete look.blazer; set("topStyle", v); };
        host.appendChild(b);
      }
      const bl = document.createElement("span"); bl.className = "ce-sub"; bl.textContent = L_("blazer", "Blazer");
      host.appendChild(bl);
      for (const c of BLAZERS) {
        const s = swatch(host, "blazer", c, { blazer: "1" });
        s.onclick = () => { look.blazer = c; set("topStyle", "blazer"); };
      }
    });
    row("clothes", "top", L_("topColor","Top color"), swatches("top", TOPS, true));
    row("clothes", "bottomStyle", L_("bottomStyle","Bottom"), chips("bottomStyle", BOTTOMS_S));
    row("clothes", "bottom", L_("bottomColor","Bottom color"), swatches("bottom", BOTTOMS, true));
    row("clothes", "shoes", L_("shoes","Shoes"), chips("shoes", SHOES));

    function set(key, value) {
      if (value === undefined) delete look[key]; else look[key] = value;
      render();
    }

    function render() {
      const e = { look, color: look.top };
      preview.querySelector(".ce-big").src = portraitOf(e, 6, true, "down", "stand");
      for (const img of preview.querySelectorAll(".ce-mini img")) img.src = portraitOf(e, 3, true, img.dataset.dir || "down", img.dataset.anim || "stand");
      for (const t of tabsEl.querySelectorAll(".ce-tab[data-group]")) t.classList.toggle("on", t.dataset.group === group);
      for (const r of opts_.querySelectorAll(".ce-row")) {
        const key = r.dataset.key;
        const cur = look[key] === undefined ? "" : String(look[key]);
        for (const b of r.querySelectorAll("[data-value]")) {
          if (b.dataset.blazer) b.classList.toggle("on", look.topStyle === "blazer" && look.blazer === b.dataset.value);
          else b.classList.toggle("on", b.dataset.value.toLowerCase() === cur.toLowerCase());
        }
        let visible = r.dataset.group === group;
        if (key === "hatColor" && (!look.hat || look.hat === "none")) visible = false;
        if ((key === "bottomStyle" || key === "bottom") && look.topStyle === "dress") visible = false;
        if (key === "beard" && look.fem) visible = false;
        r.style.display = visible ? "" : "none";
      }
      onChange && onChange({ ...look });
    }
    render();
    return { get: () => ({ ...look }), set: (l) => { Object.assign(look, l); render(); }, random: () => rnd.click() };
  }

  window.CharEditor = CharEditor;
  window.randomLook = randomLook;
})();
