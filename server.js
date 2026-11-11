// Express API gateway: forwards image jobs to the private Colab TripoSR worker.
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5000);
const AI_URL = (process.env.AI_URL || '').replace(/\/$/, '');
const WORKER_API_KEY = process.env.WORKER_API_KEY || '';
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 10);
const GENERATED = path.resolve(process.env.GENERATED_DIR || path.join(__dirname, '..', 'generated'));
const DIRS = {
  images: path.join(GENERATED, 'images'),
  models: path.join(GENERATED, 'models'),
};
const ID_RE = /^[a-f0-9-]{36}$/;
const FILE_RE = /^[a-f0-9-]{36}\.(png|jpg|glb)$/;

await Promise.all(Object.values(DIRS).map((d) => fs.mkdir(d, { recursive: true })));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 } });
const app = express();
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.includes(origin) || allowedOrigins.includes('*'))) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes('*') ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(origin && !allowedOrigins.includes(origin) && !allowedOrigins.includes('*') ? 403 : 204);
  next();
});

function workerRequest(pathname, options = {}) {
  if (!AI_URL || !WORKER_API_KEY) throw new Error('GPU worker is not configured. Set AI_URL and WORKER_API_KEY in Render.');
  const headers = new Headers(options.headers || {});
  headers.set('X-API-Key', WORKER_API_KEY);
  return fetch(`${AI_URL}${pathname}`, {
    ...options,
    headers,
    signal: options.signal || AbortSignal.timeout(30000),
  });
}

function sniff(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

async function readMeta(id) {
  try { return JSON.parse(await fs.readFile(path.join(DIRS.models, `${id}.json`), 'utf8')); }
  catch { return null; }
}

const withUrls = (model) => ({
  ...model,
  urls: {
    image: `/files/images/${model.imageFile}`,
    preview: `/files/images/${model.imageFile}`,
    glb: `/files/models/${model.glbFile}`,
    downloadGlb: `/api/models/${model.id}/download`,
  },
});

async function saveCompletedModel(id, job) {
  const existing = await readMeta(id);
  if (existing) return existing;
  const response = await workerRequest(`/jobs/${id}/download`);
  if (!response.ok) throw new Error(`GPU worker could not provide the GLB (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('GPU worker returned an empty GLB file.');
  const glbFile = `${id}.glb`;
  await fs.writeFile(path.join(DIRS.models, glbFile), bytes, { flag: 'wx' }).catch(async (e) => {
    if (e.code !== 'EEXIST') throw e;
  });
  const meta = {
    id,
    name: job.name || 'Generated model',
    createdAt: job.createdAt || new Date().toISOString(),
    imageFile: job.imageFile,
    glbFile,
    glbBytes: bytes.length,
    vertices: null,
    faces: null,
    dimensions: null,
    durationSec: null,
    device: 'Colab GPU',
  };
  await fs.writeFile(path.join(DIRS.models, `${id}.json`), JSON.stringify(meta, null, 2));
  return meta;
}

app.get('/api/health', async (_req, res) => {
  let gpuWorker = null;
  let gpuWorkerError = null;
  try {
    const response = await workerRequest('/health', { signal: AbortSignal.timeout(5000) });
    gpuWorker = await response.json();
    if (!response.ok) gpuWorkerError = gpuWorker.detail || `GPU worker returned HTTP ${response.status}`;
  } catch (error) {
    gpuWorkerError = error.message || 'GPU worker is not reachable. Start the Colab notebook and Cloudflare tunnel.';
  }
  res.json({ backend: 'ok', maxUploadMB: MAX_MB, gpuWorker, gpuWorkerError });
});

app.post('/api/generate', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded (field name: image).' });
  const ext = sniff(req.file.buffer);
  if (!ext) return res.status(415).json({ error: 'Only valid JPG and PNG images are supported by the GPU worker.' });
  const id = cryptoRandomId();
  const imageFile = `${id}.${ext}`;
  const name = path.parse(String(req.body.name || req.file.originalname || 'model').normalize('NFKC'))
    .name.replace(/[^\w .-]/g, '_').slice(0, 80) || 'model';
  await fs.writeFile(path.join(DIRS.images, imageFile), req.file.buffer, { flag: 'wx' });
  try {
    const form = new FormData();
    form.append('image', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || imageFile);
    const response = await workerRequest('/generate', { method: 'POST', body: form });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status === 401 ? 502 : response.status).json({ error: body.detail || 'GPU worker rejected the image.' });
    const workerJobId = body.job_id;
    if (!workerJobId || !ID_RE.test(workerJobId)) return res.status(502).json({ error: 'GPU worker returned an invalid job ID.' });
    // The worker's UUID is used as the public model/job ID, so polling stays aligned.
    await fs.writeFile(path.join(DIRS.models, `${id}.job.json`), JSON.stringify({ id: workerJobId, name, imageFile, createdAt: new Date().toISOString() }));
    // Normally both IDs are UUIDs; preserve the worker ID for all following requests.
    if (workerJobId !== id) {
      await fs.rename(path.join(DIRS.images, imageFile), path.join(DIRS.images, `${workerJobId}.${ext}`));
      const jobMeta = { id: workerJobId, name, imageFile: `${workerJobId}.${ext}`, createdAt: new Date().toISOString() };
      await fs.writeFile(path.join(DIRS.models, `${workerJobId}.job.json`), JSON.stringify(jobMeta));
      await fs.unlink(path.join(DIRS.models, `${id}.job.json`)).catch(() => {});
    }
    res.status(202).json({ id: workerJobId });
  } catch (error) {
    res.status(503).json({ error: error.message || 'GPU worker is unreachable. Keep the Colab runtime and tunnel running.' });
  }
});

function cryptoRandomId() {
  return globalThis.crypto.randomUUID();
}

app.get('/api/jobs/:id', async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const response = await workerRequest(`/jobs/${id}`);
    const job = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json({ error: job.detail || 'Job lookup failed.' });
    if (job.status === 'completed') {
      const jobMeta = JSON.parse(await fs.readFile(path.join(DIRS.models, `${id}.job.json`), 'utf8').catch(() => 'null'));
      if (!jobMeta) return res.status(404).json({ error: 'Job metadata expired. Please submit the image again.' });
      await saveCompletedModel(id, jobMeta);
    }
    res.json({ status: job.status, error: job.error || null });
  } catch (error) {
    res.status(503).json({ error: error.message || 'GPU worker is unreachable.' });
  }
});

app.get('/api/models', async (_req, res) => {
  const names = (await fs.readdir(DIRS.models)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
  const models = (await Promise.all(names.map((name) => readMeta(name.slice(0, -5))))).filter(Boolean);
  models.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(models.map(withUrls));
});

app.get('/api/models/:id', async (req, res) => {
  const model = ID_RE.test(req.params.id) && await readMeta(req.params.id);
  if (!model) return res.status(404).json({ error: 'Model not found. It may have been lost after a Render restart.' });
  res.json(withUrls(model));
});

app.get('/api/models/:id/download', async (req, res) => {
  const model = ID_RE.test(req.params.id) && await readMeta(req.params.id);
  if (!model) return res.status(404).json({ error: 'Model not found.' });
  res.download(path.join(DIRS.models, model.glbFile), `${model.name}.glb`);
});

app.delete('/api/models/:id', async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });
  const meta = await readMeta(id);
  if (!meta) return res.status(404).json({ error: 'Model not found.' });
  await Promise.all([
    fs.unlink(path.join(DIRS.images, meta.imageFile)).catch(() => {}),
    fs.unlink(path.join(DIRS.models, meta.glbFile)).catch(() => {}),
    fs.unlink(path.join(DIRS.models, `${id}.json`)).catch(() => {}),
    fs.unlink(path.join(DIRS.models, `${id}.job.json`)).catch(() => {}),
  ]);
  res.json({ deleted: [meta.imageFile, meta.glbFile, `${id}.json`] });
});

app.get('/files/:kind/:file', (req, res) => {
  const dir = req.params.kind === 'images' ? DIRS.images : req.params.kind === 'models' ? DIRS.models : null;
  if (!dir || !FILE_RE.test(req.params.file)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(req.params.file, { root: dir, dotfiles: 'deny' }, (error) => {
    if (error && !res.headersSent) res.status(404).json({ error: 'Not found' });
  });
});

app.use((error, _req, res, _next) => {
  if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Image is larger than ${MAX_MB} MB.` });
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Backend listening on port ${PORT}; GPU worker configured: ${Boolean(AI_URL && WORKER_API_KEY)}`));
