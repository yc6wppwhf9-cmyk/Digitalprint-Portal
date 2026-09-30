const $ = (sel, root = document) => root.querySelector(sel);

const state = { stages: [], jobs: [], view: 'designer' };

// ---------- helpers ----------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function approvalBadge(status) {
  return `<span class="badge ${esc(status)}">${status === 'approved' ? 'Approved' : 'Pre-approved'}</span>`;
}

function formatTime(sqliteUtc) {
  return new Date(`${sqliteUtc.replace(' ', 'T')}Z`).toLocaleString();
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

async function api(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const jsonRequest = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function refresh() {
  state.jobs = await api('/api/jobs');
  render();
}

// Two checkboxes that behave as "pick one" — ticking one clears the other.
function makeExclusive(boxes, onChange) {
  boxes.forEach((box) => box.addEventListener('change', () => {
    if (box.checked) boxes.forEach((other) => { if (other !== box) other.checked = false; });
    onChange?.(box);
  }));
}

// ---------- views ----------

function setView(view) {
  state.view = view;
  try { localStorage.setItem('dpp.view', view); } catch {}
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  render();
}

function render() {
  if (state.view === 'designer') renderDesigner();
  else renderBoard();
}

function renderDesigner() {
  const tbody = $('#designer-jobs');
  $('#designer-empty').hidden = state.jobs.length > 0;
  tbody.innerHTML = state.jobs.map((job) => `
    <tr data-id="${job.id}">
      <td><strong>${esc(job.title)}</strong>${job.customer ? `<div class="muted">${esc(job.customer)}</div>` : ''}</td>
      <td><a href="${esc(job.pdf_url)}" target="_blank" rel="noopener">${esc(job.pdf_name)}</a></td>
      <td>
        <label class="check"><input type="checkbox" class="approval-box" value="approved" ${job.approval_status === 'approved' ? 'checked' : ''}> Approved</label>
        <label class="check"><input type="checkbox" class="approval-box" value="preapproved" ${job.approval_status === 'preapproved' ? 'checked' : ''}> Pre-approved</label>
      </td>
      <td>${esc(job.stage_label)}</td>
      <td><button class="link" data-action="history">History</button> · <button class="danger" data-action="delete">Delete</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('tr').forEach((row) => {
    const id = row.dataset.id;
    const boxes = [...row.querySelectorAll('.approval-box')];
    makeExclusive(boxes, async (box) => {
      if (!box.checked) { box.checked = true; return; } // one status must stay selected
      try {
        await api(`/api/jobs/${id}/approval`, jsonRequest('PATCH', { approval_status: box.value }));
        toast('Approval updated');
        await refresh();
      } catch (err) { toast(err.message, true); await refresh(); }
    });
  });
}

function receivingCard(job) {
  const pct = job.qty_required > 0 ? Math.min(100, Math.round((job.qty_received / job.qty_required) * 100)) : 0;
  const short = job.qty_required - job.qty_available;
  return `
    <form class="qty-form">
      <div class="qty-grid">
        <label>Qty required<input type="number" min="0" step="1" name="qty_required" value="${job.qty_required}"></label>
        <label>Qty available<input type="number" min="0" step="1" name="qty_available" value="${job.qty_available}"></label>
        <label>Qty received<input type="number" min="0" step="1" name="qty_received" value="${job.qty_received}"></label>
        <label>Received now (+)<input type="number" min="0" step="1" name="add_received" placeholder="0"></label>
      </div>
      <div class="progress"><span style="width:${pct}%"></span></div>
      <div class="progress-text">${job.qty_received} / ${job.qty_required} received${job.qty_required ? ` · ${job.qty_pending} pending` : ' · set qty required'}</div>
      ${job.qty_required > 0 && short > 0 ? `<p class="shortfall">Available is short by ${short}</p>` : ''}
      <button type="submit" class="primary">Save qty</button>
    </form>`;
}

function stageCard(job, stage) {
  const next = state.stages[state.stages.findIndex((s) => s.key === stage.key) + 1];
  let body = '';
  if (stage.key === 'receiving') body = receivingCard(job);
  else if (next) body = `<button class="primary" data-action="advance">Mark ${esc(stage.label)} done → ${esc(next.label)}</button>`;
  else body = `<div class="muted">Qty ${job.qty_received} dispatched</div>`;

  return `
    <article class="card" data-id="${job.id}">
      <div class="card-head">
        <h4>${esc(job.title)}</h4>
        ${approvalBadge(job.approval_status)}
      </div>
      <div class="meta">${job.customer ? `${esc(job.customer)} · ` : ''}#${job.id}${stage.key !== 'receiving' ? ` · Qty ${job.qty_required}` : ''}</div>
      ${job.notes ? `<div class="meta">${esc(job.notes)}</div>` : ''}
      <div class="links">
        <a href="${esc(job.pdf_url)}" target="_blank" rel="noopener">View PDF</a>
        <button class="link" data-action="history">History</button>
      </div>
      ${body}
    </article>`;
}

function renderBoard() {
  const board = $('#board');
  board.innerHTML = state.stages.map((stage) => {
    const jobs = state.jobs.filter((j) => j.stage === stage.key);
    return `
      <section class="column">
        <h3>${esc(stage.label)} <span class="count">${jobs.length}</span></h3>
        ${jobs.map((j) => stageCard(j, stage)).join('') || '<p class="muted">No jobs</p>'}
      </section>`;
  }).join('');

  board.querySelectorAll('.qty-form').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = form.closest('.card').dataset.id;
      const data = Object.fromEntries(new FormData(form));
      try {
        const job = await api(`/api/jobs/${id}/quantities`, jsonRequest('PATCH', data));
        toast(job.stage === 'cutting' ? 'Full qty received — moved to Paper Cutting' : 'Qty saved');
        await refresh();
      } catch (err) { toast(err.message, true); }
    });
  });
}

// Shared click handling for history / advance / delete buttons.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.closest('[data-id]')?.dataset.id;
  if (!id) return;

  try {
    if (btn.dataset.action === 'history') {
      const job = await api(`/api/jobs/${id}`);
      $('#history-title').textContent = `${job.title} — ${job.stage_label}`;
      $('#history-list').innerHTML = job.history
        .map((h) => `<li>${esc(h.message)}<time>${esc(formatTime(h.created_at))}</time></li>`).join('');
      $('#history-dialog').showModal();
    } else if (btn.dataset.action === 'advance') {
      btn.disabled = true;
      const job = await api(`/api/jobs/${id}/advance`, jsonRequest('POST', {}));
      toast(`Moved to ${job.stage_label}`);
      await refresh();
    } else if (btn.dataset.action === 'delete') {
      if (!confirm('Delete this job and its PDF?')) return;
      await api(`/api/jobs/${id}`, { method: 'DELETE' });
      toast('Job deleted');
      await refresh();
    }
  } catch (err) {
    btn.disabled = false;
    toast(err.message, true);
  }
});

// ---------- designer upload ----------

const uploadForm = $('#upload-form');
makeExclusive([...uploadForm.querySelectorAll('input[name=approval]')]);

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const approval = uploadForm.querySelector('input[name=approval]:checked')?.value;
  if (!uploadForm.pdf.files.length) return toast('Choose a PDF to upload', true);
  if (!approval) return toast('Tick Approved or Pre-approved', true);

  const data = new FormData(uploadForm);
  data.delete('approval');
  data.set('approval_status', approval);
  const submit = uploadForm.querySelector('button[type=submit]');
  submit.disabled = true;
  try {
    await api('/api/jobs', { method: 'POST', body: data });
    uploadForm.reset();
    toast('Design uploaded — now visible to production');
    await refresh();
  } catch (err) {
    toast(err.message, true);
  } finally {
    submit.disabled = false;
  }
});

// ---------- boot ----------

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));

(async () => {
  state.stages = await api('/api/stages');
  let saved = 'designer';
  try { saved = localStorage.getItem('dpp.view') || saved; } catch {}
  setView(saved === 'production' ? 'production' : 'designer');
  await refresh();
  // Keep both screens in sync when designer and production work on different machines.
  setInterval(() => {
    if (document.activeElement?.closest('form')) return; // don't wipe what someone is typing
    refresh().catch(() => {});
  }, 15000);
})();
