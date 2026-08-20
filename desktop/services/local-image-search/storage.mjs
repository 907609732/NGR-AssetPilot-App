import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { LOCAL_IMAGE_SEARCH_VERSION } from "./constants.mjs";
import {
  BUILTIN_MODEL_CATALOG,
  BUILTIN_INDEX_PROFILE,
  BUILTIN_MODEL_FINGERPRINT,
  BUILTIN_MODEL_ID,
  LEGACY_BUILTIN_INDEX_PROFILE,
  LEGACY_BUILTIN_MODEL_FINGERPRINT,
  LEGACY_BUILTIN_MODEL_ID,
} from "./model-manager.mjs";

const DATABASE_VERSION = 3;
const VALID_CATALOG_STATUSES = new Set(["new", "indexing", "ready", "paused", "error"]);
const ASSET_SORTS = Object.freeze({
  "path-asc": "normalized_path COLLATE NOCASE ASC, i.id ASC",
  "modified-desc": "i.mtime_ms DESC, i.id DESC",
  "modified-asc": "i.mtime_ms ASC, i.id ASC",
  "size-desc": "i.size_bytes DESC, i.id DESC",
});

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeAssetPrefix(value, { maximumLength = 1024 } = {}) {
  if (value === undefined || value === null || value === "") return "";
  if (
    typeof value !== "string" || value.length > maximumLength || value.includes("\0")
    || value.includes("\\") || value.startsWith("/") || /^[a-z]:/i.test(value) || value.startsWith("//")
  ) {
    throw new Error("LOCAL_SEARCH_ASSET_PREFIX_INVALID");
  }
  const normalized = value.replace(/\/+$/g, "");
  if (!normalized || path.posix.isAbsolute(normalized)) throw new Error("LOCAL_SEARCH_ASSET_PREFIX_INVALID");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("LOCAL_SEARCH_ASSET_PREFIX_INVALID");
  }
  return segments.join("/");
}

function escapeLike(value) {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
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
    catalogStatus: VALID_CATALOG_STATUSES.has(row.catalog_status) ? row.catalog_status : "new",
    catalogItemCount: Number(row.catalog_item_count || 0),
    catalogRevision: Number(row.catalog_revision || 0),
    catalogLastScannedAt: row.catalog_last_scanned_at || null,
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
    const hadSchema = Boolean(this.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type='table' AND name='libraries'
    `).get());
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
        catalog_status TEXT NOT NULL DEFAULT 'new',
        catalog_item_count INTEGER NOT NULL DEFAULT 0,
        catalog_revision INTEGER NOT NULL DEFAULT 0,
        catalog_last_scanned_at TEXT,
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
    this.migrateSchema({ hadSchema });
    this.ensureBuiltinModels();
    this.migrateLegacyEmbeddings();
    this.ensureBuiltinIndexProfile();
    this.recoverInterruptedIndexes();
  }

  migrateSchema({ hadSchema }) {
    const currentVersion = Number(this.db.prepare("PRAGMA user_version").get().user_version || 0);
    if (currentVersion > DATABASE_VERSION) throw new Error("LOCAL_SEARCH_DATABASE_TOO_NEW");
    if (currentVersion === DATABASE_VERSION) return;
    if (hadSchema) {
      const requiredTables = ["libraries", "images", "models", "library_models", "image_embeddings"];
      const present = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
      if (requiredTables.some((name) => !present.has(name))) throw new Error("LOCAL_SEARCH_DATABASE_SCHEMA_INVALID");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const libraryModelColumns = this.db.prepare("PRAGMA table_info(library_models)").all();
      if (!libraryModelColumns.some((column) => column.name === "execution_profile")) {
        this.db.exec("ALTER TABLE library_models ADD COLUMN execution_profile TEXT");
      }
      const libraryColumns = this.db.prepare("PRAGMA table_info(libraries)").all();
      const additions = [
        ["catalog_status", "TEXT NOT NULL DEFAULT 'new'"],
        ["catalog_item_count", "INTEGER NOT NULL DEFAULT 0"],
        ["catalog_revision", "INTEGER NOT NULL DEFAULT 0"],
        ["catalog_last_scanned_at", "TEXT"],
      ];
      for (const [name, definition] of additions) {
        if (!libraryColumns.some((column) => column.name === name)) {
          this.db.exec(`ALTER TABLE libraries ADD COLUMN ${name} ${definition}`);
        }
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS image_embeddings_image_fk_idx ON image_embeddings(image_id);
        CREATE INDEX IF NOT EXISTS images_browse_mtime_idx ON images(library_id, mtime_ms DESC, id DESC);
        CREATE INDEX IF NOT EXISTS images_browse_size_idx ON images(library_id, size_bytes DESC, id DESC);
        UPDATE libraries
        SET catalog_item_count=(SELECT COUNT(*) FROM images WHERE images.library_id=libraries.id),
            catalog_status=CASE
              WHEN status='indexing' THEN 'paused'
              WHEN status IN ('ready','paused','error') THEN status
              WHEN EXISTS(SELECT 1 FROM images WHERE images.library_id=libraries.id) THEN 'ready'
              ELSE 'new'
            END,
            catalog_revision=CASE
              WHEN catalog_revision < 1 AND EXISTS(SELECT 1 FROM images WHERE images.library_id=libraries.id) THEN 1
              ELSE catalog_revision
            END,
            catalog_last_scanned_at=COALESCE(catalog_last_scanned_at,last_indexed_at);
        CREATE TABLE IF NOT EXISTS index_staging_jobs (
          job_id TEXT PRIMARY KEY,
          library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
          model_id TEXT NOT NULL,
          model_fingerprint TEXT NOT NULL,
          dimensions INTEGER NOT NULL CHECK(dimensions > 0),
          base_catalog_revision INTEGER NOT NULL,
          base_file_generation INTEGER NOT NULL,
          target_file_generation INTEGER NOT NULL,
          base_model_generation INTEGER NOT NULL,
          target_model_generation INTEGER NOT NULL,
          execution_profile TEXT NOT NULL,
          profile_rebuilt INTEGER NOT NULL CHECK(profile_rebuilt IN (0, 1)),
          created_at TEXT NOT NULL,
          UNIQUE(library_id, model_id, model_fingerprint)
        );
        CREATE TABLE IF NOT EXISTS index_staging_images (
          job_id TEXT NOT NULL REFERENCES index_staging_jobs(job_id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL,
          mtime_ms REAL NOT NULL,
          size_bytes INTEGER NOT NULL,
          sha256 TEXT,
          format TEXT,
          width INTEGER,
          height INTEGER,
          error_code TEXT,
          file_changed INTEGER NOT NULL CHECK(file_changed IN (0, 1)),
          embedding_changed INTEGER NOT NULL CHECK(embedding_changed IN (0, 1)),
          embedding BLOB,
          PRIMARY KEY(job_id, relative_path)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS index_staging_images_sha_idx
          ON index_staging_images(job_id, sha256);
        PRAGMA user_version = 3;
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ensureBuiltinModels() {
    const now = new Date().toISOString();
    const statement = this.db.prepare(`
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
    `);
    for (const entry of BUILTIN_MODEL_CATALOG) {
      const manifest = entry.createManifest();
      statement.run(
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
    }
    const hasLegacyVectors = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM images WHERE embedding IS NOT NULL
    `).get().count || 0) > 0 || Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM image_embeddings WHERE model_id=?
    `).get(LEGACY_BUILTIN_MODEL_ID).count || 0) > 0;
    this.db.prepare(`
      INSERT INTO local_search_settings(key, value) VALUES ('active_model_id', ?)
      ON CONFLICT(key) DO NOTHING
    `).run(hasLegacyVectors ? LEGACY_BUILTIN_MODEL_ID : BUILTIN_MODEL_ID);
  }

  migrateLegacyEmbeddings() {
    const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM images WHERE embedding IS NOT NULL").get().count || 0);
    if (!count) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO library_models(
          library_id, model_id, model_fingerprint, status, item_count, error_count,
          scan_generation, execution_profile, last_indexed_at
        )
        SELECT id, ?, ?,
          CASE WHEN status='indexing' THEN 'paused' ELSE status END,
          item_count, error_count, scan_generation, ?, last_indexed_at
        FROM libraries
      `).run(
        LEGACY_BUILTIN_MODEL_ID,
        LEGACY_BUILTIN_MODEL_FINGERPRINT,
        LEGACY_BUILTIN_INDEX_PROFILE,
      );
      this.db.prepare(`
        INSERT OR IGNORE INTO image_embeddings(
          library_id, image_id, model_id, model_fingerprint, dimensions,
          embedding, scan_generation, error_code
        )
        SELECT library_id, id, ?, ?, 512, embedding, scan_generation, error_code
        FROM images WHERE embedding IS NOT NULL
      `).run(LEGACY_BUILTIN_MODEL_ID, LEGACY_BUILTIN_MODEL_FINGERPRINT);
      this.db.prepare("UPDATE images SET embedding=NULL").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recoverInterruptedIndexes() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Staging rows are always disposable. They contain only a not-yet-published job
      // snapshot and never authorize touching the source library or committed index.
      this.db.exec(`
        DELETE FROM index_staging_jobs;
        UPDATE libraries
        SET status='paused', catalog_status='paused'
        WHERE status='indexing' OR catalog_status='indexing';
        UPDATE library_models SET status='paused' WHERE status='indexing';
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ensureBuiltinIndexProfile() {
    const storedProfile = this.db.prepare(
      "SELECT value FROM local_search_settings WHERE key = 'builtin_index_profile'",
    ).get()?.value;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (storedProfile !== BUILTIN_INDEX_PROFILE) {
        // A profile upgrade invalidates search compatibility, but it must not destroy the
        // last committed vectors before a replacement index has been published atomically.
        this.db.prepare(`
          UPDATE library_models SET status='stale'
          WHERE model_id=? AND status IN ('ready','paused','error','indexing')
        `).run(BUILTIN_MODEL_ID);
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
      SELECT id, library_id, relative_path, width, height, format, sha256, mtime_ms, size_bytes
      FROM images WHERE library_id = ? AND id = ?
    `).get(libraryId, imageId) || null;
  }

  markIndexPaused(libraryId, modelId, jobId = null) {
    const model = this.getModel(modelId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE libraries SET status='paused', catalog_status='paused' WHERE id=?
      `).run(libraryId);
      if (model) {
        if (jobId) {
          this.db.prepare(`
            DELETE FROM index_staging_jobs
            WHERE job_id=? AND library_id=? AND model_id=? AND model_fingerprint=?
          `).run(jobId, libraryId, model.id, model.fingerprint);
        } else {
          this.db.prepare(`
            DELETE FROM index_staging_jobs
            WHERE library_id=? AND model_id=? AND model_fingerprint=?
          `).run(libraryId, model.id, model.fingerprint);
        }
        this.db.prepare(`
          UPDATE library_models SET status='paused'
          WHERE library_id=? AND model_id=? AND model_fingerprint=?
        `).run(libraryId, model.id, model.fingerprint);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listAssetFolders({ libraryId, parentPrefix = "" }) {
    const library = this.getLibrary(libraryId);
    if (!library) throw new Error("LOCAL_SEARCH_LIBRARY_NOT_FOUND");
    const canonicalParent = normalizeAssetPrefix(parentPrefix);
    const prefix = canonicalParent ? `${canonicalParent}/` : "";
    const rows = this.db.prepare(`
      WITH normalized AS (
        SELECT replace(relative_path, char(92), '/') AS normalized_path
        FROM images
        WHERE library_id=?
      ), descendants AS (
        SELECT substr(normalized_path, length(?) + 1) AS rest
        FROM normalized
        WHERE normalized_path LIKE ? ESCAPE '!'
      )
      SELECT substr(rest, 1, instr(rest, '/') - 1) AS name, COUNT(*) AS item_count
      FROM descendants
      WHERE instr(rest, '/') > 0
      GROUP BY name COLLATE NOCASE
      ORDER BY name COLLATE NOCASE ASC
    `).all(libraryId, prefix, `${escapeLike(prefix)}%`);
    return {
      libraryId,
      catalogRevision: library.catalogRevision,
      parentPrefix: canonicalParent,
      folders: rows.map((row) => ({
        name: row.name,
        prefix: canonicalParent ? `${canonicalParent}/${row.name}` : row.name,
        itemCount: Number(row.item_count || 0),
      })),
    };
  }

  listAssets({ libraryId, page = 1, pageSize = 100, folderPrefix = "", filter = "", sort = "path-asc" }) {
    const library = this.getLibrary(libraryId);
    if (!library) throw new Error("LOCAL_SEARCH_LIBRARY_NOT_FOUND");
    const canonicalFolder = normalizeAssetPrefix(folderPrefix);
    if (!Number.isInteger(pageSize) || pageSize !== 100) throw new Error("LOCAL_SEARCH_ASSET_PAGE_SIZE_INVALID");
    const requestedPage = Number(page);
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1) throw new Error("LOCAL_SEARCH_ASSET_PAGE_INVALID");
    if (typeof filter !== "string" || filter.length > 100 || filter.includes("\0")) {
      throw new Error("LOCAL_SEARCH_ASSET_FILTER_INVALID");
    }
    const orderBy = ASSET_SORTS[sort];
    if (!orderBy) throw new Error("LOCAL_SEARCH_ASSET_SORT_INVALID");
    const folderPattern = canonicalFolder ? `${escapeLike(canonicalFolder)}/%` : "%";
    const filterPattern = `%${escapeLike(filter.trim())}%`;
    const where = `
      i.library_id=?
      AND replace(i.relative_path, char(92), '/') LIKE ? ESCAPE '!'
      AND replace(i.relative_path, char(92), '/') LIKE ? ESCAPE '!'
    `;
    const totalItems = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM images i WHERE ${where}`)
      .get(libraryId, folderPattern, filterPattern).count || 0);
    const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
    const currentPage = Math.min(requestedPage, pageCount);
    const rows = this.db.prepare(`
      SELECT i.id, replace(i.relative_path, char(92), '/') AS normalized_path,
        i.width, i.height, i.format, i.size_bytes, i.mtime_ms,
        COALESCE(i.error_code, (
          SELECT e.error_code FROM image_embeddings e
          WHERE e.library_id=i.library_id AND e.image_id=i.id AND e.error_code IS NOT NULL
          LIMIT 1
        )) AS browse_error_code
      FROM images i
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(libraryId, folderPattern, filterPattern, pageSize, (currentPage - 1) * pageSize);
    return {
      libraryId,
      catalogRevision: library.catalogRevision,
      page: currentPage,
      pageSize,
      pageCount,
      totalItems,
      items: rows.map((row) => {
        const relativePath = row.normalized_path;
        const directory = path.posix.dirname(relativePath);
        return {
          imageId: Number(row.id),
          fileName: path.posix.basename(relativePath),
          relativePath,
          directory: directory === "." ? "" : directory,
          width: row.width == null ? null : Number(row.width),
          height: row.height == null ? null : Number(row.height),
          format: row.format || null,
          sizeBytes: Number(row.size_bytes || 0),
          modifiedAt: Number(row.mtime_ms || 0),
          errorCode: row.browse_error_code || null,
        };
      }),
    };
  }

  removeModelData(modelId) {
    const model = this.getModel(modelId);
    if (!model) return { removedEmbeddings: 0, removedLibraryStates: 0 };
    const activeModelId = this.db.prepare(
      "SELECT value FROM local_search_settings WHERE key = 'active_model_id'",
    ).get()?.value;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM index_staging_jobs WHERE model_id = ?").run(model.id);
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
