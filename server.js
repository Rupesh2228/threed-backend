// Main backend: validates uploads, talks to the Python AI service, serves generated files.
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5000);
const AI_URL = process.env.AI_URL || 'http://127.0.0.1:8000';
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 10);
const GENERATED = path.resolve(process.env.GENERATED_DIR || path.join(__dirname, '..', 'generated'));
const DIRS = {
  images: path.join(GENERATED, 'images'),
  models: path.join(GENERATED, 'models'),
  previews: path.join(GENERATED, 'previews'),
};
const ID_RE = /^[a-f0-9-]{36}$/;
const FILE_RE = /^[a-f0-9-]{36}\.(png|jpg|webp|glb|obj)$/;
const QUALITIES = [96, 128, 192, 256];

await Promise.all(Object.values(DIRS).map((d) => fs.mkdir(d, { recursive: true })));

// Detect real image type from magic bytes (never trust the client's MIME/extension).
function sniff(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 } });
const app = express();
const aiFetch = (p, opts = {}) => fetch(`${AI_URL}${p}`, { signal: AbortSignal.timeout(10000), ...opts });
const AI_DOWN = 'The AI service is not reachable on ' + AI_URL + '. Start it (see README) and check logs/ai-engine.log.';

const withUrls = (m) => ({
  ...m,
  urls: {
    image: `/files/images/${m.imageFile}`,
    preview: `/files/previews/${m.previewFile}`,
    glb: `/files/models/${m.glbFile}`,
    downloadGlb: `/api/models/${m.id}/download?format=glb`,
    downloadObj: `/api/models/${m.id}/download?format=obj`,
  },
});
async function readMeta(id) {
  try {
    return JSON.parse(await fs.readFile(path.join(DIRS.models, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

app.get('/api/health', async (_req, res) => {
  let ai = null;
  let aiError = null;
  try {
    const r = await aiFetch('/health', { signal: AbortSignal.timeout(2500) });
    ai = await r.json();
  } catch {
    aiError = AI_DOWN;
  }
  res.json({ backend: 'ok', maxUploadMB: MAX_MB, generatedDir: GENERATED, ai, aiError });
});

app.post('/api/generate', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded (field name: image).' });
  const ext = sniff(req.file.buffer);
  if (!ext) return res.status(415).json({ error: 'File is not a valid JPG, PNG or WEBP image.' });

  const quality = QUALITIES.includes(Number(req.body.quality)) ? Number(req.body.quality) : 96;
  const id = crypto.randomUUID();
  const imageFile = `${id}.${ext}`;
  const originalName = path
    .parse(String(req.body.name || req.file.originalname || 'model').normalize('NFKC'))
    .name.replace(/[^\w .-]/g, '_')
    .slice(0, 80) || 'model';

  await fs.writeFile(path.join(DIRS.images, imageFile), req.file.buffer, { flag: 'wx' });
  try {
    const r = await aiFetch('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: id,
        image_file: imageFile,
        original_name: originalName,
        created_at: new Date().toISOString(),
        mc_resolution: quality,
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status === 409 ? 409 : 502).json({ error: body.detail || 'AI service rejected the job.' });
    res.status(202).json({ id });
  } catch {
    res.status(503).json({ error: AI_DOWN });
  }
});

app.get('/api/jobs/:id', async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await aiFetch(`/jobs/${req.params.id}`);
    const body = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: body.detail || 'Job lookup failed' });
    res.json(body);
  } catch {
    res.status(503).json({ error: AI_DOWN });
  }
});

app.get('/api/models', async (_req, res) => {
  const names = (await fs.readdir(DIRS.models)).filter((n) => /^[a-f0-9-]{36}\.json$/.test(n));
  const metas = (await Promise.all(names.map((n) => readMeta(n.slice(0, -5))))).filter(Boolean);
  metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(metas.map(withUrls));
});

app.get('/api/models/:id', async (req, res) => {
  const m = ID_RE.test(req.params.id) && (await readMeta(req.params.id));
  if (!m) return res.status(404).json({ error: 'Model not found' });
  res.json(withUrls(m));
});

app.get('/api/models/:id/download', async (req, res) => {
  const m = ID_RE.test(req.params.id) && (await readMeta(req.params.id));
  const format = req.query.format === 'obj' ? 'obj' : 'glb';
  if (!m) return res.status(404).json({ error: 'Model not found' });
  const file = path.join(DIRS.models, `${m.id}.${format}`);
  res.download(file, `${m.name}.${format}`, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: `No ${format.toUpperCase()} file for this model.` });
  });
});

// Explicit, user-triggered delete only. Lists exactly what was removed.
app.delete('/api/models/:id', async (req, res) => {
  const m = ID_RE.test(req.params.id) && (await readMeta(req.params.id));
  if (!m) return res.status(404).json({ error: 'Model not found' });
  const targets = [
    path.join(DIRS.images, m.imageFile),
    path.join(DIRS.previews, m.previewFile),
    path.join(DIRS.models, m.glbFile),
    path.join(DIRS.models, m.objFile),
    path.join(DIRS.models, `${m.id}.json`),
  ];
  const deleted = [];
  for (const t of targets) {
    if (!t.startsWith(GENERATED + path.sep)) continue; // never leave the project dir
    try {
      await fs.unlink(t);
      deleted.push(path.relative(GENERATED, t));
    } catch { /* already gone */ }
  }
  console.log(`[delete] ${m.id} (${m.name}):`, deleted.join(', '));
  res.json({ deleted });
});

// Whitelisted static file access (no directory listing, no arbitrary paths).
app.get('/files/:kind/:file', (req, res) => {
  const dir = DIRS[req.params.kind];
  if (!dir || !FILE_RE.test(req.params.file)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(req.params.file, { root: dir, dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Not found' });
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Image is larger than ${MAX_MB} MB.` });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Backend on http://0.0.0.0:${PORT} (AI: ${AI_URL})`));
