const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");

const app = express();
const PORT = 3000;

// Multer storage (temporary in memory)
const upload = multer({ storage: multer.memoryStorage() });

// POST /upload → receive image → convert → send back
app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("No file uploaded");

    // Convert to grayscale using sharp
    const output = await sharp(req.file.buffer)
      .grayscale()
      .toFormat("png")
      .toBuffer();

    // Send output image
    res.set("Content-Type", "image/png");
    res.send(output);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
