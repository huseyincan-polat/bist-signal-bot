"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Kalıcı dosyaların (alarmlar, sinyal günlüğü) tutulduğu klasör.
 * Render'da yeniden başlatmalarda veri kaybolmasın diye bir Persistent Disk bağlayıp
 * DATA_DIR'i o diskin yoluna (ör. /var/data) ayarlayın.
 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..");

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.error(`${path.basename(filePath)} okunamadı:`, err.message);
    return fallback;
  }
}

/** Yarım yazılmış dosya kalmasın diye önce geçici dosyaya yazıp sonra taşır. */
function writeJson(filePath, data) {
  ensureDir();
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

module.exports = { DATA_DIR, readJson, writeJson };
