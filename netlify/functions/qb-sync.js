// Admin-only API for the QuickBooks Desktop integration.
//
// Routes (via netlify.toml):
//   GET    /api/admin/qb/queue     → list sync tasks
//   POST   /api/admin/qb/retry     → { taskId } flip failed → pending, reset attempts
//   DELETE /api/admin/qb/item      → ?id=...  remove a task
//   GET    /api/admin/qb/settings  → read QB settings (password hash redacted)
//   PUT    /api/admin/qb/settings  → update QB settings (password if provided is hashed)
//   GET    /api/admin/qb/qwc       → download the .qwc config file for QBWC
//   GET    /api/admin/qb/revenue   → revenue report aggregated from the jobs store

const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getStore } = require('@netlify/blobs');

const qb = require('./_lib/qb-queue');

const SITE_URL = process.env.SITE_URL || 'https://superior3dandlaser.com';

function blobStore(name) {
  const opts = { name, consistency: 'strong' };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function getCookie(header, name) {
  const match = (header || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : null;
}

function authError() {
  return jsonResponse(401, { error: 'Unauthorized' });
}

function getReqPath(event) {
  if (event.rawUrl) {
    try { return new URL(event.rawUrl).pathname; } catch { /* fall through */ }
  }
  return event.path || '';
}

function redactSettings(s) {
  const { qbwcPasswordHash, ...rest } = s || {};
  return { ...rest, qbwcPasswordConfigured: !!qbwcPasswordHash };
}

// ── .qwc generator ─────────────────────────────────────────────────────────
function generateQwc(settings) {
  const ownerId = process.env.QBWC_OWNER_ID || '{57F3B9B6-86F1-4FCC-B1FF-967DE1813D20}';
  const fileId  = process.env.QBWC_FILE_ID  || '{C955F7CA-2C40-4923-8B0B-6F4AD54C8DB0}';
  const appURL  = `${SITE_URL}/api/qbwc`;
  const user    = settings.qbwcUsername || '';

  return `<?xml version="1.0"?>
<?qbwc version="1.0"?>
<QBWCXML>
  <AppName>Superior 3D and Laser Admin</AppName>
  <AppID></AppID>
  <AppURL>${appURL}</AppURL>
  <AppDescription>Syncs paid print jobs from Superior 3D and Laser to QuickBooks Desktop.</AppDescription>
  <AppSupport>${SITE_URL}/admin/</AppSupport>
  <UserName>${user}</UserName>
  <OwnerID>${ownerId}</OwnerID>
  <FileID>${fileId}</FileID>
  <QBType>QBFS</QBType>
  <Scheduler>
    <RunEveryNMinutes>5</RunEveryNMinutes>
  </Scheduler>
  <IsReadOnly>false</IsReadOnly>
</QBWCXML>`;
}

// ── Revenue aggregation ────────────────────────────────────────────────────
async function aggregateRevenue({ from, to }) {
  const bs = blobStore('jobs');
  const { blobs } = await bs.list();
  const jobs = [];
  for (const b of blobs) {
    try {
      const text = await bs.get(b.key);
      if (!text) continue;
      const j = JSON.parse(text);
      if (!j || j.paymentStatus !== 'paid') continue;
      const paidAt = j.paidAt || j.createdAt;
      if (!paidAt) continue;
      if (from && new Date(paidAt) < new Date(from)) continue;
      if (to && new Date(paidAt) > new Date(to)) continue;
      jobs.push(j);
    } catch { /* skip */ }
  }

  const byDay      = {};
  const byMaterial = {};
  const byPart     = {};
  let totalSubtotal = 0;
  let totalTax      = 0;
  let totalRevenue  = 0;

  const tasks = await qb.listTasks();
  const taskIndex = {}; // jobId → { invoice: task, sales_receipt: task, payment: task }
  for (const t of tasks) {
    const bucket = taskIndex[t.jobId] || (taskIndex[t.jobId] = {});
    if (!bucket[t.op] || new Date(t.updatedAt || 0) > new Date(bucket[t.op].updatedAt || 0)) {
      bucket[t.op] = t;
    }
  }

  const rows = jobs.map(j => {
    const paidAt = j.paidAt || j.createdAt;
    const day = paidAt.slice(0, 10);
    totalSubtotal += parseFloat(j.subtotal) || 0;
    totalTax      += parseFloat(j.tax)      || 0;
    totalRevenue  += parseFloat(j.total)    || 0;

    byDay[day] = (byDay[day] || 0) + (parseFloat(j.total) || 0);
    for (const it of (j.items || [])) {
      const mat = it.material || '—';
      const part = it.partName || 'Part';
      byMaterial[mat] = (byMaterial[mat] || 0) + (parseFloat(it.lineTotal) || 0);
      byPart[part]    = (byPart[part]    || 0) + (parseFloat(it.lineTotal) || 0);
    }

    const idx = taskIndex[j.id] || {};
    const qbStatus =
      idx.sales_receipt && idx.sales_receipt.status === 'done' ? 'sales_receipt' :
      idx.payment       && idx.payment.status       === 'done' ? 'paid_invoice'  :
      idx.invoice       && idx.invoice.status       === 'done' ? 'invoice_only'  :
      (idx.invoice || idx.sales_receipt || idx.payment) ? 'pending' : 'not_synced';

    return {
      jobId:       j.id,
      paidAt,
      customerName:  j.customerName,
      customerEmail: j.customerEmail,
      subtotal:    parseFloat(j.subtotal) || 0,
      tax:         parseFloat(j.tax)      || 0,
      total:       parseFloat(j.total)    || 0,
      itemCount:   (j.items || []).length,
      qbStatus,
      invoiceTxnId:       idx.invoice       && idx.invoice.qbTxnId       || null,
      salesReceiptTxnId:  idx.sales_receipt && idx.sales_receipt.qbTxnId || null,
      paymentTxnId:       idx.payment       && idx.payment.qbTxnId       || null,
    };
  }).sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));

  return {
    totals: { subtotal: totalSubtotal, tax: totalTax, revenue: totalRevenue, jobCount: jobs.length },
    byDay,
    byMaterial,
    byPart,
    rows,
  };
}

// ── Route handlers ─────────────────────────────────────────────────────────
async function handleListQueue() {
  const tasks = await qb.listTasks();
  const limit = 200;
  return jsonResponse(200, { tasks: tasks.slice(0, limit) });
}

// Lightweight status for the sidebar widget: combines settings, queue counts,
// and paid-jobs-missing-sync count in a single response.
async function handleStatus() {
  const settings = await qb.getSettings();
  const tasks    = await qb.listTasks();
  const pending    = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').length;
  const failed     = tasks.filter(t => t.status === 'failed').length;

  const lastSyncAt = settings.lastSyncAt || null;
  const ageMin = lastSyncAt ? Math.floor((Date.now() - new Date(lastSyncAt)) / 60000) : null;
  const connected = ageMin != null && ageMin < 30;

  // Count paid jobs that are not represented by a done sales_receipt or
  // done payment task. These are candidates for a "Push All" sync.
  const bs = blobStore('jobs');
  const { blobs } = await bs.list();
  let unsyncedPaid = 0;
  for (const b of blobs) {
    try {
      const text = await bs.get(b.key);
      if (!text) continue;
      const j = JSON.parse(text);
      if (!j || j.paymentStatus !== 'paid') continue;
      const done = tasks.some(t => t.jobId === j.id &&
        (t.op === 'sales_receipt' || t.op === 'payment') &&
        t.status === 'done');
      if (!done) unsyncedPaid++;
    } catch { /* skip */ }
  }

  return jsonResponse(200, {
    configured: !!(settings.qbwcUsername && settings.qbwcPasswordHash),
    autoSyncEnabled: settings.autoSyncEnabled !== false,
    connected,
    lastSyncAt,
    lastSyncError: settings.lastSyncError || null,
    pending,
    failed,
    unsyncedPaid,
  });
}

// Scan paid jobs and enqueue a sync task (sales_receipt or payment) for any
// that don't already have a done/pending one. Also enqueues invoice tasks for
// unpaid jobs that have never been synced.
async function handleSyncAll() {
  const settings = await qb.getSettings();
  if (!settings.qbwcUsername || !settings.qbwcPasswordHash) {
    return jsonResponse(400, { error: 'Configure QBWC credentials first' });
  }

  const tasks = await qb.listTasks();
  const bs = blobStore('jobs');
  const { blobs } = await bs.list();

  let enqueuedPayment = 0;
  let enqueuedSalesReceipt = 0;
  let enqueuedInvoice = 0;
  let skipped = 0;

  for (const b of blobs) {
    try {
      const text = await bs.get(b.key);
      if (!text) continue;
      const job = JSON.parse(text);
      if (!job || !job.id) continue;

      const jobTasks = tasks.filter(t => t.jobId === job.id);
      const doneInvoice      = jobTasks.find(t => t.op === 'invoice' && t.status === 'done');
      const doneSalesReceipt = jobTasks.find(t => t.op === 'sales_receipt' && t.status === 'done');
      const donePayment      = jobTasks.find(t => t.op === 'payment' && t.status === 'done');
      const pendingAny       = jobTasks.some(t => t.status === 'pending' || t.status === 'in_progress');

      if (job.paymentStatus === 'paid') {
        if (doneSalesReceipt || donePayment) { skipped++; continue; }
        if (pendingAny) { skipped++; continue; }
        if (doneInvoice) {
          await qb.enqueueQbTask({ jobId: job.id, op: 'payment' });
          enqueuedPayment++;
        } else {
          await qb.enqueueQbTask({ jobId: job.id, op: 'sales_receipt' });
          enqueuedSalesReceipt++;
        }
      } else {
        if (doneInvoice || pendingAny) { skipped++; continue; }
        await qb.enqueueQbTask({ jobId: job.id, op: 'invoice' });
        enqueuedInvoice++;
      }
    } catch (err) {
      console.error('[qb-sync] sync-all job error:', err.message);
    }
  }

  return jsonResponse(200, {
    ok: true,
    enqueuedPayment,
    enqueuedSalesReceipt,
    enqueuedInvoice,
    skipped,
  });
}

async function handleRetry(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonResponse(400, { error: 'Invalid JSON' }); }
  const taskId = body.taskId;
  if (!taskId) return jsonResponse(400, { error: 'taskId required' });
  const task = await qb.getTask(taskId);
  if (!task) return jsonResponse(404, { error: 'Task not found' });
  task.status = 'pending';
  task.attempts = 0;
  task.lastError = null;
  await qb.saveTask(task);
  return jsonResponse(200, { ok: true, task });
}

async function handleDeleteItem(event) {
  const url = event.rawUrl ? new URL(event.rawUrl) : null;
  const id = url ? url.searchParams.get('id') : null;
  if (!id) return jsonResponse(400, { error: 'id required' });
  await qb.deleteTask(id);
  return jsonResponse(200, { ok: true });
}

async function handleGetSettings() {
  const s = await qb.getSettings();
  return jsonResponse(200, redactSettings(s));
}

async function handlePutSettings(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonResponse(400, { error: 'Invalid JSON' }); }

  const updates = {};
  if (typeof body.qbwcUsername === 'string')    updates.qbwcUsername = body.qbwcUsername.trim();
  if (typeof body.qbwcPassword === 'string' && body.qbwcPassword) {
    updates.qbwcPasswordHash = await bcrypt.hash(body.qbwcPassword, 12);
  }
  if (typeof body.defaultItemName === 'string') updates.defaultItemName = body.defaultItemName.trim() || '3D Printing Service';
  if (typeof body.defaultTaxCode === 'string')  updates.defaultTaxCode  = body.defaultTaxCode.trim()  || 'TAX';
  if (typeof body.nonTaxCode === 'string')      updates.nonTaxCode      = body.nonTaxCode.trim()      || 'NON';
  if (typeof body.paymentMethod === 'string')   updates.paymentMethod   = body.paymentMethod.trim();
  if (typeof body.companyFile === 'string')     updates.companyFile     = body.companyFile.trim();
  if (typeof body.autoSyncEnabled === 'boolean') updates.autoSyncEnabled = body.autoSyncEnabled;

  const saved = await qb.saveSettings(updates);
  return jsonResponse(200, redactSettings(saved));
}

async function handleDownloadQwc() {
  const settings = await qb.getSettings();
  if (!settings.qbwcUsername) {
    return jsonResponse(400, { error: 'Set a QBWC username first' });
  }
  const xml = generateQwc(settings);
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/xml',
      'Content-Disposition': 'attachment; filename="superior3d.qwc"',
      'Cache-Control': 'no-store',
    },
    body: xml,
  };
}

async function handleRevenue(event) {
  const url = event.rawUrl ? new URL(event.rawUrl) : null;
  const from = url ? url.searchParams.get('from') : null;
  const to   = url ? url.searchParams.get('to')   : null;
  const data = await aggregateRevenue({ from, to });
  return jsonResponse(200, data);
}

// ── Entry ──────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  // Auth
  const cookieHeader = event.headers['cookie'] || event.headers['Cookie'] || '';
  const token = getCookie(cookieHeader, 'admin_token');
  if (!token) return authError();
  try { jwt.verify(token, process.env.JWT_SECRET || ''); }
  catch { return authError(); }

  const path = getReqPath(event);
  const method = event.httpMethod;

  try {
    if (method === 'GET'    && /\/qb\/queue$/.test(path))    return await handleListQueue();
    if (method === 'POST'   && /\/qb\/retry$/.test(path))    return await handleRetry(event);
    if (method === 'DELETE' && /\/qb\/item$/.test(path))     return await handleDeleteItem(event);
    if (method === 'GET'    && /\/qb\/settings$/.test(path)) return await handleGetSettings();
    if (method === 'PUT'    && /\/qb\/settings$/.test(path)) return await handlePutSettings(event);
    if (method === 'GET'    && /\/qb\/qwc$/.test(path))      return await handleDownloadQwc();
    if (method === 'GET'    && /\/qb\/revenue$/.test(path))  return await handleRevenue(event);
    if (method === 'GET'    && /\/qb\/status$/.test(path))   return await handleStatus();
    if (method === 'POST'   && /\/qb\/sync-all$/.test(path)) return await handleSyncAll();
  } catch (err) {
    console.error('[qb-sync] error:', err.message, err.stack);
    return jsonResponse(500, { error: err.message });
  }

  return jsonResponse(404, { error: 'Not found', path, method });
};
