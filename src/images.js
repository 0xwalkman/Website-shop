/**
 * Optimises uploaded photos: applies the phone's rotation, shrinks them to at most 1600px,
 * converts to WebP (much smaller on mobile data) and drops all metadata - including the GPS
 * location that phone cameras often embed.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

async function optimise(file) {
  const out = file.path.replace(/\.[a-z]+$/i, '') + '.webp';
  await sharp(file.path, { failOn: 'error', limitInputPixels: 60e6 })
    .rotate() // respect EXIF orientation before it is stripped
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(out); // sharp writes no metadata unless asked to
  if (out !== file.path) await fs.unlink(file.path).catch(() => {});
  file.path = out;
  file.filename = path.basename(out);
}

// Express middleware: run after multer.
async function processUploads(req, res, next) {
  const files = Object.values(req.files || {}).flat();
  try {
    for (const f of files) await optimise(f);
    next();
  } catch (err) {
    await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));
    err.userMessage = "That image couldn't be read. Please upload a JPG, PNG or WebP photo.";
    next(err);
  }
}

module.exports = { processUploads, optimise };
