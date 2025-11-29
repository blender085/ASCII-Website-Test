// server.js
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const cors = require('cors');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } }); // 15 MB limit

// Configure CORS: in production set origin to your frontend URL
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*'
}));

app.get('/', (req, res) => res.send('Image grayscale service is running'));

app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Convert to grayscale and return PNG buffer
    const outputBuffer = await sharp(req.file.buffer)
      .grayscale()
      .png()
      .toBuffer();

    res.set('Content-Type', 'image/png');
    return res.send(outputBuffer);

  } catch (err) {
    console.error('Conversion error:', err);
    return res.status(500).json({ error: 'Server error during conversion' });
  }
});

// Use the Render-provided PORT or fallback to 3000 for local dev
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
