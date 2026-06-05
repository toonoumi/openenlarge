//! Durable SQLite catalog: image references, per-image edits, prefs, session state.

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

/// One catalog image as sent to the frontend. `offline` is computed at load time.
/// `developed` and `has_ir` are set to false here; `load_catalog` in commands.rs
/// overrides them from cache-file presence.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogImage {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub metadata: Value,
    pub thumbnail: String,
    pub offline: bool,
    pub developed: bool,
    pub has_ir: bool,
}

/// One image's stored edits. Stored as opaque JSON blobs; deserialized to `Value`
/// on load so the frontend receives structured data without a per-field schema.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogEdits {
    pub image_id: String,
    pub params: Option<Value>,
    pub crop: Option<Value>,
    pub dust: Option<Value>,
    pub meta: Option<Value>,
}

/// The full catalog handed to the frontend on launch.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogSnapshot {
    pub images: Vec<CatalogImage>,
    pub edits: Vec<CatalogEdits>,
    pub prefs: HashMap<String, String>,
    pub app_state: HashMap<String, String>,
}

/// The on-disk catalog. Wraps a single SQLite connection behind a Mutex
/// (rusqlite Connection is not Sync).
pub struct Catalog {
    conn: Mutex<Connection>,
}

const SCHEMA_VERSION: i64 = 2;

impl Catalog {
    /// Open (creating if absent) the catalog at `db_path`. Enables WAL and migrates.
    pub fn open(db_path: &std::path::Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(db_path)?;
        Self::init(conn)
    }

    /// In-memory catalog for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        migrate(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Insert a new image or update the existing row with the same `path`.
    /// Returns the stable id (a new UUID for new paths, the existing id otherwise),
    /// so re-importing a file preserves its id — and therefore its edits.
    pub fn upsert_image(
        &self,
        path: &str,
        file_name: &str,
        metadata_json: &str,
        thumbnail: &str,
        now: i64,
    ) -> rusqlite::Result<String> {
        let conn = self.conn.lock().unwrap();
        let existing: Option<String> = conn
            .query_row("SELECT id FROM images WHERE path = ?1", [path], |r| r.get(0))
            .ok();
        if let Some(id) = existing {
            conn.execute(
                "UPDATE images SET file_name = ?2, metadata = ?3, thumbnail = ?4 WHERE id = ?1",
                rusqlite::params![id, file_name, metadata_json, thumbnail],
            )?;
            Ok(id)
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO images (id, path, file_name, metadata, thumbnail, added_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![id, path, file_name, metadata_json, thumbnail, now],
            )?;
            Ok(id)
        }
    }

    /// Update an image's thumbnail + metadata (called after develop).
    pub fn update_image_render(
        &self,
        id: &str,
        thumbnail: &str,
        metadata_json: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE images SET thumbnail = ?2, metadata = ?3 WHERE id = ?1",
            rusqlite::params![id, thumbnail, metadata_json],
        )?;
        Ok(())
    }

    /// Remove an image and its edits (atomically).
    pub fn delete_image(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM edits WHERE image_id = ?1", [id])?;
        tx.execute("DELETE FROM images WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    /// Load all images, ordered by import time. `exists` decides the offline flag
    /// (injected so tests don't touch the filesystem).
    pub fn load_images(
        &self,
        exists: &dyn Fn(&str) -> bool,
    ) -> rusqlite::Result<Vec<CatalogImage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, path, file_name, metadata, thumbnail FROM images ORDER BY added_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            let path: String = r.get(1)?;
            let metadata: String = r.get(3)?;
            Ok(CatalogImage {
                id: r.get(0)?,
                offline: !exists(&path),
                path,
                file_name: r.get(2)?,
                metadata: serde_json::from_str(&metadata).unwrap_or(Value::Null),
                thumbnail: r.get(4)?,
                developed: false,
                has_ir: false,
            })
        })?;
        rows.collect()
    }

    /// Upsert the params JSON for an image's edits row.
    pub fn save_params(&self, image_id: &str, params_json: &str) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO edits (image_id, params_json) VALUES (?1, ?2)
             ON CONFLICT(image_id) DO UPDATE SET params_json = excluded.params_json",
            rusqlite::params![image_id, params_json],
        )?;
        Ok(())
    }

    /// Upsert the crop JSON for an image's edits row.
    pub fn save_crop(&self, image_id: &str, crop_json: &str) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO edits (image_id, crop_json) VALUES (?1, ?2)
             ON CONFLICT(image_id) DO UPDATE SET crop_json = excluded.crop_json",
            rusqlite::params![image_id, crop_json],
        )?;
        Ok(())
    }

    /// Upsert the dust JSON for an image's edits row.
    pub fn save_dust(&self, image_id: &str, dust_json: &str) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO edits (image_id, dust_json) VALUES (?1, ?2)
             ON CONFLICT(image_id) DO UPDATE SET dust_json = excluded.dust_json",
            rusqlite::params![image_id, dust_json],
        )?;
        Ok(())
    }

    /// Upsert the metadata-override JSON for an image's edits row.
    pub fn save_meta(&self, image_id: &str, meta_json: &str) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO edits (image_id, meta_json) VALUES (?1, ?2)
             ON CONFLICT(image_id) DO UPDATE SET meta_json = excluded.meta_json",
            rusqlite::params![image_id, meta_json],
        )?;
        Ok(())
    }

    /// Load every image's edits row.
    pub fn load_edits(&self) -> rusqlite::Result<Vec<CatalogEdits>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT image_id, params_json, crop_json, dust_json, meta_json FROM edits")?;
        let parse = |s: Option<String>| s.and_then(|t| serde_json::from_str(&t).ok());
        let rows = stmt.query_map([], |r| {
            Ok(CatalogEdits {
                image_id: r.get(0)?,
                params: parse(r.get(1)?),
                crop: parse(r.get(2)?),
                dust: parse(r.get(3)?),
                meta: parse(r.get(4)?),
            })
        })?;
        rows.collect()
    }

    /// Upsert a preference (e.g. develop_mode, quality).
    pub fn save_pref(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO prefs (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )?;
        Ok(())
    }

    /// Upsert a session/UI state value (selected_folder, active_id, grid_zoom, module).
    pub fn save_app_state(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO app_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )?;
        Ok(())
    }

    // `table` must be one of the two hardcoded names; never call with user input.
    fn load_kv(&self, table: &str) -> rusqlite::Result<HashMap<String, String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("SELECT key, value FROM {table}"))?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect()
    }

    pub fn load_prefs(&self) -> rusqlite::Result<HashMap<String, String>> {
        self.load_kv("prefs")
    }

    pub fn load_app_state(&self) -> rusqlite::Result<HashMap<String, String>> {
        self.load_kv("app_state")
    }

    /// Aggregate everything for launch. `exists` decides each image's offline flag.
    pub fn snapshot(&self, exists: &dyn Fn(&str) -> bool) -> rusqlite::Result<CatalogSnapshot> {
        Ok(CatalogSnapshot {
            images: self.load_images(exists)?,
            edits: self.load_edits()?,
            prefs: self.load_prefs()?,
            app_state: self.load_app_state()?,
        })
    }

    /// Current schema version (for tests).
    #[cfg(test)]
    pub fn user_version(&self) -> i64 {
        self.conn
            .lock()
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap()
    }
}

/// Apply versioned migrations. Idempotent: only runs steps above the current
/// `user_version`. v1 creates the four base tables.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE images (
                id        TEXT PRIMARY KEY,
                path      TEXT UNIQUE NOT NULL,
                file_name TEXT NOT NULL,
                metadata  TEXT NOT NULL,
                thumbnail TEXT NOT NULL,
                added_at  INTEGER NOT NULL
             );
             CREATE TABLE edits (
                image_id    TEXT PRIMARY KEY,
                params_json TEXT,
                crop_json   TEXT,
                dust_json   TEXT
             );
             CREATE TABLE prefs (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
             );
             CREATE TABLE app_state (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
             );
             COMMIT;",
        )?;
    }
    if version < 2 {
        // Per-image editable metadata overrides (camera/lens/iso/shutter/aperture/
        // date/note), stored as one opaque JSON blob alongside the other edits.
        conn.execute_batch("ALTER TABLE edits ADD COLUMN meta_json TEXT;")?;
    }
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_creates_schema_at_current_version() {
        let cat = Catalog::open_in_memory().unwrap();
        assert_eq!(cat.user_version(), SCHEMA_VERSION);
    }

    #[test]
    fn migrate_is_idempotent_on_reopen() {
        let dir = std::env::temp_dir().join(format!("oe-cat-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("catalog.db");
        let _ = std::fs::remove_file(&db);
        {
            let cat = Catalog::open(&db).unwrap();
            assert_eq!(cat.user_version(), SCHEMA_VERSION);
        }
        // Reopen: should not error and stay at the current version.
        let cat = Catalog::open(&db).unwrap();
        assert_eq!(cat.user_version(), SCHEMA_VERSION);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn meta_override_round_trips() {
        let cat = Catalog::open_in_memory().unwrap();
        cat.save_params("img-1", r#"{"exposure":1.0}"#).unwrap();
        cat.save_meta("img-1", r#"{"camera":"Leica M6","note":"roll 12"}"#).unwrap();
        let edits = cat.load_edits().unwrap();
        assert_eq!(edits.len(), 1);
        let m = edits[0].meta.as_ref().unwrap();
        assert_eq!(m["camera"], "Leica M6");
        assert_eq!(m["note"], "roll 12");
        // Co-stored families are untouched by a meta save.
        assert_eq!(edits[0].params.as_ref().unwrap()["exposure"], 1.0);
    }

    #[test]
    fn upsert_dedupes_by_path_and_keeps_id() {
        let cat = Catalog::open_in_memory().unwrap();
        let id1 = cat.upsert_image("/x/a.dng", "a.dng", "{}", "thumb1", 100).unwrap();
        // Re-import the same path with a new thumbnail → same id, updated row.
        let id2 = cat.upsert_image("/x/a.dng", "a.dng", "{}", "thumb2", 200).unwrap();
        assert_eq!(id1, id2);
        let imgs = cat.load_images(&|_| true).unwrap();
        assert_eq!(imgs.len(), 1);
        assert_eq!(imgs[0].thumbnail, "thumb2");
    }

    #[test]
    fn load_images_sets_offline_when_missing() {
        let cat = Catalog::open_in_memory().unwrap();
        cat.upsert_image("/x/here.dng", "here.dng", "{}", "t", 1).unwrap();
        cat.upsert_image("/x/gone.dng", "gone.dng", "{}", "t", 2).unwrap();
        let imgs = cat.load_images(&|p| p == "/x/here.dng").unwrap();
        assert_eq!(imgs.len(), 2);
        assert!(!imgs[0].offline); // here.dng exists
        assert!(imgs[1].offline);  // gone.dng missing
    }

    #[test]
    fn delete_image_removes_row() {
        let cat = Catalog::open_in_memory().unwrap();
        let id = cat.upsert_image("/x/a.dng", "a.dng", "{}", "t", 1).unwrap();
        cat.save_params(&id, r#"{"exposure":1.0}"#).unwrap();
        cat.delete_image(&id).unwrap();
        assert!(cat.load_images(&|_| true).unwrap().is_empty());
        assert!(cat.load_edits().unwrap().is_empty());
    }

    #[test]
    fn edits_round_trip_each_family_independently() {
        let cat = Catalog::open_in_memory().unwrap();
        cat.save_params("img-1", r#"{"exposure":1.5}"#).unwrap();
        cat.save_crop("img-1", r#"{"angle":2.0}"#).unwrap();
        cat.save_dust("img-1", r#"{"strokes":[]}"#).unwrap();
        let edits = cat.load_edits().unwrap();
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].image_id, "img-1");
        assert_eq!(edits[0].params.as_ref().unwrap()["exposure"], 1.5);
        assert_eq!(edits[0].crop.as_ref().unwrap()["angle"], 2.0);
        assert!(edits[0].dust.is_some());
    }

    #[test]
    fn save_params_twice_updates_in_place() {
        let cat = Catalog::open_in_memory().unwrap();
        cat.save_params("img-1", r#"{"exposure":0.0}"#).unwrap();
        cat.save_params("img-1", r#"{"exposure":2.0}"#).unwrap();
        let edits = cat.load_edits().unwrap();
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].params.as_ref().unwrap()["exposure"], 2.0);
    }

    #[test]
    fn prefs_round_trip_and_overwrite() {
        let cat = Catalog::open_in_memory().unwrap();
        cat.save_pref("develop_mode", "c").unwrap();
        cat.save_pref("quality", "performance").unwrap();
        cat.save_pref("develop_mode", "b").unwrap(); // overwrite
        let prefs = cat.load_prefs().unwrap();
        assert_eq!(prefs.get("develop_mode").map(String::as_str), Some("b"));
        assert_eq!(prefs.get("quality").map(String::as_str), Some("performance"));
    }

    #[test]
    fn app_state_round_trip() {
        let cat = Catalog::open_in_memory().unwrap();
        cat.save_app_state("grid_zoom", "55").unwrap();
        cat.save_app_state("module", "develop").unwrap();
        let st = cat.load_app_state().unwrap();
        assert_eq!(st.get("grid_zoom").map(String::as_str), Some("55"));
        assert_eq!(st.get("module").map(String::as_str), Some("develop"));
    }

    #[test]
    fn snapshot_aggregates_everything() {
        let cat = Catalog::open_in_memory().unwrap();
        let id = cat.upsert_image("/x/a.dng", "a.dng", r#"{"width":100}"#, "t", 1).unwrap();
        cat.save_params(&id, r#"{"exposure":1.0}"#).unwrap();
        cat.save_pref("develop_mode", "c").unwrap();
        cat.save_app_state("module", "library").unwrap();
        let snap = cat.snapshot(&|_| true).unwrap();
        assert_eq!(snap.images.len(), 1);
        assert_eq!(snap.edits.len(), 1);
        assert_eq!(snap.edits[0].image_id, id);
        assert_eq!(snap.prefs.get("develop_mode").map(String::as_str), Some("c"));
        assert_eq!(snap.app_state.get("module").map(String::as_str), Some("library"));
    }
}
