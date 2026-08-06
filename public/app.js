// Wizard client. All state lives on the server; this file renders the latest
// snapshot and posts user intent. Polling a single JSON endpoint keeps the page
// refresh-safe and the code inspectable.

const $ = (sel) => document.querySelector(sel);
const app = $("#app");

let state = null;
let localManifest = null; // manifest rows being edited, not yet submitted
let exportResult = null;
let exporting = false;
// Display unit for the height column. Everything server-side and in the
// exported kit is metres; this only converts at the input boundary.
let heightUnit = localStorage.getItem("heightUnit") === "ft" ? "ft" : "m";
const M_PER_FT = 0.3048;
const toMetres = (v) => {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return v;
  return heightUnit === "ft" ? String(Math.round(n * M_PER_FT * 100) / 100) : String(n);
};

const post = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) alert(data.error ?? `Request failed (${res.status})`);
  await refresh();
};

async function refresh() {
  const prev = JSON.stringify(state);
  state = await (await fetch("/api/project")).json();
  if (JSON.stringify(state) !== prev) render();
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CONCEPT_CREDITS = 3;
// Polygon-budget slider: log scale over the API's 100-300,000 range, because a
// linear slider crams every useful jam value into its first few pixels.
const PC_MIN = 100, PC_MAX = 300000;
const polyFromSlider = (t) => {
  const raw = PC_MIN * Math.pow(PC_MAX / PC_MIN, t / 100);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
  return Math.max(PC_MIN, Math.round(raw / mag) * mag); // 2 significant figures
};
const sliderFromPoly = (p) => Math.round((Math.log(p / PC_MIN) / Math.log(PC_MAX / PC_MIN)) * 100);
const fmtPoly = (p) => p.toLocaleString("en-US");
const LIFT_FAST = 15; // meshy-5, 2K textures
const LIFT_HIGH = 30; // meshy-6, 4K textures
// Once generation starts, the server's snapshot carries the chosen quality.
const liftCost = () => (state?.quality === "high" ? LIFT_HIGH : LIFT_FAST);

function render() {
  $("#balance").textContent = state.balance == null ? "balance —" : `balance ${state.balance}`;
  $("#spent").textContent = `spent ${state.creditsSpent}`;
  document.querySelector(".sample-banner")?.remove();
  if (state.sampleMode) {
    const b = document.createElement("div");
    b.className = "sample-banner";
    b.innerHTML =
      "<strong>Sample mode.</strong> No API key is configured, so you're browsing a " +
      "real recorded session (a harbor-town brief, 42 credits, ~4 minutes) read-only. " +
      "Set <code>MESHY_API_KEY</code> in <code>.env</code> to generate your own.";
    document.querySelector("main").before(b);
  }

  const stepOrder = ["brief", "sheet", "manifest", "generate"];
  const current = state.phase === "generating" || state.phase === "done" ? "generate" : state.phase;
  document.querySelectorAll("#steps span").forEach((el) => {
    el.classList.toggle("active", el.dataset.step === current);
    el.classList.toggle("done", stepOrder.indexOf(el.dataset.step) < stepOrder.indexOf(current));
  });

  // A zip exported earlier no longer describes a project that has resumed
  // generating; drop the stale download link the moment we leave "done".
  if (state.phase !== "done" && exportResult) exportResult = null;

  if (state.phase === "brief") renderBrief();
  else if (state.phase === "sheet") renderSheet();
  else if (state.phase === "manifest") renderManifest();
  else renderGeneration();
}

function renderBrief() {
  const returning = state.sheet.rolls > 0;
  app.innerHTML = `
    <div class="card">
      <div class="field">
        <label for="brief">What's your game? (theme, setting, mood)</label>
        <textarea id="brief" placeholder="A cozy roguelike set in a mushroom forest; melancholy but warm.">${esc(state.brief)}</textarea>
      </div>
      <div class="field">
        <label for="style">Art style keywords</label>
        <input id="style" type="text" placeholder="low-poly, hand-painted, muted earthy palette" value="${esc(state.styleWords)}" />
      </div>
      <div class="actions">
        <button id="go">${returning ? "Create a new style sheet" : "Create style sheet"}</button>
        ${returning ? `<button id="keep-sheet" class="ghost">Keep the current sheet →</button>` : ""}
        <span class="hint">~3 credits · ~20 seconds · reroll as often as you like before any 3D spend</span>
      </div>
      <label class="hint" style="display:flex;align-items:center;gap:0.4rem;margin-top:0.8rem">
        <input type="checkbox" id="labels" ${state.sheetLabels === false ? "" : "checked"} />
        label the panels with asset-name ideas (AI-painted text; may contain typos)
      </label>
      <div class="field" style="margin:1.2rem 0 0;border-top:1px solid #2b3040;padding-top:1rem">
        <label for="sheet-file">…or bring your own style sheet</label>
        <p class="hint" style="margin:0 0 0.5rem">Any PNG or JPEG under 8 MB — your artist's sheet, a
        mood board, or a sheet from a previous project's export. It anchors generation exactly like
        a generated one; the tool doesn't care who drew it.</p>
        <input type="file" id="sheet-file" accept="image/png,image/jpeg" />
      </div>
    </div>`;
  $("#go").onclick = () =>
    post("/api/brief", { brief: $("#brief").value, styleWords: $("#style").value, labels: $("#labels").checked });
  $("#sheet-file").onchange = () => {
    const file = $("#sheet-file").files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return alert("That image is over 8 MB. Resize it and try again.");
    const reader = new FileReader();
    reader.onload = () =>
      post("/api/sheet/upload", {
        dataUrl: reader.result,
        brief: $("#brief").value,
        styleWords: $("#style").value,
      });
    reader.readAsDataURL(file);
  };
  $("#keep-sheet") && ($("#keep-sheet").onclick = () => post("/api/back/sheet"));
}

function renderSheet() {
  const s = state.sheet;
  let body;
  if (s.status === "SUCCEEDED" && s.file) {
    body = `
      <div class="sheet-wrap">
        <img src="/kit-files/${esc(s.file)}?r=${s.rolls}" alt="generated style sheet" class="zoomable" title="click to view full size" />
        <div class="actions" style="justify-content:center">
          <button id="approve">Approve this style</button>
          ${s.uploaded ? "" : `<button id="reroll" class="ghost">Reroll (~3 credits)</button>`}
          <button id="edit-brief" class="ghost">← ${s.uploaded ? "Start over" : "Edit brief"}</button>
        </div>
        <p class="hint"><strong>You're approving the style, not these exact assets.</strong>
        The panels are references and suggestions — a build queue comes next, and you
        choose what's in it. Everything you generate will be anchored to this image.
        ${s.uploaded ? "Your uploaded sheet." : `Roll ${s.rolls}.`}</p>
      </div>`;
  } else if (s.status === "FAILED") {
    body = `
      <div class="error">Style sheet failed: ${esc(s.error)}</div>
      <div class="actions"><button id="reroll">Try again</button></div>`;
  } else {
    body = `<div class="status-line sheet-wrap"><span class="spinner"></span>
      Generating your style sheet (${esc(s.status ?? "starting")})…</div>`;
  }
  app.innerHTML = `<div class="card">${body}</div>`;
  $("#approve") && ($("#approve").onclick = () => post("/api/sheet/approve"));
  $("#reroll") && ($("#reroll").onclick = () => post("/api/sheet/reroll"));
  $("#edit-brief") && ($("#edit-brief").onclick = () => post("/api/back/brief"));
}

function renderManifest() {
  localManifest ??= state.assets.map((a) => ({
    name: a.name,
    desc: a.desc,
    pose: a.pose ?? "",
    // server state is metres; seed the editor in the display unit
    height:
      a.height == null
        ? ""
        : heightUnit === "ft"
          ? String(Math.round((a.height / M_PER_FT) * 100) / 100)
          : String(a.height),
  }));
  const rows = localManifest
    .map(
      (r, i) => `
      <tr>
        <td><input type="text" data-i="${i}" data-k="name" value="${esc(r.name)}" placeholder="Asset name" /></td>
        <td><input type="text" data-i="${i}" data-k="desc" value="${esc(r.desc)}" placeholder="object + material/condition + one signature detail" title="this text is drawn, so describe what's visible: 'a mossy headstone with a sleeping cat carved in relief'. Skip lore, size words, and style words (the sheet handles style) — and one object, not a scene" /></td>
        <td><input type="text" data-i="${i}" data-k="height" value="${esc(r.height)}" placeholder="height ${heightUnit}" title="intended in-game height (optional; stored in metres in the kit for import scaling — generated models all arrive ~2 m tall)" style="width:5.5rem" /></td>
        <td><select data-i="${i}" data-k="pose" title="characters only: generate in a rig-ready pose, facing forward (Meshy auto-rigging wants a clear humanoid)" style="width:5.5rem">
          <option value="">pose —</option>
          <option value="a"${r.pose === "a" ? " selected" : ""}>A-pose</option>
          <option value="t"${r.pose === "t" ? " selected" : ""}>T-pose</option>
        </select></td>
        <td><button class="ghost" data-del="${i}" title="remove">✕</button></td>
      </tr>`,
    )
    .join("");
  const n = localManifest.filter((r) => r.name.trim()).length;
  app.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div>
          <strong>Style locked. Now: what gets built in it?</strong>
          <p class="hint">The sheet's panels were suggestions — steal their names or write your
          own list. Nothing is spent until you draw concepts.</p>
        </div>
        <img src="/kit-files/${esc(state.sheet.file)}" alt="approved style sheet" class="zoomable" title="click to view full size" style="height:72px;border-radius:8px" />
      </div>
      <table class="manifest"><tbody>${rows}</tbody></table>
      <div class="actions">
        <button id="back-sheet" class="ghost">← Style sheet</button>
        <button id="add" class="ghost">+ Add asset</button>
        <button id="unit-toggle" class="ghost" title="switch height units (kit always stores metres)">heights: ${heightUnit}</button>
        <button id="gen" ${n === 0 ? "disabled" : ""}>Draw ${n} concept${n === 1 ? "" : "s"} (~${n * CONCEPT_CREDITS} credits)</button>
        <label class="hint" style="display:flex;align-items:center;gap:0.4rem">
          <input type="checkbox" id="autocont" />
          <span id="skip-cost">skip concept review, lift straight to 3D (~${n * (CONCEPT_CREDITS + LIFT_FAST)} credits)</span>
        </label>
      </div>
      <label class="hint" style="display:flex;align-items:center;gap:0.4rem;margin-top:0.5rem">
        <input type="checkbox" id="hq" />
        <span id="hq-label">default lifts to high quality: meshy-6 with 4K textures — crisper surfaces
        and faces, ${LIFT_HIGH} credits per lift instead of ${LIFT_FAST}, slower. You can also pick
        per asset at concept review (e.g. HQ for characters, fast for props)</span>
      </label>
      <div class="field" style="margin:0.8rem 0 0">
        <label class="hint" for="pc">polygon budget:
          <strong id="pc-label">${fmtPoly(state.polycount ?? 30000)}</strong> triangles per asset</label>
        <input type="range" id="pc" min="0" max="100" step="1" value="${sliderFromPoly(state.polycount ?? 30000)}" style="width:min(420px,100%)" />
        <p class="hint" style="margin:0.2rem 0 0">retro ~1,500 · mobile ~5,000 · PC/console ~30,000 (default)
        · max 300,000. Actual counts deviate from target. Textures stay 2K/4K — the API goes no lower.</p>
      </div>
      <p class="hint">For scale: 1,000 credits is a $20 Pro month at Meshy's current pricing,
      so a credit is about 2¢ and a full asset 36–66¢ depending on quality.</p>
      <p class="hint">Tip: one object per asset, described by what's <em>visible</em> — material,
      condition, one signature detail. "A raft" lifts to 3D cleanly; "a raft with a sail,
      barrels, and a steering wheel" is a scene, and scenes lift badly. Lore, size words,
      and style words don't draw: the height field records size, the sheet carries style.</p>
    </div>`;
  const updateSummary = () => {
    const count = localManifest.filter((r) => r.name.trim()).length;
    const perLift = $("#hq")?.checked ? LIFT_HIGH : LIFT_FAST;
    const gen = $("#gen");
    gen.disabled = count === 0;
    gen.textContent = `Draw ${count} concept${count === 1 ? "" : "s"} (~${count * CONCEPT_CREDITS} credits)`;
    $("#skip-cost").textContent = `skip concept review, lift straight to 3D (~${count * (CONCEPT_CREDITS + perLift)} credits)`;
  };
  app.querySelectorAll("input[data-i], select[data-i]").forEach((el) => {
    el.oninput = el.onchange = () => {
      localManifest[+el.dataset.i][el.dataset.k] = el.value;
      updateSummary(); // typing must not force a re-render (focus), but the costs must track
    };
  });
  $("#unit-toggle").onclick = () => {
    const next = heightUnit === "m" ? "ft" : "m";
    for (const r of localManifest) {
      const v = parseFloat(r.height);
      if (Number.isFinite(v)) {
        r.height = String(Math.round((next === "ft" ? v / M_PER_FT : v * M_PER_FT) * 100) / 100);
      }
    }
    heightUnit = next;
    localStorage.setItem("heightUnit", next);
    render();
  };
  app.querySelectorAll("button[data-del]").forEach((el) => {
    el.onclick = () => { localManifest.splice(+el.dataset.del, 1); render(); };
  });
  $("#back-sheet").onclick = () => post("/api/back/sheet");
  $("#add").onclick = () => { localManifest.push({ name: "", desc: "", pose: "", height: "" }); render(); };
  $("#hq").onchange = updateSummary;
  $("#pc").oninput = () => {
    $("#pc-label").textContent = fmtPoly(polyFromSlider(Number($("#pc").value)));
  };
  $("#gen").onclick = () => {
    const m = localManifest.map((r) => ({ ...r, height: toMetres(r.height) }));
    const autoContinue = $("#autocont").checked;
    const quality = $("#hq").checked ? "high" : "fast";
    const polycount = polyFromSlider(Number($("#pc").value));
    localManifest = null;
    post("/api/generate", { assets: m, autoContinue, quality, polycount });
  };
}

function assetCard(a) {
  let media, stage;
  if (a.concept.awaitingReview) {
    return `
    <div class="asset-card">
      <div class="media">
        <img src="/kit-files/${esc(a.concept.file)}?r=${a.id}-${Date.now() % 1e6}" alt="${esc(a.name)} concept" class="zoomable" title="click to view full size" />
        <span class="badge">awaiting your review</span>
      </div>
      <div class="body">
        <h3>${esc(a.name)}</h3>
        <div class="stage">Does this concept look right? Nothing is spent on 3D until you approve.</div>
        <input type="text" data-desc="${a.id}" value="${esc(a.desc)}" title="edit the description before rerolling" style="margin:0.5rem 0" />
        <div class="actions" style="margin-top:0.4rem">
          <button data-approve="${a.id}" data-q="fast">Lift · ${LIFT_FAST} cr</button>
          <button data-approve="${a.id}" data-q="high" title="meshy-6 with 4K textures — crisper surfaces and faces, slower">Lift HQ · ${LIFT_HIGH} cr</button>
          <button class="ghost" data-reroll="${a.id}">Reroll · ${CONCEPT_CREDITS} cr</button>
          <button class="ghost" data-remove="${a.id}" title="drop this asset">✕</button>
        </div>
      </div>
    </div>`;
  }
  if (a.model.status === "SUCCEEDED" && a.model.glb) {
    media = `<model-viewer src="/kit-files/${esc(a.model.glb)}" camera-controls auto-rotate
               shadow-intensity="1" alt="${esc(a.name)}"></model-viewer>
             <button class="zoom3d" data-zoom3d="/kit-files/${esc(a.model.glb)}" data-name="${esc(a.name)}" title="view large">⛶</button>`;
    stage = `done · ${a.creditsSpent} credits${a.model.tier === "high" ? " · HQ" : ""}
      <button class="ghost" data-retry="${a.id}" data-q="fast" title="a different 3D take from the same approved concept — replaces this model" style="margin-left:0.5rem;padding:0.15rem 0.6rem;font-size:0.8rem">Reroll · ${LIFT_FAST} cr</button>
      <button class="ghost" data-retry="${a.id}" data-q="high" title="reroll at high quality: meshy-6, 4K textures — replaces this model" style="padding:0.15rem 0.6rem;font-size:0.8rem">HQ · ${LIFT_HIGH} cr</button>`;
  } else if (a.concept.file) {
    const pct = a.model.status === "IN_PROGRESS" ? a.model.progress : 0;
    media = `
      <img src="/kit-files/${esc(a.concept.file)}" alt="${esc(a.name)} concept" class="zoomable" title="click to view full size" />
      <span class="badge">${a.model.status ? esc(a.model.status.toLowerCase().replace("_", " ")) : "concept ready"}</span>
      ${a.model.status && a.model.status !== "FAILED" ? `<div class="progress"><div style="width:${pct}%"></div></div>` : ""}`;
    stage = a.model.status === "FAILED" ? "3D generation failed" : "lifting concept to 3D…";
  } else if (a.error) {
    media = `<span class="hint">no output</span>`;
    stage = "failed";
  } else {
    media = `<span class="spinner"></span>`;
    stage = `drawing concept (${(a.concept.status ?? "queued").toLowerCase()})…`;
  }
  return `
    <div class="asset-card">
      <div class="media">${media}</div>
      <div class="body">
        <h3>${esc(a.name)}</h3>
        <div class="stage">${stage}</div>
        ${a.error ? `<div class="error">${esc(a.error)}<br /><button data-retry="${a.id}">Retry this asset</button></div>` : ""}
      </div>
    </div>`;
}

function renderGeneration() {
  const doneCount = state.assets.filter((a) => a.model.status === "SUCCEEDED").length;
  const awaiting = state.assets.filter((a) => a.concept.awaitingReview);
  const allSettled = state.phase === "done";
  const headline = allSettled
    ? "Set complete"
    : awaiting.length
      ? `${awaiting.length} concept${awaiting.length === 1 ? "" : "s"} awaiting review`
      : "Generating your set…";
  // A poll-triggered re-render must not eat text the user is typing into a
  // review card's description box.
  const editedDescs = {};
  let focusedDesc = null;
  app.querySelectorAll("input[data-desc]").forEach((el) => {
    editedDescs[el.dataset.desc] = el.value;
    if (document.activeElement === el) focusedDesc = el.dataset.desc;
  });
  app.innerHTML = `
    <div class="toolbar">
      <div>
        <strong>${headline}</strong>
        <p class="hint">${doneCount}/${state.assets.length} assets ready · anchored to your approved sheet</p>
      </div>
      <div class="actions" style="margin:0">
        ${allSettled && !state.sampleMode ? `<button id="new-project" class="ghost" title="back to a blank brief; downloaded files stay in kit-output/">New project</button>` : ""}
        ${awaiting.length > 1 ? `<button id="approve-all" class="ghost" title="lifts at the run's default tier; use the per-card HQ button for individual assets">Lift all ${awaiting.length} · ${awaiting.length * liftCost()} cr</button>` : ""}
        ${allSettled && exportResult ? `<a href="/kit-files/${esc(exportResult.zip)}" download><button>Download ${esc(exportResult.zip)}</button></a>` : ""}
        ${!allSettled || state.sampleMode ? "" : `<button id="export" ${doneCount === 0 || exporting ? "disabled" : ""} class="${exportResult ? "ghost" : ""}">
          ${exporting ? "Exporting…" : exportResult ? "Re-export" : "Export engine-ready kit"}
        </button>`}
      </div>
    </div>
    <div class="grid">${state.assets.map(assetCard).join("")}</div>`;
  app.querySelectorAll("button[data-retry]").forEach((el) => {
    el.onclick = () => post(`/api/assets/${el.dataset.retry}/retry`, el.dataset.q ? { quality: el.dataset.q } : undefined);
  });
  app.querySelectorAll("button[data-approve]").forEach((el) => {
    el.onclick = () => post(`/api/assets/${el.dataset.approve}/approve`, { quality: el.dataset.q });
  });
  app.querySelectorAll("button[data-reroll]").forEach((el) => {
    el.onclick = () => {
      const desc = app.querySelector(`input[data-desc="${el.dataset.reroll}"]`)?.value;
      post(`/api/assets/${el.dataset.reroll}/reroll`, { desc });
    };
  });
  app.querySelectorAll("button[data-remove]").forEach((el) => {
    el.onclick = async () => {
      await fetch(`/api/assets/${el.dataset.remove}`, { method: "DELETE" });
      await refresh();
    };
  });
  $("#approve-all") && ($("#approve-all").onclick = () => post("/api/assets/approve-all"));
  $("#new-project") && ($("#new-project").onclick = () => {
    if (confirm("Start a new project? Exported zips and downloaded files stay in kit-output/.")) {
      exportResult = null;
      localManifest = null;
      post("/api/reset");
    }
  });
  app.querySelectorAll("input[data-desc]").forEach((el) => {
    if (el.dataset.desc in editedDescs) el.value = editedDescs[el.dataset.desc];
    if (focusedDesc === el.dataset.desc) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  });
  if (!$("#export")) return;
  $("#export").onclick = async () => {
    exporting = true;
    render();
    const res = await fetch("/api/export", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    exporting = false;
    if (!res.ok) alert(data.error ?? "export failed");
    else exportResult = data;
    render();
  };
}

// ---- lightbox --------------------------------------------------------------
// Any image marked .zoomable opens full size in an overlay; click or Esc closes.

function openLightbox(src, alt) {
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<img src="${src}" alt="${alt || ""}" /><button class="lightbox-close" title="close">✕</button>`;
  const close = () => {
    box.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => e.key === "Escape" && close();
  box.onclick = close;
  document.addEventListener("keydown", onKey);
  document.body.append(box);
}

// Full-screen model viewer: same overlay, but dragging inside pivots the
// camera instead of closing, so only the backdrop and Esc dismiss it.
function openModelLightbox(src, name) {
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<model-viewer src="${src}" camera-controls shadow-intensity="1"
    alt="${name || ""}" style="width:92vw;height:92vh;cursor:grab"></model-viewer>
    <button class="lightbox-close" title="close">✕</button>`;
  const close = () => {
    box.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => e.key === "Escape" && close();
  box.onclick = (e) => { if (e.target === box || e.target.closest(".lightbox-close")) close(); };
  document.addEventListener("keydown", onKey);
  document.body.append(box);
}

document.addEventListener("click", (e) => {
  const zoom3d = e.target.closest("button[data-zoom3d]");
  if (zoom3d) return openModelLightbox(zoom3d.dataset.zoom3d, zoom3d.dataset.name);
  const img = e.target.closest("img.zoomable");
  if (img) openLightbox(img.src, img.alt);
});

// ---- export history --------------------------------------------------------

function openHistory(recs) {
  const box = document.createElement("div");
  box.className = "lightbox";
  const entries = recs.length === 0
    ? `<p class="hint">No exports on this machine yet. Export a kit and it lands here, prompts and all.</p>`
    : recs.map((r) => `
      <div class="hist-entry">
        <div class="hist-head">
          <div>
            <strong>${esc((r.brief || "untitled").slice(0, 90))}</strong>
            <p class="hint">${esc(new Date(r.exportedAt).toLocaleString())} · ${r.assets.length} asset${r.assets.length === 1 ? "" : "s"} · ${r.creditsSpent} credits${r.zip ? ` · <a href="/kit-files/${esc(r.zip)}" download>${esc(r.zip)}</a>` : ""}</p>
          </div>
          ${r.sheetImage ? `<img class="zoomable" src="/kit-files/${esc(r.sheetImage)}" alt="style sheet" title="click to view full size" style="height:64px;border-radius:6px" />` : ""}
        </div>
        <div class="hist-thumbs">
          ${r.thumbs.map((t) => `<img class="zoomable" src="/kit-files/${esc(t.image)}" alt="${esc(t.name)}" title="${esc(t.name)}" />`).join("")}
        </div>
        <details>
          <summary class="hint">prompts</summary>
          <p class="hint"><strong>Sheet:</strong> ${esc(r.sheetPrompt ?? "not recorded")}</p>
          ${r.assets.map((a) => `<p class="hint"><strong>${esc(a.name)}:</strong> ${esc(a.conceptPrompt ?? a.description ?? "")}</p>`).join("")}
        </details>
      </div>`).join("");
  box.innerHTML = `
    <div class="history-panel">
      <div class="toolbar" style="margin-bottom:0.4rem">
        <strong>Export history</strong>
        <button id="hist-close" class="ghost">✕</button>
      </div>
      ${entries}
    </div>`;
  const close = () => {
    box.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => e.key === "Escape" && close();
  box.onclick = (e) => { if (e.target === box) close(); };
  box.querySelector("#hist-close").onclick = close;
  document.addEventListener("keydown", onKey);
  document.body.append(box);
}

$("#history-btn").onclick = async () => {
  const res = await fetch("/api/exports");
  openHistory(res.ok ? await res.json() : []);
};

await refresh();
setInterval(refresh, 2000);
