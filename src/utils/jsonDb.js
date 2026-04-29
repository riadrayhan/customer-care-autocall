/**
 * jsonDb.js — minimal file-backed JSON store
 * --------------------------------------------
 * Synchronous read on boot, debounced async writes on mutation.
 * Atomic write via temp file + rename to avoid corruption on crash.
 * Use only for small datasets (< few thousand records).
 * Swap with PostgreSQL/MongoDB when scaling.
 */
const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

class JsonDb {
  constructor(filePath, defaultData = {}) {
    this.filePath = filePath;
    this.data = defaultData;
    this._writeTimer = null;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.data = JSON.parse(raw);
        logger.info('JsonDb loaded', { file: path.basename(this.filePath), keys: Object.keys(this.data).length });
      } else {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this._writeNow();
        logger.info('JsonDb seeded', { file: path.basename(this.filePath) });
      }
    } catch (e) {
      logger.error('JsonDb load failed — using defaults', { file: this.filePath, error: e.message });
    }
  }

  save() {
    if (this._writeTimer) clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => this._writeNow(), 250);
  }

  _writeNow() {
    try {
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      logger.error('JsonDb write failed', { file: this.filePath, error: e.message });
    }
  }

  // Force-flush on shutdown
  flushSync() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    this._writeNow();
  }
}

module.exports = JsonDb;
