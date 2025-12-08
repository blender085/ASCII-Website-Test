// worker.js
// Node adapter (local) that accepts uploads, queues jobs (limit 15), validates ephemeral tokens or API_KEY,
// calls Python ascii converter, streams result back to client.
//
// Env:
//  PORT (default 8000)
//  API_KEY (optional, legacy fallback; if provided LB might use it directly but prefer tokens)
//  MAX_QUEUE (default 15)
//  CONCURRENCY (how many tasks run in parallel; default 2)
//  PYTHON_CMD (default 'python3')
//  PY_SCRIPT (path to ascii_convert.py)
//  MAX_TOTAL_RAM_BUFFER_BYTES (default 50MB) - cap total memory used by pending job buffers
//  SECRET (optional; for token validation. If not set, will fallback to API_KEY if provided).
//
// NOTE: LB issues tokens signed with the worker's secret (the SECRET must match what was configured in LB).

const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const tmp = require('tmp');
const fs = require('fs');
const path = require('path');
const util = require('util');
const crypto = require('crypto');

const unlink = util.promisify(fs.unlink);

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } }); // allow a bit more

const PORT = Number(process.env.PORT || 8000);
const API_KEY = process.env.API_KEY || ''; // legacy fallback
const SECRET = process.env.SECRET || API_KEY || ''; // used to validate token signature - MUST match LB
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 15);
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);
const PYTHON_CMD = process.env.PYTHON_CMD || 'python3';
const PY_SCRIPT = process.env.PY_SCRIPT || path.join(__dirname, 'ascii_convert.py');
const MAX_TOTAL_RAM_BUFFER_BYTES = Number(process.env.MAX_TOTAL_RAM_BUFFER_BYTES || (50 * 1024 * 1024)); // 50MB default

if (!SECRET) {
  console.warn('WARNING: No SECRET or API_KEY provided. Token validation will fail if LB uses a secret.');
  // we'll still run but token validation expects SECRET to be set in production.
}

// in-memory queue of pending jobs (job = {id, fileBuffer, filename, opts, res, req})
const pending = [];
let running = 0;
let jobCounter = 0;
let pendingBytes = 0;

function statusInfo() {
  return {
    queue_length: pending.length,
    running,
    capacity: MAX_QUEUE,
    pending_bytes: pendingBytes,
    max_total_ram_bytes: MAX_TOTAL_RAM_BUFFER_BYTES
  };
}

// validate ephemeral token format: base64url(payload).hexsig
function validateUploadToken(token) {
  if (!token || !SECRET) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const payloadB64 = parts[0];
  const sig = parts[1];
  try {
    const expected = crypto.createHmac('sha256', SECRET).update(payloadB64).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))) return false;
    const payloadJson = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (typeof payloadJson.exp !== 'number' || Date.now() > payloadJson.exp) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// helper to run next jobs
async function tryRunNext() {
  while (running < CONCURRENCY && pending.length > 0) {
    const job = pending.shift();
    pendingBytes -= job.buffer.length;
    running++;
    runJob(job).finally(() => {
      running--;
      // attempt to start next
      setImmediate(tryRunNext);
    });
  }
}

async function runJob(job) {
  const { id, buffer, originalname, opts, res, req } = job;

  // if client disconnected while waiting
  if (job.cancelled) {
    safeFinish(res, { code: 499, message: 'client_disconnected_while_pending' });
    return;
  }

  // create temp input and output
  const inTmp = tmp.fileSync({ prefix: 'in_', postfix: path.extname(originalname) || '.png' });
  const outTmp = tmp.fileSync({ prefix: 'out_', postfix: '.png' });

  let proc = null;
  let clientGone = false;
  const onClientClose = () => {
    clientGone = true;
    // kill the python process if running
    if (proc && !proc.killed) {
      try { proc.kill('SIGTERM'); } catch (e) {}
    }
  };

  req.on('close', onClientClose);

  try {
    fs.writeFileSync(inTmp.name, buffer);

    const args = [PY_SCRIPT, inTmp.name, outTmp.name];

    if (typeof opts.enhance_image !== 'undefined') {
      args.push('--enhance', opts.enhance_image ? '1' : '0');
    }
    if (typeof opts.full_color !== 'undefined') {
      args.push('--fullcolor', opts.full_color ? '1' : '0');
    }
    if (typeof opts.char !== 'undefined' && opts.char !== null && opts.char !== '') {
      args.push('--char', opts.char);
    }

    proc = spawn(PYTHON_CMD, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.stdout.on('data', (d) => {
      // optional: parse progress if python prints it
      // console.log('[py]', d.toString());
    });

    const exitCode = await new Promise((resolve) => {
      proc.on('close', (code) => resolve(code));
      proc.on('error', (err) => {
        stderr += String(err);
        resolve(1);
      });
    });

    if (clientGone) {
      // client disconnected while processing - do not attempt to write response
      return;
    }

    if (exitCode !== 0) {
      console.error(`[job ${id}] python failed:`, stderr);
      if (!res.headersSent) {
        res.status(500).json({ error: 'conversion_failed', details: stderr.slice(0, 2000) });
      }
      return;
    }

    // stream out file
    const stat = fs.statSync(outTmp.name);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('X-Job-Id', String(id));

    const readStream = fs.createReadStream(outTmp.name);
    readStream.pipe(res);
    await new Promise((resolve) => readStream.on('close', resolve));

  } catch (err) {
    console.error(`[job ${id}] processing error:`, err);
    if (!res.headersSent && !clientGone) {
      res.status(500).json({ error: 'server_error', message: String(err) });
    }
  } finally {
    try { inTmp.removeCallback(); } catch (e) {}
    try { outTmp.removeCallback(); } catch (e) {}
    req.removeListener('close', onClientClose);
  }
}

function safeFinish(res, data) {
  if (!res.headersSent) {
    if (data && data.code === 499) {
      try { res.status(499).json({ error: 'client_disconnected' }); } catch(e) {}
    } else {
      try { res.status(500).json({ error: 'server_error' }); } catch(e) {}
    }
  }
}

// Status endpoint (LB will poll this)
app.get('/status', (req, res) => {
  res.json(statusInfo());
});

// Simple health endpoint
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), ...statusInfo() });
});

// Upload endpoint
app.post('/upload', upload.single('image'), async (req, res) => {
  // Auth: accept ephemeral token or api key
  const token = req.header('x-upload-token') || req.body.upload_token || '';
  const key = req.header('x-api-key') || req.body.api_key || '';

  const tokenValid = token ? validateUploadToken(token) : false;
  const keyValid = key && API_KEY && key === API_KEY;

  if (!tokenValid && !keyValid) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!req.file) return res.status(400).json({ error: 'no_file' });

  // read options from fields (sent by client)
  const enhance_image = (req.body.enhance_image ?? '1') === '1' || req.body.enhance_image === 'true';
  const full_color = (req.body.full_color ?? '1') === '1' || req.body.full_color === 'true';
  const char = typeof req.body.char !== 'undefined' ? (req.body.char || null) : null;

  // Prevent memory blowup: total bytes check
  if (pending.length >= MAX_QUEUE) {
    return res.status(429).json({ error: 'queue_full' });
  }
  if (pendingBytes + req.file.buffer.length > MAX_TOTAL_RAM_BUFFER_BYTES) {
    return res.status(503).json({ error: 'server_busy', message: 'server memory capacity exceeded; try later' });
  }

  const id = ++jobCounter;
  const job = {
    id,
    buffer: req.file.buffer,
    originalname: req.file.originalname || `upload_${id}.bin`,
    opts: { enhance_image, full_color, char },
    res,
    req,
    createdAt: Date.now(),
    cancelled: false
  };

  // if client disconnects while pending, mark cancelled
  const onReqClose = () => {
    job.cancelled = true;
    // also attempt to remove it from pending if still there
    const idx = pending.findIndex(j => j.id === job.id);
    if (idx !== -1) {
      pending.splice(idx, 1);
      pendingBytes -= job.buffer.length;
    }
  };
  req.on('close', onReqClose);

  pending.push(job);
  pendingBytes += req.file.buffer.length;

  // Immediately try to run jobs if slots available
  setImmediate(tryRunNext);

  // DO NOT send a JSON response here — we'll stream the image when job completes.
  // Keep request open until conversion completes.
});

app.get('/admin/queue', (req, res) => {
  const info = {
    pending_count: pending.length,
    running,
    pending_ids: pending.map(j => ({ id: j.id, name: j.originalname, age_ms: Date.now() - j.createdAt })),
    pending_bytes: pendingBytes
  };
  res.json(info);
});

app.listen(PORT, () => {
  console.log(`Worker adapter listening on :${PORT}`);
  console.log(`API_KEY (fallback): ${API_KEY ? 'set' : 'not-set'}`);
  console.log(`SECRET (for token validation): ${SECRET ? 'set' : 'not-set'}`);
  console.log(`Max queue: ${MAX_QUEUE}, concurrency: ${CONCURRENCY}`);
  console.log(`Max total RAM buffer bytes: ${MAX_TOTAL_RAM_BUFFER_BYTES}`);
});
