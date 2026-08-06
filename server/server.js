// Express wiring. The browser never sees the Meshy key: every API interaction is
// proxied through here, and the client only ever receives our own JSON snapshots
// and files we have already downloaded to disk.

try {
  process.loadEnvFile(); // reads .env; Node >=21, no dotenv dependency
} catch {
  /* no .env at all — sample mode below covers it */
}

const [{ default: express }, meshy] = await Promise.all([
  import("express"),
  import("./meshy.js"),
]);

const app = express();
// 12 MB body limit: uploaded style sheets travel as base64 data URLs (8 MB
// image cap plus base64 overhead), not as multipart, to avoid a dependency.
app.use(express.json({ limit: "12mb" }));
app.use(express.static("public"));

// ---- sample mode -----------------------------------------------------------
// Without an API key the app serves a real recorded run (sample-project/,
// committed to the repo) read-only, so the loop can be explored before paying
// for Meshy API access. Nothing here is mocked: the snapshot and assets came
// from an actual session, and the UI labels the state clearly.
if (!meshy.hasKey) {
  const fs = await import("node:fs/promises");
  const sample = JSON.parse(await fs.readFile("sample-project/project.json", "utf8"));
  app.use("/kit-files", (await import("express")).default.static("sample-project"));
  app.get("/api/project", (req, res) => res.json(sample));
  app.get("/api/exports", (req, res) => res.json([]));
  app.all("/api/{*any}", (req, res) =>
    res.status(400).json({
      error:
        "Running in sample mode: no MESHY_API_KEY is configured, so this is a " +
        "read-only replay of a real recorded session. Set your key in .env to generate.",
    }),
  );
  const port = process.env.PORT ?? 3000;
  app.listen(port, () =>
    console.log(`Greenlight (SAMPLE MODE, no API key) → http://localhost:${port}`),
  );
} else {

const [orch, kit] = await Promise.all([import("./orchestrator.js"), import("./kit.js")]);
app.use("/kit-files", express.static(orch.OUT_DIR)); // downloaded assets, for preview

const wrap = (fn) => async (req, res) => {
  try {
    res.json((await fn(req)) ?? { ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

app.get("/api/project", (req, res) => res.json(orch.snapshot()));

app.post("/api/brief", wrap(async (req) => {
  const { brief, styleWords, labels } = req.body;
  if (!brief?.trim()) throw new Error("brief is required");
  orch.generateSheet(brief.trim(), (styleWords ?? "").trim(), labels !== false); // async; client polls
}));

app.post("/api/sheet/reroll", wrap(async () => {
  if (!orch.project.brief) throw new Error("no brief to reroll from — this sheet was uploaded");
  orch.generateSheet(orch.project.brief, orch.project.styleWords);
}));

app.post("/api/sheet/upload", wrap(async (req) =>
  orch.uploadSheet(req.body.dataUrl, req.body.brief, req.body.styleWords),
));

app.post("/api/sheet/approve", wrap(async () => orch.approveSheet()));

app.post("/api/manifest", wrap(async (req) => orch.setManifest(req.body.assets ?? [])));

app.post("/api/generate", wrap(async (req) => {
  orch.setManifest(req.body.assets ?? []);
  orch.startGeneration(Boolean(req.body.autoContinue), req.body.quality, req.body.polycount);
}));

app.post("/api/assets/:id/retry", wrap(async (req) => orch.retryAsset(Number(req.params.id), req.body?.quality)));

app.post("/api/assets/:id/approve", wrap(async (req) => orch.approveConcept(Number(req.params.id), req.body?.quality)));

app.post("/api/assets/approve-all", wrap(async (req) => orch.approveAllConcepts(req.body?.quality)));

app.post("/api/assets/:id/reroll", wrap(async (req) =>
  orch.rerollConcept(Number(req.params.id), req.body?.desc),
));

app.delete("/api/assets/:id", wrap(async (req) => orch.removeAsset(Number(req.params.id))));

app.post("/api/export", wrap(async () => kit.exportKit()));

app.get("/api/exports", wrap(async () => kit.listExports()));

app.post("/api/reset", wrap(async () => orch.resetProject()));

app.post("/api/back/brief", wrap(async () => orch.backToBrief()));

app.post("/api/back/sheet", wrap(async () => orch.backToSheet()));

const port = process.env.PORT ?? 3000;
app.listen(port, () => console.log(`Greenlight → http://localhost:${port}`));

} // end keyed mode
