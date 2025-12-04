// server.js
const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }); // 10MB hard cap

// helper to write buffer to temporary file
async function writeTempFile(buffer, ext = '.png') {
  const id = uuidv4();
  const tmpDir = process.env.TMPDIR || '/tmp';
  const inputPath = path.join(tmpDir, `${id}_in${ext}`);
  await fs.writeFile(inputPath, buffer);
  return { id, inputPath };
}

// helper to cleanup files (ignore errors)
async function safeUnlink(...paths) {
  for (const p of paths) {
    try { await fs.unlink(p); } catch (e) { /* ignore */ }
  }
}

app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // write uploaded buffer to temp file
  const origBuffer = req.file.buffer;
  // try to keep extension from original filename
  const ext = path.extname(req.file.originalname) || '.png';
  let inputObj;
  try {
    inputObj = await writeTempFile(origBuffer, ext);
  } catch (err) {
    console.error('Failed to write temp file:', err);
    return res.status(500).json({ error: 'Server file write error' });
  }

  const { id, inputPath } = inputObj;
  const tmpDir = process.env.TMPDIR || '/tmp';
  const outputPath = path.join(tmpDir, `${id}_out.png`); // ascii_magic will produce an image (png)

  // call python ascii converter
  // use python3 if available, otherwise python
  const pythonCmd = process.env.PYTHON_CMD || 'python3';
  const pyScript = path.join(__dirname, 'ascii_convert.py');

  // spawn with args: inputPath outputPath
  const proc = spawn(pythonCmd, [pyScript, inputPath, outputPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });

  // timeout (in ms) - avoid runaway conversions
  const TIMEOUT_MS = 30_000; // 30s - adjust as needed

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
  }, TIMEOUT_MS);

  // capture stderr/stdout for debugging
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  proc.stdout.on('data', (chunk) => { /* optional logging */ });

  const exitCode = await new Promise((resolve) => {
    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve(1);
    });
  });

  if (timedOut) {
    console.error('Python process timed out for', inputPath);
    await safeUnlink(inputPath, outputPath);
    return res.status(500).json({ error: 'Conversion timed out' });
  }

  if (exitCode !== 0) {
    console.error('Python script failed:', stderr);
    await safeUnlink(inputPath, outputPath);
    return res.status(500).json({ error: 'Conversion failed', details: stderr });
  }

  // read output and send
  try {
    if (!fsSync.existsSync(outputPath)) {
      throw new Error('Output file missing');
    }
    const outBuffer = await fs.readFile(outputPath);
    res.set('Content-Type', 'image/png');
    res.send(outBuffer);
  } catch (err) {
    console.error('Failed to read output:', err);
    res.status(500).json({ error: 'Failed to read converted image' });
  } finally {
    // cleanup temp files
    await safeUnlink(inputPath, outputPath);
  }
});

const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('ASCII converter running'));
app.listen(port, () => console.log(`Server listening on ${port}`));

