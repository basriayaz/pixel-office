// Game-style character editor: live sprite preview + grouped pickers. Depends on office.js (portraitOf, shoeDefault) and /i18n.js (window.PO).
(function () {
  const E = (window.PO && window.PO.strings && window.PO.strings.ui && window.PO.strings.ui.editor) || {};
  const L_ = (k, fallback) => E[k] || fallback;
  const SKINS = ["#fbe3d0", "#f6d3bd", "#f1c9a5", "#e9bd9a", "#d9a877", "#c68642", "#a0673f", "#6e4429"];
  const HAIRS = ["#1c1c1c", "#2b1d14", "#4a2c1a", "#7a5230", "#b8471f", "#d4a05a", "#e6c064", "#f2e2a0", "#8a8a8a", "#e8e8e8", "#c2185b", "#3f51b5"];
  const EYES = ["#3b2412", "#5b3a1e", "#8a6a2a", "#3f8f4f", "#4a9de0", "#2b5fa8", "#7f8c9a", "#7a5cc7"];
  const TOPS = ["#e06c75", "#61afef", "#98c379", "#c678dd", "#e5c07b", "#56b6c2", "#d19a66", "#f78fb3", "#7dd3fc", "#a3e635", "#fb923c", "#f472b6", "#f5f5f5", "#2b2b2b", "#2c3e5c", "#3b3f4a", "#5c3d22"];
  const TIES = ["#8b1e2d", "#2c3e5c", "#1f1f27", "#e0b030", "#2e5d3a", "#c678dd", "#7dd3fc", "#f5f5f5"];
  const BOTTOMS = ["#2f3548", "#23272f", "#3b3f4a", "#5a4634", "#8b3a3a", "#2e5d3a", "#6b7280", "#c9a074", "#e8e8e8"];
  const BLAZERS = ["#2c3e5c", "#1f1f27", "#4a2c3a", "#3b3f4a", "#5c3d22"];
  const HATCOLORS = ["#3f51b5", "#d9534f", "#2b2b2b", "#f5f5f5", "#2e5d3a", "#ffd166", "#c678dd", "#8b5a2b"];
  const SHOECOLORS = ["#26222a", "#5a3a22", "#f2f2f2", "#c0392b", "#2c3e5c", "#c9a074", "#f472b6", "#6b7280", "#e0b030"];
  const STYLES = [
    ["short", L_("short", "Short")], ["buzz", L_("buzz", "Buzz cut")], ["sidepart", L_("sidepart", "Side part")], ["spiky", L_("spiky", "Spiky")],
    ["curly", L_("curly", "Curly")], ["mohawk", L_("mohawk", "Mohawk")], ["afro", L_("afro", "Afro")], ["bald", L_("bald", "Bald")],
    ["balding", L_("balding", "Balding")], ["long", L_("long", "Long")], ["bob", L_("bob", "Bob")], ["bun", L_("bun", "Bun")],
    ["ponytail", L_("ponytail", "Ponytail")], ["braid", L_("braid", "Braid")],
  ];
  const MASC_HAIR = ["short", "buzz", "spiky", "mohawk", "bald", "balding"];
  const FEM_HAIR = ["long", "bun", "ponytail", "bob", "braid"];
  const BEARDS = [["none", L_("no", "None")], ["stubble", L_("stubble", "Stubble")], ["mustache", L_("mustache", "Mustache")], ["goatee", L_("goatee", "Goatee")], ["chin", L_("chinBeard", "Circle beard")], ["full", L_("fullBeard", "Full")], ["long", L_("longBeard", "Long")]];
  const ACC = [["none", L_("no", "None")], ["headphones", L_("headphonesOpt", "Headphones")], ["headset", L_("headset", "Mic headset")]];
  const GLASSES = [["none", L_("no", "None")], ["square", L_("square", "Square")], ["round", L_("round", "Round")], ["sun", L_("sun", "Sunglasses")]];
  const HATS = [["none", L_("no", "None")], ["cap", L_("cap", "Cap")], ["beanie", L_("beanie", "Beanie")], ["cowboy", L_("cowboy", "Cowboy")], ["fedora", L_("fedora", "Fedora")], ["bucket", L_("bucket", "Bucket hat")], ["beret", L_("beret", "Beret")], ["bandana", L_("bandana", "Bandana")], ["hood", L_("hood", "Hood")]];
  const TOPSTYLES = [["tshirt", L_("tshirt", "T-shirt")], ["tank", L_("tank", "Tank top")], ["crop", L_("crop", "Crop top")], ["polo", L_("polo", "Polo")], ["shirt", L_("shirt", "Shirt")], ["sweater", L_("sweater", "Sweater")], ["hoodie", L_("hoodie", "Hoodie")], ["suit", L_("suit", "Suit")], ["dress", L_("dress", "Dress")]];
  const BOTTOMS_S = [["pants", L_("pants", "Pants")], ["cargo", L_("cargo", "Cargo pants")], ["joggers", L_("joggers", "Joggers")], ["shorts", L_("shorts", "Shorts")], ["bermuda", L_("bermuda", "Long shorts")], ["skirt", L_("skirt", "Skirt")], ["longskirt", L_("longskirt", "Long skirt")]];
  const SHOES = [["dark", L_("dark", "Classic")], ["sneakers", L_("sneakers", "Sneakers")], ["hightops", L_("hightops", "High-tops")], ["boots", L_("boots", "Boots")], ["loafers", L_("loafers", "Loafers")], ["sandals", L_("sandals", "Sandals")], ["heels", L_("heels", "Heels")]];
  const BODIES = [["slim", L_("slim", "Slim")], ["normal", L_("normal", "Average")], ["muscular", L_("muscular", "Muscular")], ["heavy", L_("heavy", "Heavy")]];
  const GROUPS = [["face", (E.tabs && E.tabs.face) || "Face & Body"], ["hair", (E.tabs && E.tabs.hair) || "Hair"], ["clothes", (E.tabs && E.tabs.clothes) || "Clothes"]];
  const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const defaultEyes = (fem) => (fem ? "#4a9de0" : "#3b2412");

  function randomLook() {
    const fem = Math.random() < 0.5;
    const topStyle = pickOne(fem ? ["tshirt", "tshirt", "hoodie", "dress", "blazer", "tank", "crop", "shirt", "sweater", "polo", "suit"] : ["tshirt", "tshirt", "hoodie", "blazer", "tank", "shirt", "sweater", "polo", "suit"]);
    const look = {
      fem, body: pickOne(["normal", "normal", "slim", "muscular", "heavy"]), skin: pickOne(SKINS), hair: pickOne(HAIRS.slice(0, 8)),
      hairStyle: pickOne(fem ? ["long", "long", "bun", "ponytail", "curly", "bob", "braid", "afro", "sidepart"] : ["short", "short", "buzz", "sidepart", "curly", "spiky", "bald", "balding", "mohawk", "afro"]),
      eyes: pickOne(EYES),
      beard: !fem && Math.random() < 0.45 ? pickOne(["stubble", "full", "goatee", "chin", "mustache", "long"]) : "none",
      top: pickOne(TOPS.slice(0, 12)), bottom: pickOne(BOTTOMS.slice(0, 6)),
      topStyle: topStyle === "blazer" ? "blazer" : topStyle,
      bottomStyle: fem ? pickOne(["pants", "pants", "skirt", "shorts", "cargo", "joggers", "longskirt", "bermuda"]) : pickOne(["pants", "pants", "shorts", "cargo", "joggers", "bermuda"]),
      hat: Math.random() < 0.25 ? pickOne(["cap", "beanie", "cowboy", "fedora", "bucket", "beret", "bandana", "hood"]) : "none", hatColor: pickOne(HATCOLORS),
      glasses: Math.random() < 0.3 ? pickOne(["square", "round", "sun"]) : "none",
      accessory: Math.random() < 0.2 ? pickOne(["headphones", "headset"]) : "none",
      shoes: pickOne(fem ? ["dark", "sneakers", "hightops", "boots", "loafers", "sandals", "heels"] : ["dark", "sneakers", "hightops", "boots", "loafers", "sandals"]),
    };
    if (topStyle === "blazer") look.blazer = pickOne(BLAZERS);
    if (topStyle === "suit") { look.top = pickOne(["#2c3e5c", "#3b3f4a", "#2b2b2b", "#5c3d22", "#4a2c3a"]); look.tie = pickOne(TIES); }
    if (Math.random() < 0.5) look.shoeColor = pickOne(SHOECOLORS);
    return look;
  }

  function CharEditor(container, initial, onChange, opts = {}) {
    const look = Object.assign({ skin: "#f1c9a5", hair: "#3b2a20", hairStyle: "short", top: "#61afef", bottom: "#2f3548", accessory: "none", glasses: "none", hat: "none", hatColor: "#3f51b5", topStyle: "tshirt", bottomStyle: "pants", shoes: "dark", body: "normal", fem: false, beard: "none" }, initial || {});
    if (look.accessory === "glasses") { look.accessory = "none"; look.glasses = "square"; }
    if (look.blazer) look.topStyle = "blazer";
    if (typeof look.beard !== "string") look.beard = look.beard ? "full" : "none"; // older configs stored a boolean

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

    row("face", "fem", L_("gender", "Gender"), (host) => {
      for (const [fem, label] of [[false, L_("male", "Male")], [true, L_("female", "Female")]]) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "ce-chip"; b.dataset.value = String(fem); b.textContent = label;
        b.onclick = () => {
          look.fem = fem;
          if (fem && MASC_HAIR.includes(look.hairStyle)) look.hairStyle = "long";
          if (!fem && FEM_HAIR.includes(look.hairStyle)) look.hairStyle = "short";
          if (fem) look.beard = "none";
          if (!fem && look.topStyle === "dress") look.topStyle = "tshirt";
          if (!fem && (look.bottomStyle === "skirt" || look.bottomStyle === "longskirt" || look.shoes === "heels")) { look.bottomStyle = "pants"; look.shoes = "dark"; }
          render();
        };
        host.appendChild(b);
      }
    });
    row("face", "body", L_("body", "Body"), chips("body", BODIES));
    row("face", "skin", L_("skin", "Skin tone"), swatches("skin", SKINS, true));
    row("face", "eyes", L_("eyes", "Eye color"), swatches("eyes", EYES, true));
    row("face", "beard", L_("beard", "Beard"), chips("beard", BEARDS));
    row("face", "beardColor", L_("beardColor", "Beard color"), swatches("beardColor", HAIRS, true));
    row("face", "glasses", L_("glasses", "Glasses"), chips("glasses", GLASSES));
    row("face", "accessory", L_("headphones", "Headset"), chips("accessory", ACC));
    row("hair", "hair", L_("hairColor", "Hair color"), swatches("hair", HAIRS, true));
    row("hair", "hairStyle", L_("hairStyle", "Hair style"), chips("hairStyle", STYLES));
    row("hair", "hat", L_("hat", "Hat"), chips("hat", HATS));
    row("hair", "hatColor", L_("hatColor", "Hat color"), swatches("hatColor", HATCOLORS, true));
    row("clothes", "topStyle", L_("topStyle", "Top"), (host) => {
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
    row("clothes", "top", L_("topColor", "Top color"), swatches("top", TOPS, true));
    row("clothes", "tie", L_("tieColor", "Tie color"), swatches("tie", TIES, true));
    row("clothes", "bottomStyle", L_("bottomStyle", "Bottom"), chips("bottomStyle", BOTTOMS_S));
    row("clothes", "bottom", L_("bottomColor", "Bottom color"), swatches("bottom", BOTTOMS, true));
    row("clothes", "shoes", L_("shoes", "Shoes"), chips("shoes", SHOES));
    row("clothes", "shoeColor", L_("shoeColor", "Shoe color"), swatches("shoeColor", SHOECOLORS, true));

    function set(key, value) {
      if (value === undefined) delete look[key]; else look[key] = value;
      render();
    }

    // Value shown as selected for a row; colors with a per-style default fall back to it when unset.
    function current(key) {
      if (look[key] !== undefined) return String(look[key]);
      if (key === "eyes") return defaultEyes(!!look.fem);
      if (key === "shoeColor") return window.shoeDefault ? window.shoeDefault(look.shoes) : "";
      if (key === "tie") return "#8b1e2d";
      if (key === "beardColor") return look.hair || "";
      return "";
    }

    function render() {
      const e = { look, color: look.top };
      preview.querySelector(".ce-big").src = portraitOf(e, 6, true, "down", "stand");
      for (const img of preview.querySelectorAll(".ce-mini img")) img.src = portraitOf(e, 3, true, img.dataset.dir || "down", img.dataset.anim || "stand");
      for (const t of tabsEl.querySelectorAll(".ce-tab[data-group]")) t.classList.toggle("on", t.dataset.group === group);
      for (const r of opts_.querySelectorAll(".ce-row")) {
        const key = r.dataset.key;
        const cur = current(key);
        for (const b of r.querySelectorAll("[data-value]")) {
          if (b.dataset.blazer) b.classList.toggle("on", look.topStyle === "blazer" && look.blazer === b.dataset.value);
          else b.classList.toggle("on", b.dataset.value.toLowerCase() === cur.toLowerCase());
        }
        let visible = r.dataset.group === group;
        if (key === "hatColor" && (!look.hat || look.hat === "none")) visible = false;
        if ((key === "bottomStyle" || key === "bottom") && look.topStyle === "dress") visible = false;
        if (key === "bottom" && look.topStyle === "suit") visible = false; // suit trousers / skirt match the jacket
        if (key === "tie" && look.topStyle !== "suit") visible = false;
        if (key === "beard" && look.fem) visible = false;
        if (key === "beardColor" && (look.fem || !look.beard || look.beard === "none")) visible = false;
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
