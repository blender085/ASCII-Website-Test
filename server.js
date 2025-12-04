// server.js
// Node.js backend to accept an image, run ascii conversion via Python, return smallest lossless result.
// Install dependencies: npm i express multer uuid sharp cors

const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();

// CORS - restrict in production by setting CORS_ORIGIN env var to your frontend origin
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// Multer: accept uploads into memory, but enforce a hard file-size limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB hard cap (adjust if desired)
});

// helper: write buffer to a temporary file and return path info
async function writeTempFile(buffer, ext = '.png') {
  const id = uuidv4();
  const tmpDir = process.env.TMPDIR || '/tmp';
  const inputPath = path.join(tmpDir, `${id}_in${ext}`);
  await fs.writeFile(inputPath, buffer);
  return { id, inputPath };
}

// helper: unlink files (ignore errors)
async function safeUnlink(...paths) {
  for (const p of paths) {
    try { await fs.unlink(p); } catch (e) { /* ignore */ }
  }
}

// Main upload endpoint
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Determine extension from original filename if present
  const origExt = path.extname(req.file.originalname) || '.png';

  // Write input temp file
  let inputPath, outputPath;
  try {
    const t = await writeTempFile(req.file.buffer, origExt);
    inputPath = t.inputPath;
    const tmpDir = process.env.TMPDIR || '/tmp';
    outputPath = path.join(tmpDir, `${t.id}_out.png`); // Python will write a PNG
  } catch (err) {
    console.error('Failed to write temp file:', err);
    return res.status(500).json({ error: 'Server file write error' });
  }

  // Spawn Python worker
  const pythonCmd = process.env.PYTHON_CMD || 'python3';
  const pyScript = path.join(__dirname, 'ascii_convert.py'); // ensure this exists

  const proc = spawn(pythonCmd, [pyScript, inputPath, outputPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });

  // Capture stderr for debugging
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.stdout.on('data', (d) => { /* optional: console.log('py:', d.toString()) */ });

  // Timeout to avoid runaway conversions
  const TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_MS || 30_000); // 30s default
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
  }, TIMEOUT_MS);

  // Wait for python to finish
  const exitCode = await new Promise((resolve) => {
    proc.on('close', (code) => { clearTimeout(timeout); resolve(code); });
    proc.on('error', (err) => { clearTimeout(timeout); resolve(1); });
  });

  if (timedOut) {
    console.error('Python conversion timed out for', inputPath);
    await safeUnlink(inputPath, outputPath);
    return res.status(500).json({ error: 'Conversion timed out' });
  }

  if (exitCode !== 0) {
    console.error('Python conversion failed. stderr:', stderr);
    await safeUnlink(inputPath, outputPath);
    return res.status(500).json({ error: 'Conversion failed', details: stderr });
  }

  // At this point python has (should have) produced outputPath
  const sharp = require('sharp'); // require here (ensure installed)

  try {
    if (!fsSync.existsSync(outputPath)) {
      throw new Error('Output file missing after python conversion');
    }

    const originalBuf = await fs.readFile(outputPath);

    // If already small enough (<700KB) we can return original PNG
    const TARGET_BYTES = 700 * 1024;

    if (originalBuf.length <= TARGET_BYTES) {
      res.set('Content-Type', 'image/png');
      res.send(originalBuf);
      return;
    }

    // Attempt lossless WebP
    let losslessWebpBuf = null;
    try {
      losslessWebpBuf = await sharp(originalBuf)
        .webp({ lossless: true })
        .toBuffer();
      console.log('lossless WebP size:', losslessWebpBuf.length);
    } catch (e) {
      console.warn('Lossless WebP conversion failed:', e && e.message);
      losslessWebpBuf = null;
    }

    // Attempt optimized PNG (lossless)
    let optimizedPngBuf = null;
    try {
      optimizedPngBuf = await sharp(originalBuf)
        .png({ compressionLevel: 9, adaptiveFiltering: true, force: true })
        .toBuffer();
      console.log('optimized PNG size:', optimizedPngBuf.length);
    } catch (e) {
      console.warn('Optimized PNG conversion failed:', e && e.message);
      optimizedPngBuf = null;
    }

    // Choose the smallest lossless variant (including original)
    const candidates = [
      { buf: originalBuf, type: 'image/png', size: originalBuf.length }
    ];
    if (losslessWebpBuf) candidates.push({ buf: losslessWebpBuf, type: 'image/webp', size: losslessWebpBuf.length });
    if (optimizedPngBuf) candidates.push({ buf: optimizedPngBuf, type: 'image/png', size: optimizedPngBuf.length });

    candidates.sort((a, b) => a.size - b.size);

    const chosen = candidates[0];
    console.log('Sending smallest lossless variant:', chosen.type, 'size:', chosen.size);

    res.set('Content-Type', chosen.type);
    res.send(chosen.buf);

  } catch (err) {
    console.error('Failed during optimization/sending:', err);
    // fallback: attempt to send original PNG if available
    try {
      if (fsSync.existsSync(outputPath)) {
        const fallback = await fs.readFile(outputPath);
        res.set('Content-Type', 'image/png');
        res.send(fallback);
      } else {
        res.status(500).json({ error: 'Failed to read converted image' });
      }
    } catch (e) {
      console.error('Fallback failed:', e);
      res.status(500).json({ error: 'Server error' });
    }
  } finally {
    // cleanup temporary files regardless of outcome
    await safeUnlink(inputPath, outputPath);
  }
});

// simple health endpoint
app.get('/', (req, res) => res.send('ASCII converter service running'));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
