// Project state and the generation pipeline. One project per server process,
// held in memory; downloaded files under kit-output/ are the durable record.
// Pipeline per asset: image-to-image (anchored to the approved style sheet)
// -> image-to-3d via input_task_id. See experiments/EXP01_FINDINGS.md for why
// this chain, and not shared prompt keywords, is what holds a set together.

import fs from "node:fs/promises";
import path from "node:path";
import * as meshy from "./meshy.js";

const AI_2D = "nano-banana"; // 3 credits/image
// Lift quality is a per-run choice. "fast" = meshy-5 at 2K textures (15 cr),
// quick and soft-surfaced; "high" = meshy-6 at 4K (30 cr), the fix when
// results look watery or faces lack detail.
const LIFT_TIERS = {
  fast: { ai_model: "meshy-5" },
  high: { ai_model: "meshy-6", texture_resolution: "4k" },
};
const MAX_INFLIGHT_3D = 6; // conservative; real queue limit is tier-dependent and undocumented for our account

export const OUT_DIR = path.resolve("kit-output");

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "asset";

export const project = {
  phase: "brief", // brief -> sheet -> manifest -> generating -> done
  autoContinue: false, // skip the per-asset concept checkpoint
  quality: "fast",
  polycount: 30000,
  sheetLabels: true,
  brief: "",
  styleWords: "",
  sheet: { status: null, taskId: null, imageUrl: null, localPath: null, rolls: 0, error: null },
  assets: [], // { id, name, desc, concept:{...}, model:{...}, error, creditsSpent }
  creditsSpent: 0,
  balance: null,
  startedAt: null,
};

let nextAssetId = 1;
let inflight3d = 0;

async function refreshBalance() {
  try {
    project.balance = await meshy.balance();
  } catch {
    /* balance display is best-effort; never let it break the pipeline */
  }
}
refreshBalance();

async function download(url, dest, attempts = 3) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed HTTP ${res.status}`);
      await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
      return dest;
    } catch (err) {
      // Same reasoning as waitForTask: a network blip should not discard a
      // generation that already succeeded and cost credits.
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

// ---- project lifecycle ----------------------------------------------------

// Back to a blank brief. Files already downloaded to kit-output/ stay on disk
// (a new project's files overwrite same-named ones, so export the zip first if
// you want to keep a kit — the UI says so).
export function resetProject() {
  const active = project.assets.some(
    (a) => a.model.status && !["SUCCEEDED", "FAILED"].includes(a.model.status),
  );
  if (active) throw new Error("assets are still generating; wait for them to settle first");
  Object.assign(project, {
    phase: "brief",
    autoContinue: false,
    quality: "fast",
    polycount: 30000,
    brief: "",
    styleWords: "",
    sheet: { status: null, taskId: null, imageUrl: null, localPath: null, rolls: 0, error: null, prompt: null, uploaded: false },
    assets: [],
    creditsSpent: 0,
    startedAt: null,
  });
}

// One step back. The sheet and its roll count survive a trip to the brief, so
// stepping back is free; only mid-generation states are locked.
export function backToBrief() {
  if (!["sheet", "manifest"].includes(project.phase)) throw new Error("nothing to go back from");
  if (project.sheet.status && !["SUCCEEDED", "FAILED"].includes(project.sheet.status))
    throw new Error("the sheet is still generating; wait for it first");
  project.phase = "brief";
}

export function backToSheet() {
  // From the asset list (step back), or from the brief when a sheet already
  // exists (the "keep the current sheet" path after stepping back).
  const ok =
    project.phase === "manifest" ||
    (project.phase === "brief" && project.sheet.status === "SUCCEEDED");
  if (!ok) throw new Error("no sheet to return to");
  project.phase = "sheet";
}

// ---- style sheet ----------------------------------------------------------

export async function generateSheet(brief, styleWords, labels = project.sheetLabels) {
  project.brief = brief;
  project.styleWords = styleWords;
  project.sheetLabels = labels !== false; // labels are asset-name ideas; AI text can typo
  project.phase = "sheet";
  project.startedAt ??= Date.now();
  project.sheet = { ...project.sheet, status: "PENDING", error: null, imageUrl: null };
  project.sheet.rolls += 1;

  const prompt =
    `concept art style sheet for a game: ${brief}. ` +
    (project.sheetLabels
      ? `Six labelled panels showing distinct game assets (buildings, props, characters) `
      : `Six panels showing distinct game assets (buildings, props, characters), with no text, no labels, no lettering anywhere, `) +
    `in one rigorously consistent art style: ${styleWords}. Plain light background.`;

  project.sheet.prompt = prompt; // recorded so exports can show exactly what was asked
  project.sheet.uploaded = false;
  try {
    const id = await meshy.createTask("text-to-image", { ai_model: AI_2D, prompt });
    project.sheet.taskId = id;
    const task = await meshy.waitForTask("text-to-image", id, {
      onProgress: (t) => (project.sheet.status = t.status),
    });
    if (task.status !== "SUCCEEDED") {
      project.sheet.error = task.task_error?.message || task.status;
      project.sheet.status = "FAILED";
      return;
    }
    project.sheet.imageUrl = task.image_urls[0];
    project.creditsSpent += task.consumed_credits ?? 3;
    // Signed URLs expire and files are deleted after 3 days — keep our own copy now.
    project.sheet.localPath = await download(
      project.sheet.imageUrl,
      path.join(OUT_DIR, "concepts", `style-sheet-${project.sheet.rolls}.png`),
    );
    project.sheet.status = "SUCCEEDED";
  } catch (err) {
    project.sheet.status = "FAILED";
    project.sheet.error = err.message;
  } finally {
    refreshBalance();
  }
}

// Bring-your-own style sheet: any PNG/JPEG can anchor the funnel, because
// image-to-image accepts data URIs in reference_image_urls. The anchoring
// mechanism does not care whether AI or a human drew the anchor.
export async function uploadSheet(dataUrl, brief, styleWords) {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(dataUrl ?? "");
  if (!m) throw new Error("expected a PNG or JPEG data URL");
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > 8 * 1024 * 1024)
    throw new Error("image too large (8 MB max) — the API's own limit is undocumented, so we stay conservative");
  if (project.assets.some((a) => a.model.status && !["SUCCEEDED", "FAILED"].includes(a.model.status)))
    throw new Error("assets are still generating; wait for them to settle first");

  project.brief = (brief ?? project.brief ?? "").trim();
  project.styleWords = (styleWords ?? project.styleWords ?? "").trim();
  project.phase = "sheet";
  project.startedAt ??= Date.now();
  project.sheet.rolls += 1;
  const dest = path.join(OUT_DIR, "concepts", `style-sheet-${project.sheet.rolls}.${m[1] === "png" ? "png" : "jpg"}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, bytes);
  Object.assign(project.sheet, {
    status: "SUCCEEDED",
    taskId: null,
    imageUrl: dataUrl, // passed straight to image-to-image as the reference
    localPath: dest,
    error: null,
    prompt: null,
    uploaded: true,
  });
}

export function approveSheet() {
  if (project.sheet.status !== "SUCCEEDED") throw new Error("no successful sheet to approve");
  project.phase = "manifest";
  if (project.assets.length === 0) {
    // Starter rows; the user edits before anything is spent.
    for (const [name, desc] of [
      ["Player character", "the main playable character"],
      ["Enemy", "a common enemy creature"],
      ["Key prop", "an important interactable object"],
    ])
      project.assets.push(makeAsset(name, desc));
  }
}

function makeAsset(name, desc, height, pose) {
  const h = Number(height);
  return {
    id: nextAssetId++,
    name,
    desc,
    // "a" or "t": generate the character in a rig-ready pose, facing forward.
    // Passed to image-to-3d as pose_mode and reinforced in the concept prompt;
    // Meshy's auto-rigging wants a clear humanoid facing +Z.
    pose: ["a", "t"].includes(pose) ? pose : null,
    quality: null, // per-asset lift tier; null = follow the project default
    // Intended in-game height in metres, user-supplied. Purely a recorded hint:
    // generated models normalize to ~2 m regardless (auto_size tested unreliable,
    // see API_NOTES), so the kit records what the user meant for import scaling.
    height: Number.isFinite(h) && h > 0 ? h : null,
    slug: slug(name),
    concept: { status: null, taskId: null, imageUrl: null, localPath: null, approved: false },
    model: { status: null, taskId: null, progress: 0, thumbnailLocal: null, glbLocal: null, modelUrls: null, textureUrls: null },
    error: null,
    creditsSpent: 0,
  };
}

export function setManifest(rows) {
  if (project.phase !== "manifest") throw new Error("not at manifest stage");
  project.assets = rows
    .filter((r) => r.name?.trim())
    .map((r) => makeAsset(r.name.trim(), (r.desc ?? "").trim(), r.height, r.pose));
  if (project.assets.length === 0) throw new Error("manifest is empty");
}

// ---- generation pipeline --------------------------------------------------

export function startGeneration(autoContinue = false, quality = "fast", polycount) {
  if (project.phase !== "manifest") throw new Error("not at manifest stage");
  project.phase = "generating";
  project.autoContinue = autoContinue;
  project.quality = quality === "high" ? "high" : "fast";
  // Polygon budget for the run, clamped to the API's documented 100-300,000.
  // Actual counts deviate from target (documented, and verified within ~4%).
  const pc = Number(polycount);
  project.polycount = Number.isFinite(pc) ? Math.min(300000, Math.max(100, Math.round(pc))) : 30000;
  for (const asset of project.assets) runAsset(asset);
}

// ---- concept checkpoint --------------------------------------------------
// The same review-before-spend gate as the style sheet, one level deeper.
// Concepts cost 3 credits; the 3D lift costs 15. A bad concept (e.g. the
// image-to-image stage occasionally returns a copy of the whole style sheet
// instead of one asset) is obvious to a human at a glance, so the pipeline
// pauses here unless the user opted out.

export function approveConcept(id, quality) {
  const asset = requireAsset(id);
  if (asset.concept.status !== "SUCCEEDED") throw new Error("no successful concept to approve");
  if (asset.concept.approved) return;
  // Quality is decided per asset at the moment of spend: heroes earn the
  // high tier, props don't have to.
  if (["fast", "high"].includes(quality)) asset.quality = quality;
  asset.concept.approved = true;
  liftAsset(asset);
}

export function approveAllConcepts(quality) {
  for (const a of project.assets) {
    if (a.concept.status === "SUCCEEDED" && !a.concept.approved && !a.model.status) {
      if (["fast", "high"].includes(quality)) a.quality = quality;
      a.concept.approved = true;
      liftAsset(a);
    }
  }
}

export function rerollConcept(id, newDesc) {
  const asset = requireAsset(id);
  if (asset.model.status) throw new Error("already lifting; too late to reroll the concept");
  if (typeof newDesc === "string" && newDesc.trim()) asset.desc = newDesc.trim();
  asset.error = null;
  asset.concept = { status: null, taskId: null, imageUrl: null, localPath: null, approved: false };
  runAsset(asset);
}

export function removeAsset(id) {
  const asset = requireAsset(id);
  if (asset.model.status && !["SUCCEEDED", "FAILED"].includes(asset.model.status))
    throw new Error("asset is mid-lift; wait for it to settle");
  project.assets = project.assets.filter((a) => a.id !== id);
  settlePhase();
}

function requireAsset(id) {
  const asset = project.assets.find((a) => a.id === id);
  if (!asset) throw new Error("no such asset");
  return asset;
}

export function retryAsset(id, quality) {
  const asset = requireAsset(id);
  if (["fast", "high"].includes(quality)) asset.quality = quality;
  asset.error = null;
  // A reroll of a finished model reopens the set: exports must wait again.
  if (project.phase === "done") project.phase = "generating";
  const freshModel = { status: null, taskId: null, progress: 0, thumbnailLocal: null, glbLocal: null, modelUrls: null, textureUrls: null };
  if (asset.concept.status === "SUCCEEDED" && asset.concept.approved) {
    // The concept survived review; only the lift failed. Re-lift, don't re-draw.
    asset.model = freshModel;
    liftAsset(asset);
  } else {
    asset.concept = { status: null, taskId: null, imageUrl: null, localPath: null, approved: false };
    asset.model = freshModel;
    runAsset(asset);
  }
}

function markCrashedStages(asset) {
  // A crash mid-stage (e.g. the task vanishing server-side) must not leave a
  // stage reading IN_PROGRESS forever next to the error.
  for (const stage of [asset.concept, asset.model]) {
    if (stage.status && !["SUCCEEDED", "FAILED"].includes(stage.status)) stage.status = "FAILED";
  }
}

function settlePhase() {
  if (project.phase !== "generating") return;
  const settled = (a) =>
    a.error || a.model.status === "SUCCEEDED" || a.model.status === "FAILED";
  if (project.assets.length && project.assets.every(settled)) project.phase = "done";
}

async function runAsset(asset) {
  try {
    await runConcept(asset);
    if (asset.concept.status === "SUCCEEDED" && project.autoContinue) {
      asset.concept.approved = true;
      await liftAsset(asset);
    }
  } catch (err) {
    asset.error = err.message;
    markCrashedStages(asset);
  } finally {
    refreshBalance();
    settlePhase();
  }
}

async function liftAsset(asset) {
  try {
    await runModel(asset);
  } catch (err) {
    asset.error = err.message;
    markCrashedStages(asset);
  } finally {
    refreshBalance();
    settlePhase();
  }
}

async function runConcept(asset) {
  asset.concept.status = "PENDING";
  const conceptPrompt =
    `${asset.name}: ${asset.desc}. Exactly one single object, centered, on a plain ` +
    `light background. Not a sheet, no panels, no labels, no text, no ground base. ` +
    (asset.pose
      ? `The character stands in a rig-ready ${asset.pose === "a" ? "A-pose, arms angled slightly down and out to the sides" : "T-pose, arms straight out horizontally"}, ` +
        `legs straight, facing the viewer straight on, full body visible, with large ` +
        `clear facial features and a detailed, expressive face. `
      : "") +
    `Crisp, sharply defined details and clean edges. ` +
    `Exactly matching the art style of the reference image.`;
  asset.concept.prompt = conceptPrompt;
  const id = await meshy.createTask("image-to-image", {
    ai_model: AI_2D,
    // "single object / no panels" wording matters: without it the i2i stage
    // occasionally returns a copy of the whole reference sheet, which the 3D
    // stage would then dutifully lift into a collage. The concept checkpoint
    // exists because this wording reduces but does not eliminate that.
    prompt: conceptPrompt,
    reference_image_urls: [project.sheet.imageUrl],
  });
  asset.concept.taskId = id;
  const task = await meshy.waitForTask("image-to-image", id, {
    onProgress: (t) => (asset.concept.status = t.status),
  });
  if (task.status !== "SUCCEEDED") {
    asset.concept.status = "FAILED";
    asset.error = `concept: ${task.task_error?.message || task.status}`;
    return;
  }
  asset.concept.imageUrl = task.image_urls[0];
  asset.creditsSpent += task.consumed_credits ?? 3;
  asset.concept.localPath = await download(
    asset.concept.imageUrl,
    path.join(OUT_DIR, "concepts", `${asset.slug}.png`),
  );
}

async function runModel(asset) {
  // The account's queue limit is tier-dependent and not reliably documented, so we
  // keep our own cap and also handle the queue-full 429 by waiting for a slot.
  while (inflight3d >= MAX_INFLIGHT_3D) await new Promise((r) => setTimeout(r, 2000));
  inflight3d++;
  try {
    asset.model.status = "PENDING";
    let id;
    for (;;) {
      try {
        const tier = asset.quality ?? project.quality ?? "fast";
        asset.model.tier = tier;
        id = await meshy.createTask("image-to-3d", {
          input_task_id: asset.concept.taskId,
          should_texture: true,
          enable_pbr: true, // defaults to false, which silently drops normal/metallic/roughness
          topology: "triangle",
          target_polycount: project.polycount ?? 30000,
          origin_at: "bottom",
          // Steer the texturing stage explicitly; left unset it drifts soft.
          texture_prompt:
            `${project.styleWords ? project.styleWords + ". " : ""}Crisp, sharply ` +
            `defined surface detail, clean edges, no blur.`,
          ...(asset.pose ? { pose_mode: `${asset.pose}-pose` } : {}),
          ...LIFT_TIERS[tier],
        });
        break;
      } catch (err) {
        if (!meshy.isQueueFull(err)) throw err;
        await new Promise((r) => setTimeout(r, 5000)); // queue full: wait for a completion
      }
    }
    asset.model.taskId = id;
    const task = await meshy.waitForTask("image-to-3d", id, {
      onProgress: (t) => {
        asset.model.status = t.status;
        asset.model.progress = t.progress ?? 0;
      },
    });
    if (task.status !== "SUCCEEDED") {
      asset.model.status = "FAILED";
      asset.error = `model: ${task.task_error?.message || task.status}`;
      return;
    }
    asset.creditsSpent += task.consumed_credits ?? 15;
    asset.model.modelUrls = task.model_urls;
    asset.model.textureUrls = task.texture_urls;
    // GLB + thumbnail immediately: the preview must come from our disk, both because
    // signed URLs expire and because we never want the demo depending on remote state.
    const dir = path.join(OUT_DIR, "models", asset.slug);
    asset.model.glbLocal = await download(task.model_urls.glb, path.join(dir, `${asset.slug}.glb`));
    if (task.thumbnail_url)
      asset.model.thumbnailLocal = await download(task.thumbnail_url, path.join(dir, "thumbnail.png"));
    asset.model.status = "SUCCEEDED";
  } finally {
    inflight3d--;
  }
}

// ---- snapshot for the client ----------------------------------------------

const rel = (p) => (p ? path.relative(OUT_DIR, p).replaceAll(path.sep, "/") : null);

export function snapshot() {
  return {
    phase: project.phase,
    brief: project.brief,
    styleWords: project.styleWords,
    sheetLabels: project.sheetLabels,
    quality: project.quality ?? "fast",
    polycount: project.polycount ?? 30000,
    balance: project.balance,
    creditsSpent:
      project.creditsSpent + project.assets.reduce((n, a) => n + a.creditsSpent, 0),
    sheet: {
      status: project.sheet.status,
      rolls: project.sheet.rolls,
      error: project.sheet.error,
      file: rel(project.sheet.localPath),
      uploaded: Boolean(project.sheet.uploaded),
    },
    assets: project.assets.map((a) => ({
      id: a.id,
      name: a.name,
      desc: a.desc,
      height: a.height,
      pose: a.pose,
      quality: a.quality,
      error: a.error,
      creditsSpent: a.creditsSpent,
      concept: {
        status: a.concept.status,
        file: rel(a.concept.localPath),
        approved: a.concept.approved,
        awaitingReview:
          a.concept.status === "SUCCEEDED" && !a.concept.approved && !a.model.status && !a.error,
      },
      model: {
        status: a.model.status,
        progress: a.model.progress,
        tier: a.model.tier ?? null,
        glb: rel(a.model.glbLocal),
        thumbnail: rel(a.model.thumbnailLocal),
      },
    })),
  };
}
