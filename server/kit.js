// Kit export: turn the project's downloaded assets into a self-contained,
// engine-ready folder and zip. Files, not links — Meshy deletes generated assets
// after 3 days, so a kit containing URLs would rot.

import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import archiver from "archiver";
import * as meshy from "./meshy.js";
import { project, OUT_DIR } from "./orchestrator.js";

// Formats beyond GLB are fetched at export time. A format's property is simply
// absent from model_urls if it wasn't generated.
const EXTRA_FORMATS = ["fbx", "obj", "mtl", "usdz", "stl"];

async function download(url, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed HTTP ${res.status}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

export async function exportKit() {
  const done = project.assets.filter((a) => a.model.status === "SUCCEEDED");
  if (done.length === 0) throw new Error("no completed assets to export");

  for (const asset of done) {
    const dir = path.join(OUT_DIR, "models", asset.slug);
    // Re-fetch the task: our stored signed URLs may be near expiry, and the task
    // object is the source of truth for which formats exist.
    const task = await meshy.getTask("image-to-3d", asset.model.taskId);
    for (const fmt of EXTRA_FORMATS) {
      const url = task.model_urls?.[fmt];
      if (url) await download(url, path.join(dir, `${asset.slug}.${fmt}`));
    }
    // texture_urls is an array of map objects: base_color always, plus
    // normal/metallic/roughness because we set enable_pbr.
    for (const [i, maps] of (task.texture_urls ?? []).entries()) {
      for (const [kind, url] of Object.entries(maps)) {
        await download(url, path.join(dir, "textures", `${kind}${i > 0 ? `_${i}` : ""}.png`));
      }
    }
  }

  const manifest = {
    tool: "greenlight",
    generatedAt: new Date().toISOString(),
    brief: project.brief,
    styleWords: project.styleWords,
    styleSheet: {
      taskId: project.sheet.taskId,
      rolls: project.sheet.rolls,
      prompt: project.sheet.prompt ?? null,
      uploaded: Boolean(project.sheet.uploaded),
    },
    pipeline: "text-to-image sheet -> image-to-image (sheet as reference) -> image-to-3d (input_task_id)",
    defaultQuality: project.quality ?? "fast",
    targetPolycount: project.polycount ?? 30000,
    models: { image: "nano-banana", threeD: "per asset — see each asset's liftTier" },
    creditsSpent: project.creditsSpent + project.assets.reduce((n, a) => n + a.creditsSpent, 0),
    assets: done.map((a) => ({
      name: a.name,
      description: a.desc,
      intendedHeightM: a.height,
      rigReadyPose: a.pose ? `${a.pose}-pose` : null,
      liftTier: a.model.tier === "high" ? "high (meshy-6, 4K)" : "fast (meshy-5, 2K)",
      folder: `models/${a.slug}/`,
      conceptPrompt: a.concept.prompt ?? null,
      conceptTaskId: a.concept.taskId,
      modelTaskId: a.model.taskId,
      creditsSpent: a.creditsSpent,
    })),
  };
  await fs.writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

  await fs.writeFile(
    path.join(OUT_DIR, "LICENSE-NOTES.md"),
    `# Licence notes for this kit

These assets were generated with the Meshy API on a **paid plan**. Under Meshy's
Terms of Use (read 2026-08-04), paid-plan customers own the assets they create and
may distribute and sell them. Two obligations travel with this kit:

1. Do not use these assets to train, develop, or improve AI models that compete
   with Meshy (Terms §2.6(xi)).
2. If you regenerate assets on a **free** Meshy plan instead, the resulting assets
   are owned by Meshy and licensed to you under CC BY 4.0, which requires
   attribution. This kit's assets are not under that licence.

This file is a summary, not legal advice. Check the current terms:
https://www.meshy.ai/terms-of-use
`,
  );

  await fs.writeFile(
    path.join(OUT_DIR, "README.md"),
    `# ${project.brief.slice(0, 60) || "Game jam asset kit"}

Generated with Greenlight via the Meshy API.

- \`models/<asset>/\` — the 3D files. GLB embeds its textures and is the most
  reliable import (Unity needs the glTFast package; Unreal and Godot read glTF
  natively). FBX/OBJ ship textures separately — if a model imports white,
  reassign the maps from \`textures/\`.
- \`concepts/\` — the approved style sheet and per-asset concept art. Text
  painted into these images may be misspelled; they are reference art, not UI.
- \`manifest.json\` — every prompt, task ID, and parameter used, per asset.

Honest notes on what generated geometry is:

- **Scale.** Every model arrives normalized to roughly 2 m on its longest
  axis, regardless of what it depicts — a seagull and a person come out the
  same size. Scale each asset in your engine (one Unity/Unreal/Godot unit is
  one metre)${project.assets.some((a) => a.height) ? "; intended heights you entered are listed below and in manifest.json" : ""}.
- **Topology.** Meshes are triangle soup (target ${project.polycount ?? 30000}
  triangles per asset; actual counts deviate) made of many loose shells, not
  welded solids. Fine for rendering and jam collision via convex hulls or
  boxes; not suitable for rigging, booleans, or clean decimation without
  retopo.
- **PBR maps** (base color, normal, metallic, roughness at 2048²) ship in
  \`textures/\` and are embedded in the GLB.
${project.assets.filter((a) => a.height).map((a) => `- ${a.name}: intended height ${a.height} m`).join("\n")}
`,
  );

  // Timestamped name: exports never overwrite each other. Contents are scoped
  // to the CURRENT project's assets — kit-output/ accumulates across projects
  // on disk, and sweeping whole directories into the zip shipped strangers.
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
  const zipName = `kit-${stamp}.zip`;
  const zipPath = path.join(OUT_DIR, zipName);
  await new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 6 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    for (const a of done) {
      archive.directory(path.join(OUT_DIR, "models", a.slug), `models/${a.slug}`);
      if (a.concept.localPath) archive.file(a.concept.localPath, { name: `concepts/${a.slug}.png` });
    }
    if (project.sheet.localPath) archive.file(project.sheet.localPath, { name: "concepts/style-sheet.png" });
    archive.file(path.join(OUT_DIR, "manifest.json"), { name: "manifest.json" });
    archive.file(path.join(OUT_DIR, "LICENSE-NOTES.md"), { name: "LICENSE-NOTES.md" });
    archive.file(path.join(OUT_DIR, "README.md"), { name: "README.md" });
    archive.finalize();
  });
  // Self-contained export record for the History view: small thumbnails plus
  // the full prompt trail, immune to later projects overwriting slug folders.
  const recDir = path.join(OUT_DIR, "exports", stamp);
  await fs.mkdir(recDir, { recursive: true });
  if (project.sheet.localPath)
    await fs.copyFile(project.sheet.localPath, path.join(recDir, "sheet.png"));
  for (const a of done) {
    if (a.model.thumbnailLocal)
      await fs.copyFile(a.model.thumbnailLocal, path.join(recDir, `${a.slug}.png`));
  }
  await fs.writeFile(
    path.join(recDir, "record.json"),
    JSON.stringify(
      {
        stamp,
        exportedAt: manifest.generatedAt,
        zip: zipName,
        brief: project.brief,
        styleWords: project.styleWords,
        sheetPrompt: project.sheet.prompt ?? null,
        creditsSpent: manifest.creditsSpent,
        assets: manifest.assets,
      },
      null,
      2,
    ),
  );

  return { zip: zipName, assets: done.length };
}

// History of everything ever exported on this machine, newest first.
export async function listExports() {
  const dir = path.join(OUT_DIR, "exports");
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const records = [];
  for (const stamp of entries.sort().reverse()) {
    try {
      const rec = JSON.parse(await fs.readFile(path.join(dir, stamp, "record.json"), "utf8"));
      const files = await fs.readdir(path.join(dir, stamp));
      rec.sheetImage = files.includes("sheet.png") ? `exports/${stamp}/sheet.png` : null;
      rec.thumbs = rec.assets
        .filter((a) => files.includes(`${a.folder.split("/")[1]}.png`))
        .map((a) => ({ name: a.name, image: `exports/${stamp}/${a.folder.split("/")[1]}.png` }));
      records.push(rec);
    } catch {
      /* half-written or foreign folder; skip it */
    }
  }
  return records;
}
