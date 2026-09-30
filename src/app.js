import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { openDb } from './db.js';
import { APPROVAL_STATUSES, STAGES, isFullyReceived, nextStage, stageLabel } from './workflow.js';

const MAX_PDF_BYTES = 50 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseQty(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${field} must be a whole number of 0 or more`);
  return n;
}

export function createApp({ dataDir, uploadDir, publicDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  const db = openDb(path.join(dataDir, 'portal.db'));

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.pdf`),
    }),
    limits: { fileSize: MAX_PDF_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      const looksLikePdf = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
      cb(looksLikePdf ? null : new HttpError(400, 'Only PDF files can be uploaded'), looksLikePdf);
    },
  });

  const getJob = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const getHistory = db.prepare('SELECT stage, message, created_at FROM job_history WHERE job_id = ? ORDER BY id');
  const addHistory = db.prepare('INSERT INTO job_history (job_id, stage, message) VALUES (?, ?, ?)');
  const getStageQty = db.prepare('SELECT stage, qty FROM stage_qty WHERE job_id = ?');
  const addStageQty = db.prepare('INSERT OR REPLACE INTO stage_qty (job_id, stage, qty) VALUES (?, ?, ?)');

  function loadJob(id) {
    const job = getJob.get(Number(id));
    if (!job) throw new HttpError(404, 'Job not found');
    return job;
  }

  function present(job, { withHistory = false } = {}) {
    const out = {
      ...job,
      stage_label: stageLabel(job.stage),
      pdf_url: `/uploads/${job.pdf_file}`,
      qty_pending: Math.max(job.qty_required - job.qty_received, 0),
      // e.g. { printing: 100, fusing: 98 } — qty done at each stage completed so far
      stage_qty: Object.fromEntries(getStageQty.all(job.id).map((r) => [r.stage, r.qty])),
    };
    if (withHistory) out.history = getHistory.all(job.id);
    return out;
  }

  const app = express();
  app.use(express.json());
  app.use('/uploads', express.static(uploadDir, { fallthrough: false }));
  app.use(express.static(publicDir));

  app.get('/api/stages', (_req, res) => res.json(STAGES));

  app.get('/api/jobs', (_req, res) => {
    const jobs = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, id DESC').all();
    res.json(jobs.map((j) => present(j)));
  });

  app.get('/api/jobs/:id', (req, res) => {
    res.json(present(loadJob(req.params.id), { withHistory: true }));
  });

  // Designer: upload a digital print PDF and mark it approved / pre-approved.
  app.post('/api/jobs', upload.single('pdf'), (req, res) => {
    const removeUpload = () => req.file && fs.rm(req.file.path, { force: true }, () => {});
    try {
      if (!req.file) throw new HttpError(400, 'A PDF file is required');
      const header = Buffer.alloc(5);
      const fd = fs.openSync(req.file.path, 'r');
      fs.readSync(fd, header, 0, 5, 0);
      fs.closeSync(fd);
      if (header.toString('latin1') !== '%PDF-') throw new HttpError(400, 'The uploaded file is not a valid PDF');

      const title = String(req.body.title ?? '').trim() || path.parse(req.file.originalname).name;
      const approval = String(req.body.approval_status ?? '');
      if (!APPROVAL_STATUSES.includes(approval)) {
        throw new HttpError(400, 'Mark the design as Approved or Pre-approved');
      }
      const qtyRequired = parseQty(req.body.qty_required, 'Qty required') ?? 0;

      const result = db
        .prepare(
          `INSERT INTO jobs (title, customer, notes, pdf_file, pdf_name, approval_status, qty_required)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          title,
          String(req.body.customer ?? '').trim(),
          String(req.body.notes ?? '').trim(),
          req.file.filename,
          req.file.originalname,
          approval,
          qtyRequired,
        );
      const id = Number(result.lastInsertRowid);
      addHistory.run(id, 'receiving', `Design uploaded and marked ${approval === 'approved' ? 'Approved' : 'Pre-approved'}`);
      res.status(201).json(present(loadJob(id), { withHistory: true }));
    } catch (err) {
      removeUpload();
      throw err;
    }
  });

  // Designer: change approval status (e.g. pre-approved -> approved).
  app.patch('/api/jobs/:id/approval', (req, res) => {
    const job = loadJob(req.params.id);
    const approval = String(req.body?.approval_status ?? '');
    if (!APPROVAL_STATUSES.includes(approval)) throw new HttpError(400, 'approval_status must be approved or preapproved');
    if (approval !== job.approval_status) {
      db.prepare("UPDATE jobs SET approval_status = ?, updated_at = datetime('now') WHERE id = ?").run(approval, job.id);
      addHistory.run(job.id, job.stage, `Design marked ${approval === 'approved' ? 'Approved' : 'Pre-approved'}`);
    }
    res.json(present(loadJob(job.id), { withHistory: true }));
  });

  // Production: record qty required / available / received.
  // Once the full required qty is received the job moves on to Paper Printing automatically.
  app.patch('/api/jobs/:id/quantities', (req, res) => {
    const job = loadJob(req.params.id);
    if (job.stage !== 'receiving') throw new HttpError(409, 'Quantities can only be changed while the job is in Qty Receiving');

    const body = req.body ?? {};
    const updated = { ...job };
    for (const field of ['qty_required', 'qty_available', 'qty_received']) {
      const v = parseQty(body[field], field.replace('qty_', 'Qty '));
      if (v !== undefined) updated[field] = v;
    }
    const add = parseQty(body.add_received, 'Received now');
    if (add) updated.qty_received += add;

    db.prepare(
      `UPDATE jobs SET qty_required = ?, qty_available = ?, qty_received = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(updated.qty_required, updated.qty_available, updated.qty_received, job.id);

    const changes = [];
    if (updated.qty_required !== job.qty_required) changes.push(`required ${updated.qty_required}`);
    if (updated.qty_available !== job.qty_available) changes.push(`available ${updated.qty_available}`);
    if (updated.qty_received !== job.qty_received) changes.push(`received ${updated.qty_received}`);
    if (changes.length) addHistory.run(job.id, 'receiving', `Qty updated: ${changes.join(', ')}`);

    if (isFullyReceived(updated)) {
      const next = nextStage('receiving');
      db.prepare("UPDATE jobs SET stage = ?, updated_at = datetime('now') WHERE id = ?").run(next, job.id);
      addHistory.run(job.id, next, `Full qty received (${updated.qty_received}/${updated.qty_required}) — moved to ${stageLabel(next)}`);
    }
    res.json(present(loadJob(job.id), { withHistory: true }));
  });

  // Production: enter the qty done at the current stage, mark it done and move to the next one.
  app.post('/api/jobs/:id/advance', (req, res) => {
    const job = loadJob(req.params.id);
    if (job.stage === 'receiving') {
      throw new HttpError(409, 'Waiting for the full qty to be received before Paper Printing can start');
    }
    const next = nextStage(job.stage);
    if (!next) throw new HttpError(409, 'Job has already been dispatched');
    const qty = parseQty(req.body?.qty, 'Qty');
    if (!qty) throw new HttpError(400, `Enter the qty done at ${stageLabel(job.stage)} before marking it done`);
    addStageQty.run(job.id, job.stage, qty);
    db.prepare("UPDATE jobs SET stage = ?, updated_at = datetime('now') WHERE id = ?").run(next, job.id);
    const note = String(req.body?.note ?? '').trim();
    addHistory.run(job.id, next, `${stageLabel(job.stage)} done, qty ${qty} — moved to ${stageLabel(next)}${note ? ` (${note})` : ''}`);
    res.json(present(loadJob(job.id), { withHistory: true }));
  });

  app.delete('/api/jobs/:id', (req, res) => {
    const job = loadJob(req.params.id);
    db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
    fs.rm(path.join(uploadDir, job.pdf_file), { force: true }, () => {});
    res.status(204).end();
  });

  app.use('/api', (_req, _res) => {
    throw new HttpError(404, 'Not found');
  });

  app.use((err, _req, res, _next) => {
    let status = err.status ?? err.statusCode ?? 500;
    let message = err.message;
    if (err instanceof multer.MulterError) {
      status = 400;
      if (err.code === 'LIMIT_FILE_SIZE') message = `PDF is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB`;
    }
    if (status >= 500) {
      console.error(err);
      message = 'Something went wrong';
    }
    res.status(status).json({ error: message });
  });

  return { app, db };
}
