import { DatabaseSync } from 'node:sqlite';

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS jobs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,
      customer        TEXT NOT NULL DEFAULT '',
      notes           TEXT NOT NULL DEFAULT '',
      pdf_file        TEXT NOT NULL,
      pdf_name        TEXT NOT NULL,
      approval_status TEXT NOT NULL CHECK (approval_status IN ('approved', 'preapproved')),
      stage           TEXT NOT NULL DEFAULT 'receiving',
      qty_required    INTEGER NOT NULL DEFAULT 0,
      qty_available   INTEGER NOT NULL DEFAULT 0,
      qty_received    INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS job_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      stage      TEXT NOT NULL,
      message    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Paper Cutting was removed from the flow; jobs already there continue at Paper Printing.
    UPDATE jobs SET stage = 'printing' WHERE stage = 'cutting';
  `);
  return db;
}
