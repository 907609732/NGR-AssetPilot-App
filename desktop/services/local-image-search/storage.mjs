import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { LOCAL_IMAGE_SEARCH_VERSION } from "./constants.mjs";
import {
  BUILTIN_INDEX_PROFILE,
  BUILTIN_MODEL_FINGERPRINT,
  BUILTIN_MODEL_ID,
  createBuiltinModelManifest,
} from "./model-manager.mjs";

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToLibrary(row) {
  return row && {
    id: row.id,
    name: row.name,
    itemCount: Number(row.active_item_count ?? row.item_count ?? 0),
    errorCount: Number(row.active_error_count ?? row.error_count ?? 0),
    status: row.active_status ?? row.status,
    modelVersion: row.model_version,
    modelId: row.active_model_id || BUILTIN_MODEL_ID,
    modelFingerprint: row.active_model_fingerprint || BUILTIN_MODEL_FINGERPRINT,
    executionProfile: row.active_execution_profile ?? null,
    createdAt: row.created_at,
    lastIndexedAt: row.active_last_indexed_at ?? row.last_indexed_at,
  };
}

function rowToModel(row) {
  if (!row) return null;
  const manifest = safeJson(row.manifest_json, {});
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    version: row.version,
    fingerprint: row.fingerprint,
    dimensions: Number(row.dimensions),
    estimatedVectorBytesPer100k: Number(row.dimensions) * 4 * 100_000,
    supportsText: row.kind === "image-text",
    builtin: Boolean(row.builtin),
    certification: row.certification,
    status: row.status,
    ready: row.status === "ready",
    license: row.license,
    totalBytes: Number(row.total_bytes || 0),
    gpuCompatibility: safeJson(row.gpu_compatibility, { status: "unknown" }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    manifest,
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

      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('image', 'image-text')),
        version TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK(dimensions > 0),
        builtin INTEGER NOT NULL DEFAULT 0,
        certification TEXT NOT NULL DEFAULT 'unverified',
        status TEXT NOT NULL DEFAULT 'missing',
        license TEXT NOT NULL DEFAULT '未声明',
        manifest_json TEXT NOT NULL,
        relative_root TEXT NOT NULL,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        gpu_compatibility TEXT NOT NULL DEFAULT '{"status":"unknown"}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS library_models (
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        model_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        item_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        scan_generation INTEGER NOT NULL DEFAULT 0,
        execution_profile TEXT,
        last_indexed_at TEXT,
        PRIMARY KEY(library_id, model_id, model_fingerprint)
      );
      CREATE INDEX IF NOT EXISTS library_models_model_idx
        ON library_models(model_id, model_fingerprint, library_id);
      CREATE TABLE IF NOT EXISTS image_embeddings (
        library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        model_fingerprint TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        embedding BLOB,
        scan_generation INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        PRIMARY KEY(library_id, image_id, model_id, model_fingerprint)
      );
      CREATE INDEX IF NOT EXISTS image_embeddings_model_idx
        ON image_embeddings(library_id, model_id, model_fingerprint, image_id);
      CREATE INDEX IF NOT EXISTS image_embeddings_generation_idx
        ON image_embeddings(library_id, model_id, model_fingerprint, scan_generation);
      CREATE TABLE IF NOT EXISTS local_search_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const libraryModelColumns = this.db.prepare("PRAGMA table_info(library_models)").all();
    if (!libraryModelColumns.some((column) => column.name === "execution_profile")) {
      this.db.exec("ALTER TABLE library_models ADD COLUMN execution_profile TEXT");
    }
    this.ensureBuiltinModel();
    this.ensureBuiltinIndexProfile();
  }

  ensureBuiltinModel() {
    const manifest = createBuiltinModelManifest();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO models(
        id, fingerprint, name, kind, version, dimensions, builtin, certification,
        status, license, manifest_json, relative_root, total_bytes, gpu_compatibility,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'built-in', 'unknown', ?, ?, '.', ?, '{"status":"unknown"}', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        fingerprint=excluded.fingerprint,
        name=excluded.name,
        kind=excluded.kind,
        version=excluded.version,
        dimensions=excluded.dimensions,
        builtin=1,
        certification='built-in',
        license=excluded.license,
        manifest_json=excluded.manifest_json,
        relative_root='.',
        total_bytes=excluded.total_bytes,
        gpu_compatibility=CASE
          WHEN models.fingerprint <> excluded.fingerprint THEN excluded.gpu_compatibility
          ELSE models.gpu_compatibility
        END,
        updated_at=excluded.updated_at
    `).run(
      manifest.id,
      manifest.fingerprint,
      manifest.name,
      manifest.kind,
      manifest.version,
      manifest.dimensions,
      manifest.license,
      JSON.stringify(manifest),
      manifest.totalBytes,
      now,
      now,
    );
    this.db.prepare(`
      INSERT INTO local_search_settings(key, value) VALUES ('active_model_id', ?)
      ON CONFLICT(key) DO NOTHING
    `).run(BUILTIN_MODEL_ID);
  }

  ensureBuiltinIndexProfile() {
    const storedProfile = this.db.prepare(
      "SELECT value FROM local_search_settings WHERE key = 'builtin_index_profile'",
    ).get()?.value;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (storedProfile !== BUILTIN_INDEX_PROFILE) {
        this.db.prepare("DELETE FROM image_embeddings WHERE model_id = ?").run(BUILTIN_MODEL_ID);
        this.db.prepare("DELETE FROM library_models WHERE model_id = ?").run(BUILTIN_MODEL_ID);
        this.db.prepare("UPDATE images SET embedding = NULL, error_code = NULL").run();
        this.db.prepare(`
          UPDATE libraries
          SET status='new', item_count=0, error_count=0, scan_generation=0, last_indexed_at=NULL
          WHERE model_version = ?
        `).run(LOCAL_IMAGE_SEARCH_VERSION);
      }
      this.db.prepare(`
        INSERT OR IGNORE INTO library_models(
          library_id, model_id, model_fingerprint, status, item_count, error_count,
          scan_generation, last_indexed_at
        )
        SELECT id, ?, ?, 'new', 0, 0, 0, NULL FROM libraries
      `).run(BUILTIN_MODEL_ID, BUILTIN_MODEL_FINGERPRINT);
      this.db.prepare(`
        INSERT INTO local_search_settings(key, value) VALUES ('builtin_index_profile', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `).run(BUILTIN_INDEX_PROFILE);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listModels() {
    return this.db.prepare("SELECT * FROM models ORDER BY builtin DESC, created_at DESC").all().map(rowToModel);
  }

  getModel(id) {
    return rowToModel(this.db.prepare("SELECT * FROM models WHERE id = ?").get(id));
  }

  upsertModel(manifest, { status = "ready", gpuCompatibility = { status: "unknown" } } = {}) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO models(
        id, fingerprint, name, kind, version, dimensions, builtin, certification,
        status, license, manifest_json, relative_root, total_bytes, gpu_compatibility,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        fingerprint=excluded.fingerprint,
        name=excluded.name,
        kind=excluded.kind,
        version=excluded.version,
        dimensions=excluded.dimensions,
        builtin=excluded.builtin,
        certification=excluded.certification,
        status=excluded.status,
        license=excluded.license,
        manifest_json=excluded.manifest_json,
        relative_root=excluded.relative_root,
        total_bytes=excluded.total_bytes,
        gpu_compatibility=excluded.gpu_compatibility,
        updated_at=excluded.updated_at
    `).run(
      manifest.id,
      manifest.fingerprint,
      manifest.name,
      manifest.kind,
      manifest.version || "1",
      manifest.dimensions,
      manifest.builtin ? 1 : 0,
      manifest.certification || "unverified",
      status,
      manifest.license || "未声明",
      JSON.stringify(manifest),
      manifest.relativeRoot,
      manifest.totalBytes || 0,
      JSON.stringify(gpuCompatibility),
      manifest.createdAt || now,
      now,
    );
    return this.getModel(manifest.id);
  }

  updateModelStatus(id, status, { gpuCompatibility } = {}) {
    const now = new Date().toISOString();
    if (gpuCompatibility === undefined) {
      this.db.prepare("UPDATE models SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
    } else {
      this.db.prepare("UPDATE models SET status = ?, gpu_compatibility = ?, updated_at = ? WHERE id = ?")
        .run(status, JSON.stringify(gpuCompatibility), now, id);
    }
    return this.getModel(id);
  }

  getActiveModelId() {
    const id = this.db.prepare("SELECT value FROM local_search_settings WHERE key = 'active_model_id'").get()?.value;
    return this.getModel(id) ? id : BUILTIN_MODEL_ID;
  }

  setActiveModelId(id) {
    if (!this.getModel(id)) return false;
    this.db.prepare(`
      INSERT INTO local_search_settings(key, value) VALUES ('active_model_id', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(id);
    return true;
  }

  ensureLibraryModel(libraryId, modelId) {
    const model = this.getModel(modelId);
    if (!model) return null;
    this.db.prepare(`
      INSERT OR IGNORE INTO library_models(library_id, model_id, model_fingerprint, status)
      VALUES (?, ?, ?, 'new')
    `).run(libraryId, model.id, model.fingerprint);
    return this.getLibraryModel(libraryId, modelId);
  }

  getLibraryModel(libraryId, modelId) {
    const model = this.getModel(modelId);
    if (!model) return null;
    const row = this.db.prepare(`
      SELECT * FROM library_models
      WHERE library_id = ? AND model_id = ? AND model_fingerprint = ?
    `).get(libraryId, model.id, model.fingerprint);
    return row && {
      libraryId: row.library_id,
      modelId: row.model_id,
      modelFingerprint: row.model_fingerprint,
      status: row.status,
      itemCount: Number(row.item_count || 0),
      errorCount: Number(row.error_count || 0),
      scanGeneration: Number(row.scan_generation || 0),
      executionProfile: row.execution_profile ?? null,
      lastIndexedAt: row.last_indexed_at,
    };
  }

  listLibraries(modelId = BUILTIN_MODEL_ID) {
    const model = this.getModel(modelId) || this.getModel(BUILTIN_MODEL_ID);
    return this.db.prepare(`
      SELECT l.*,
        lm.model_id AS active_model_id,
        lm.model_fingerprint AS active_model_fingerprint,
        lm.status AS active_status,
        lm.item_count AS active_item_count,
        lm.error_count AS active_error_count,
        lm.execution_profile AS active_execution_profile,
        lm.last_indexed_at AS active_last_indexed_at
      FROM libraries l
      LEFT JOIN library_models lm
        ON lm.library_id = l.id AND lm.model_id = ? AND lm.model_fingerprint = ?
      ORDER BY l.created_at DESC
    `).all(model.id, model.fingerprint).map((row) => {
      const library = rowToLibrary(row);
      if (!row.active_model_id) {
        library.modelId = model.id;
        library.modelFingerprint = model.fingerprint;
        library.status = "new";
        library.itemCount = 0;
        library.errorCount = 0;
        library.lastIndexedAt = null;
      }
      return library;
    });
  }

  createLibrary({ id, rootPath, name }) {
    this.db.prepare(`
      INSERT INTO libraries(id, root_path, name, model_version, status, created_at)
      VALUES (?, ?, ?, ?, 'new', ?)
    `).run(id, rootPath, name, LOCAL_IMAGE_SEARCH_VERSION, new Date().toISOString());
    this.ensureLibraryModel(id, this.getActiveModelId());
    return this.getLibrary(id);
  }

  getLibrary(id, { includePath = false, modelId = this.getActiveModelId() } = {}) {
    const model = this.getModel(modelId) || this.getModel(BUILTIN_MODEL_ID);
    const row = this.db.prepare(`
      SELECT l.*,
        lm.model_id AS active_model_id,
        lm.model_fingerprint AS active_model_fingerprint,
        lm.status AS active_status,
        lm.item_count AS active_item_count,
        lm.error_count AS active_error_count,
        lm.execution_profile AS active_execution_profile,
        lm.last_indexed_at AS active_last_indexed_at
      FROM libraries l
      LEFT JOIN library_models lm
        ON lm.library_id = l.id AND lm.model_id = ? AND lm.model_fingerprint = ?
      WHERE l.id = ?
    `).get(model.id, model.fingerprint, id);
    if (!row) return null;
    const result = rowToLibrary(row);
    if (!row.active_model_id) {
      result.modelId = model.id;
      result.modelFingerprint = model.fingerprint;
      result.status = "new";
      result.itemCount = 0;
      result.errorCount = 0;
      result.lastIndexedAt = null;
    }
    if (includePath) result.rootPath = row.root_path;
    return result;
  }

  getImage(libraryId, imageId) {
    return this.db.prepare(`
      SELECT id, library_id, relative_path, width, height, format
      FROM images WHERE library_id = ? AND id = ?
    `).get(libraryId, imageId) || null;
  }

  removeModelData(modelId) {
    const model = this.getModel(modelId);
    if (!model) return { removedEmbeddings: 0, removedLibraryStates: 0 };
    const activeModelId = this.db.prepare(
      "SELECT value FROM local_search_settings WHERE key = 'active_model_id'",
    ).get()?.value;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const embeddings = model.builtin
        ? this.db.prepare("DELETE FROM image_embeddings WHERE model_id = ?").run(model.id)
        : this.db.prepare(`
          DELETE FROM image_embeddings WHERE model_id = ? AND model_fingerprint = ?
        `).run(model.id, model.fingerprint);
      const libraryStates = model.builtin
        ? this.db.prepare("DELETE FROM library_models WHERE model_id = ?").run(model.id)
        : this.db.prepare(`
          DELETE FROM library_models WHERE model_id = ? AND model_fingerprint = ?
        `).run(model.id, model.fingerprint);
      if (model.builtin) {
        this.db.prepare(`
          UPDATE models
          SET status = 'missing', gpu_compatibility = '{"status":"unknown"}', updated_at = ?
          WHERE id = ?
        `).run(new Date().toISOString(), model.id);
        this.db.prepare("UPDATE images SET embedding = NULL, error_code = NULL").run();
        this.db.prepare(`
          UPDATE libraries
          SET status='new', item_count=0, error_count=0, scan_generation=0, last_indexed_at=NULL
          WHERE model_version = ?
        `).run(LOCAL_IMAGE_SEARCH_VERSION);
      } else {
        this.db.prepare("DELETE FROM models WHERE id = ?").run(model.id);
      }
      if (activeModelId === model.id) this.setActiveModelId(BUILTIN_MODEL_ID);
      this.db.exec("COMMIT");
      return {
        removedEmbeddings: Number(embeddings.changes || 0),
        removedLibraryStates: Number(libraryStates.changes || 0),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  removeLibrary(id) {
    const result = this.db.prepare("DELETE FROM libraries WHERE id = ?").run(id);
    return Number(result.changes || 0) > 0;
  }

  close() {
    this.db.close();
  }
}
