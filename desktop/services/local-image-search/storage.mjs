import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { LOCAL_IMAGE_SEARCH_VERSION } from "./constants.mjs";

function rowToLibrary(row) {
  return row && {
    id: row.id,
    name: row.name,
    itemCount: Number(row.item_count || 0),
    errorCount: Number(row.error_count || 0),
    status: row.status,
    modelVersion: row.model_version,
    createdAt: row.created_at,
    lastIndexedAt: row.last_indexed_at,
  };
}

export class LocalImageSearchStorage {
  constructor({ dataRoot }) {
    this.dataRoot = dataRoot;
    mkdirSync(dataRoot, { recursive: true });
    this.dbPath = path.join(dataRoot, "index.sqlite3");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS libraries (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        model_version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        item_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        scan_generation INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_indexed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT,
        format TEXT,
        width INTEGER,
        height INTEGER,
        embedding BLOB,
        scan_generation INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        UNIQUE(library_id, relative_path)
      );
      CREATE INDEX IF NOT EXISTS images_content_idx ON images(library_id, sha256);
      CREATE INDEX IF NOT EXISTS images_generation_idx ON images(library_id, scan_generation);
    `);
  }

  listLibraries() {
    return this.db.prepare("SELECT * FROM libraries ORDER BY created_at DESC").all().map(rowToLibrary);
  }

  createLibrary({ id, rootPath, name }) {
    this.db.prepare(`
      INSERT INTO libraries(id, root_path, name, model_version, status, created_at)
      VALUES (?, ?, ?, ?, 'new', ?)
    `).run(id, rootPath, name, LOCAL_IMAGE_SEARCH_VERSION, new Date().toISOString());
    return rowToLibrary(this.db.prepare("SELECT * FROM libraries WHERE id = ?").get(id));
  }

  getLibrary(id, { includePath = false } = {}) {
    const row = this.db.prepare("SELECT * FROM libraries WHERE id = ?").get(id);
    if (!row) return null;
    const result = rowToLibrary(row);
    if (includePath) result.rootPath = row.root_path;
    return result;
  }

  getImage(libraryId, imageId) {
    return this.db.prepare(`
      SELECT id, library_id, relative_path, width, height, format
      FROM images WHERE library_id = ? AND id = ? AND embedding IS NOT NULL
    `).get(libraryId, imageId) || null;
  }

  removeLibrary(id) {
    const result = this.db.prepare("DELETE FROM libraries WHERE id = ?").run(id);
    return Number(result.changes || 0) > 0;
  }

  close() {
    this.db.close();
  }
}
