// worker.js
// Node adapter (local) that accepts uploads, queues jobs (limit 15), calls Python ascii converter,
// streams result back to client, and enforces API-key auth.
//
// Usage: node worker.js
// Env:
//  PORT (default 8000)
//  API_KEY (required; LB will hand this to clients for direct upload)
//  MAX_QUEUE (default 15)
//  CONCURRENCY (how many tasks run in parallel; default 2)
//  PYTHON_CMD (default 'python3')
//  PY_SCRIPT (path to ascii_convert.py)

const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const tmp = require('tmp');
const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');

const unlink = util.promisify(fs.unlink);

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // keep a max if you want

const PORT = Number(process.env.PORT || 8000);
const API_KEY = process.env.API_KEY || 'replace_me';
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 15);
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);
const PYTHON_CMD = process.env.PYTHON_CMD || 'python3';
const PY_SCRIPT = process.env.PY_SCRIPT || path.join(__dirname, 'ascii_convert.py');

if (!API_KEY) {
  console.error('Set API_KEY env var');
  process.exit(1);
}

// in-memory queue of pending jobs (job = {id, fileBuffer, filename, opts, res})
const pending = [];
let running = 0;
let jobCounter = 0;

function statusInfo() {
  return {
    queue_length: pending.length,
    running,
    capacity: MAX_QUEUE
  };
}

// helper to run next jobs
async function tryRunNext() {
  while (running < CONCURRENCY && pending.length > 0) {
    const job = pending.shift();
    running++;
    runJob(job).finally(() => {
      running--;
      // attempt to start next
      setImmediate(tryRunNext);
    });
  }
}

async function runJob(job) {
  const { id, buffer, originalname, opts, res, createdAt } = job;

  // create temp input file and output file
  const inTmp = tmp.fileSync({ prefix: 'in_', postfix: path.extname(originalname) || '.png' });
  const outTmp = tmp.fileSync({ prefix: 'out_', postfix: '.png' });

  try {
    fs.writeFileSync(inTmp.name, buffer);

    // build python args: input path, output path, then options as flags
    // we'll pass options via CLI args for simplicity
    const args = [PY_SCRIPT, inTmp.name, outTmp.name];

    // add options: enhance_image, full_color, char (we pass as --enhance true/false etc)
    if (opts && typeof opts.enhance_image !== 'undefined') {
      args.push('--enhance', opts.enhance_image ? '1' : '0');
    }
    if (opts && typeof opts.full_color !== 'undefined') {
      args.push('--fullcolor', opts.full_color ? '1' : '0');
    }
    if (opts && typeof opts.char !== 'undefined' && opts.char !== null && opts.char !== '') {
      args.push('--char', opts.char);
    }

    // spawn python
    const proc = spawn(PYTHON_CMD, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    // Optional: stream python stdout to logs
    proc.stdout.on('data', (d) => {
      // you can log progress if python prints anything
      // console.log('py:', d.toString());
    });

    // wait for exit
    const exitCode = await new Promise((resolve) => {
      proc.on('close', (code) => resolve(code));
      proc.on('error', (err) => {
        stderr += String(err);
        resolve(1);
      });
    });

    if (exitCode !== 0) {
      console.error(`[job ${id}] python failed:`, stderr);
      if (!res.headersSent) {
        res.status(500).json({ error: 'conversion_failed', details: stderr.slice(0, 2000) });
      }
      return;
    }

    // read out file and stream to client
    const stat = fs.statSync(outTmp.name);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', String(stat.size));
    // optional: send metadata header
    res.setHeader('X-Job-Id', String(id));

    const readStream = fs.createReadStream(outTmp.name);
    readStream.pipe(res);
    await new Promise((resolve) => readStream.on('close', resolve));

  } catch (err) {
    console.error(`[job ${id}] processing error:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'server_error', message: String(err) });
    }
  } finally {
    // cleanup temp files
    try { inTmp.removeCallback(); } catch (e) {}
    try { outTmp.removeCallback(); } catch (e) {}
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

// Upload endpoint that clients will POST to (LB will provide clients the URL + API key)
app.post('/upload', upload.single('image'), async (req, res) => {
  // Auth
  const key = req.header('x-api-key');
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!req.file) return res.status(400).json({ error: 'no_file' });

  // read options from fields (sent by client)
  const enhance_image = (req.body.enhance_image ?? '1') === '1' || req.body.enhance_image === 'true';
  const full_color = (req.body.full_color ?? '1') === '1' || req.body.full_color === 'true';
  const char = typeof req.body.char !== 'undefined' ? (req.body.char || null) : null;

  // If queue full, reject with 429 so LB can wait/retry or client can ask LB again
  if (pending.length >= MAX_QUEUE) {
    return res.status(429).json({ error: 'queue_full' });
  }

  const id = ++jobCounter;
  const job = {
    id,
    buffer: req.file.buffer,
    originalname: req.file.originalname || `upload_${id}.bin`,
    opts: { enhance_image, full_color, char },
    res,
    createdAt: Date.now()
  };

  // push into queue and trigger runner
  pending.push(job);

  // Immediately try to run jobs if slots available
  setImmediate(tryRunNext);

  // IMPORTANT: do NOT send any JSON response here — we'll stream the image when job completes.
  // But we must NOT let this request time out on client side; client should wait for the response.
  // The response will be handled by runJob that pipes the PNG to `res`.
});

// small admin endpoint to inspect queue (optional, protected)
app.get('/admin/queue', (req, res) => {
  const info = {
    pending_count: pending.length,
    running,
    pending_ids: pending.map(j => ({ id: j.id, name: j.originalname, age_ms: Date.now() - j.createdAt }))
  };
  res.json(info);
});

app.listen(PORT, () => {
  console.log(`Worker adapter listening on :${PORT}`);
  console.log(`API_KEY required for uploads: ${API_KEY}`);
  console.log(`Max queue: ${MAX_QUEUE}, concurrency: ${CONCURRENCY}`);
});
