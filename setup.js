import { Database } from "bun:sqlite";
const db = new Database("relay.sqlite", { create: true });

export default () => {

  db.exec("PRAGMA journal_mode = WAL;");

  db.query(`CREATE TABLE IF NOT EXISTS events(
    id TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    sig TEXT NOT NULL,
    kind INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    content TEXT,
    tags TEXT
  );`).run();

  // single-letter tag index
  db.query(`CREATE TABLE IF NOT EXISTS tags_index(
    fid INTEGER NOT NULL, 
    value TEXT NOT NULL,
    FOREIGN KEY(fid) REFERENCES events(rowid) ON DELETE CASCADE
  );`).run();

  db.query(`CREATE TABLE IF NOT EXISTS requests(
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    payload TEXT NOT NULL
  );`).run();

  db.query(`CREATE INDEX IF NOT EXISTS id_idx ON events(id);`).run();
  db.query(`CREATE INDEX IF NOT EXISTS pubkey_idx ON events(pubkey);`).run();
  db.query(`CREATE INDEX IF NOT EXISTS kind_idx ON events(kind);`).run();
  db.query(`CREATE INDEX IF NOT EXISTS value_idx ON tags_index(value);`).run();

  db.query(`CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, content='', tokenize=trigram, contentless_delete=1);`).run();

  // db.query(`DROP TRIGGER events_ai`);
  db.query(`CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts (rowid, text)
      SELECT new.rowid, GROUP_CONCAT(json_extract(value, '$[1]'), ' ') as text
        FROM json_each(new.tags)
        WHERE json_extract(value, '$[0]') IN ('url', 'title', 'description', 'name', 'summary', 'alt', 't', 'os', 'arch');
    INSERT INTO tags_index (fid, value)
      SELECT new.rowid, json_extract(value, '$[0]') || ':' || json_extract(value, '$[1]')
        FROM json_each(new.tags)
        WHERE LENGTH(json_extract(value, '$[0]')) = 1;
  END;`).run();

  db.query(`CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
    DELETE FROM events_fts WHERE rowid = old.rowid;
    DELETE FROM tags_index WHERE fid = old.rowid;
  END;`).run();
};