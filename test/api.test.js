import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

let server;
let base;
let tmp;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpp-'));
  const { app } = createApp({
    dataDir: path.join(tmp, 'data'),
    uploadDir: path.join(tmp, 'uploads'),
    publicDir: path.join(tmp, 'public'),
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function upload({ approval = 'approved', file = PDF, name = 'banner.pdf', title = 'Banner' } = {}) {
  const form = new FormData();
  form.set('pdf', new Blob([file], { type: 'application/pdf' }), name);
  form.set('title', title);
  if (approval) form.set('approval_status', approval);
  const res = await fetch(`${base}/api/jobs`, { method: 'POST', body: form });
  return { res, body: await res.json() };
}

const send = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { res, body: res.status === 204 ? null : await res.json() };
};

test('designer uploads a PDF marked approved and it is visible to production', async () => {
  const { res, body } = await upload();
  assert.equal(res.status, 201);
  assert.equal(body.approval_status, 'approved');
  assert.equal(body.stage, 'receiving');

  const pdf = await fetch(`${base}${body.pdf_url}`);
  assert.equal(pdf.status, 200);
  assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), PDF);

  const list = await (await fetch(`${base}/api/jobs`)).json();
  assert.ok(list.some((j) => j.id === body.id));
});

test('upload requires an approval status and a real PDF', async () => {
  assert.equal((await upload({ approval: null })).res.status, 400);
  assert.equal((await upload({ approval: 'maybe' })).res.status, 400);
  const notPdf = await upload({ file: Buffer.from('hello'), name: 'fake.pdf' });
  assert.equal(notPdf.res.status, 400);
  assert.match(notPdf.body.error, /not a valid PDF/);
});

test('designer can switch pre-approved to approved', async () => {
  const { body: job } = await upload({ approval: 'preapproved' });
  assert.equal(job.approval_status, 'preapproved');
  const { body } = await send('PATCH', `/api/jobs/${job.id}/approval`, { approval_status: 'approved' });
  assert.equal(body.approval_status, 'approved');
});

test('job stays in receiving until full qty is received, then goes to paper printing', async () => {
  const { body: job } = await upload();

  // cannot skip ahead before qty is received
  assert.equal((await send('POST', `/api/jobs/${job.id}/advance`)).res.status, 409);

  let r = await send('PATCH', `/api/jobs/${job.id}/quantities`, { qty_required: 100, qty_available: 80, qty_received: 60 });
  assert.equal(r.body.stage, 'receiving');
  assert.equal(r.body.qty_pending, 40);

  r = await send('PATCH', `/api/jobs/${job.id}/quantities`, { add_received: 30 });
  assert.equal(r.body.qty_received, 90);
  assert.equal(r.body.stage, 'receiving');

  r = await send('PATCH', `/api/jobs/${job.id}/quantities`, { add_received: 10 });
  assert.equal(r.body.qty_received, 100);
  assert.equal(r.body.stage, 'printing');

  // quantities are locked once the job has left receiving
  assert.equal((await send('PATCH', `/api/jobs/${job.id}/quantities`, { qty_received: 5 })).res.status, 409);
});

test('zero required qty never auto-advances', async () => {
  const { body: job } = await upload();
  const r = await send('PATCH', `/api/jobs/${job.id}/quantities`, { qty_required: 0, qty_received: 0 });
  assert.equal(r.body.stage, 'receiving');
});

test('rejects negative or fractional quantities', async () => {
  const { body: job } = await upload();
  assert.equal((await send('PATCH', `/api/jobs/${job.id}/quantities`, { qty_required: -1 })).res.status, 400);
  assert.equal((await send('PATCH', `/api/jobs/${job.id}/quantities`, { qty_received: 2.5 })).res.status, 400);
});

test('stages run paper printing → fusing → rolling → dispatch → dispatched', async () => {
  const { body: job } = await upload();
  await send('PATCH', `/api/jobs/${job.id}/quantities`, { qty_required: 10, qty_received: 10 });

  const seen = [];
  for (let i = 0; i < 4; i++) {
    const { res, body } = await send('POST', `/api/jobs/${job.id}/advance`);
    assert.equal(res.status, 200);
    seen.push(body.stage);
  }
  assert.deepEqual(seen, ['fusing', 'rolling', 'dispatch', 'completed']);
  assert.equal((await send('POST', `/api/jobs/${job.id}/advance`)).res.status, 409);

  const detail = await (await fetch(`${base}/api/jobs/${job.id}`)).json();
  assert.equal(detail.history.at(-1).message, 'Dispatch done — moved to Dispatched');
});

test('deleting a job removes it', async () => {
  const { body: job } = await upload();
  assert.equal((await send('DELETE', `/api/jobs/${job.id}`)).res.status, 204);
  assert.equal((await fetch(`${base}/api/jobs/${job.id}`)).status, 404);
  assert.equal((await fetch(`${base}${job.pdf_url}`)).status, 404);
});
