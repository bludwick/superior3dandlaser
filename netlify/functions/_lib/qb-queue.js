const { getStore } = require('@netlify/blobs');

const QUEUE_STORE     = 'qb-queue';
const CUSTOMERS_STORE = 'qb-customers';
const SETTINGS_STORE  = 'qb-settings';
const SETTINGS_KEY    = 'qb-settings';

const MAX_ATTEMPTS = 5;

function blobStore(name) {
  const opts = { name, consistency: 'strong' };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

function randomId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function taskKey(id) { return `task_${id}`; }

async function listTasks() {
  const bs = blobStore(QUEUE_STORE);
  const { blobs } = await bs.list();
  const tasks = await Promise.all(blobs.map(async (b) => {
    try {
      const text = await bs.get(b.key);
      return text ? JSON.parse(text) : null;
    } catch { return null; }
  }));
  return tasks.filter(Boolean).sort((a, b) =>
    new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

async function getTask(id) {
  const bs = blobStore(QUEUE_STORE);
  const text = await bs.get(taskKey(id));
  return text ? JSON.parse(text) : null;
}

async function saveTask(task) {
  const bs = blobStore(QUEUE_STORE);
  task.updatedAt = new Date().toISOString();
  await bs.set(taskKey(task.id), JSON.stringify(task));
  return task;
}

async function deleteTask(id) {
  const bs = blobStore(QUEUE_STORE);
  await bs.delete(taskKey(id));
}

// Find an existing task for (jobId, op) that isn't failed/canceled.
async function findActiveTaskByJobOp(jobId, op) {
  const all = await listTasks();
  return all.find(t => t.jobId === jobId && t.op === op &&
    (t.status === 'pending' || t.status === 'in_progress' || t.status === 'done')) || null;
}

// Enqueue a new task. Skips if an active task for (jobId, op) already exists.
async function enqueueQbTask({ jobId, op, payload }) {
  try {
    const existing = await findActiveTaskByJobOp(jobId, op);
    if (existing) {
      console.log(`[qb-queue] skipped enqueue jobId=${jobId} op=${op} (existing task id=${existing.id} status=${existing.status})`);
      return existing;
    }
    const task = {
      id: randomId(),
      jobId,
      op,
      payload: payload || null,
      status: 'pending',
      attempts: 0,
      lastError: null,
      qbTxnId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveTask(task);
    console.log(`[qb-queue] enqueued task id=${task.id} jobId=${jobId} op=${op}`);
    return task;
  } catch (err) {
    console.error('[qb-queue] enqueueQbTask error:', err.message);
    return null;
  }
}

// Dequeue the oldest pending task, flip it to in_progress, bump attempts.
async function claimNextPendingTask() {
  const all = await listTasks();
  const pending = all
    .filter(t => t.status === 'pending')
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  if (!pending.length) return null;
  const task = pending[0];
  task.status = 'in_progress';
  task.attempts = (task.attempts || 0) + 1;
  await saveTask(task);
  return task;
}

async function markTaskDone(id, qbTxnId, extra) {
  const task = await getTask(id);
  if (!task) return null;
  task.status = 'done';
  task.qbTxnId = qbTxnId || task.qbTxnId || null;
  if (extra && typeof extra === 'object') Object.assign(task, extra);
  task.lastError = null;
  await saveTask(task);
  return task;
}

async function markTaskFailed(id, errorMsg) {
  const task = await getTask(id);
  if (!task) return null;
  task.lastError = String(errorMsg || 'unknown error').slice(0, 1000);
  task.status = task.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  await saveTask(task);
  return task;
}

async function cancelPendingTasksFor(jobId, op) {
  const all = await listTasks();
  const candidates = all.filter(t => t.jobId === jobId && (op ? t.op === op : true)
    && (t.status === 'pending' || t.status === 'failed'));
  for (const t of candidates) {
    t.status = 'canceled';
    await saveTask(t);
  }
  return candidates.length;
}

// ── Customers cache ────────────────────────────────────────────────────────────
function customerKey(email) {
  return (email || '').trim().toLowerCase();
}

async function getCachedCustomer(email) {
  if (!email) return null;
  const bs = blobStore(CUSTOMERS_STORE);
  const text = await bs.get(customerKey(email));
  return text ? JSON.parse(text) : null;
}

async function saveCachedCustomer(email, data) {
  if (!email) return;
  const bs = blobStore(CUSTOMERS_STORE);
  await bs.set(customerKey(email), JSON.stringify({
    email: customerKey(email),
    listId: data.listId || null,
    editSeq: data.editSeq || null,
    name: data.name || '',
    updatedAt: new Date().toISOString(),
  }));
}

// ── Settings ───────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  qbwcUsername: '',
  qbwcPasswordHash: '',
  defaultItemName: '3D Printing Service',
  defaultTaxCode: 'TAX',
  nonTaxCode: 'NON',
  paymentMethod: 'Stripe',
  autoSyncEnabled: true,
  companyFile: '',
  lastSyncAt: null,
  lastSyncError: null,
};

async function getSettings() {
  const bs = blobStore(SETTINGS_STORE);
  const text = await bs.get(SETTINGS_KEY);
  const saved = text ? JSON.parse(text) : {};
  return { ...DEFAULT_SETTINGS, ...saved };
}

async function saveSettings(next) {
  const bs = blobStore(SETTINGS_STORE);
  const current = await getSettings();
  const merged = { ...current, ...next };
  await bs.set(SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}

// ── Job lookup helper (shared with qbwc.js) ────────────────────────────────────
async function getJob(jobId) {
  const bs = blobStore('jobs');
  const text = await bs.get(`job_${jobId}`);
  return text ? JSON.parse(text) : null;
}

// ── Project number generator ───────────────────────────────────────────────────
// Each line item gets a stable, human-readable project number so it can be
// referenced from QuickBooks. Format: "<6-CHAR-ID-SUFFIX>-<NN>".
//
// The suffix is the trailing portion of the order/job id (which already
// includes a random base36 chunk), so the number is unique without needing a
// separate counter, and the line index keeps items distinguishable on
// multi-part orders.
function shortIdSuffix(id) {
  const s = String(id || '');
  const parts = s.split('-');
  const tail = parts[parts.length - 1] || s.slice(-6) || 'XXXXXX';
  return tail.toUpperCase();
}

function assignProjectNumbers(orderId, items) {
  const suffix = shortIdSuffix(orderId);
  return (items || []).map((it, i) => {
    const existing = it && it.projectNumber;
    return Object.assign({}, it, {
      projectNumber: existing || `${suffix}-${String(i + 1).padStart(2, '0')}`,
    });
  });
}

module.exports = {
  MAX_ATTEMPTS,
  enqueueQbTask,
  listTasks,
  getTask,
  saveTask,
  deleteTask,
  findActiveTaskByJobOp,
  claimNextPendingTask,
  markTaskDone,
  markTaskFailed,
  cancelPendingTasksFor,
  getCachedCustomer,
  saveCachedCustomer,
  getSettings,
  saveSettings,
  getJob,
  shortIdSuffix,
  assignProjectNumbers,
};
