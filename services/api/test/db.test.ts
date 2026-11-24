import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";

const SCHEMA = ["CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT NOT NULL);"];

describe("dataVersion", () => {
  let handles: Db[] = [];
  let dir: string | undefined;

  afterEach(() => {
    for (const db of handles) db.close();
    handles = [];
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("changes only when another connection commits to the file", () => {
    dir = mkdtempSync(join(tmpdir(), "concord-data-version-"));
    const file = join(dir, "org.db");
    const a = new Db(file, SCHEMA);
    const b = new Db(file, SCHEMA);
    handles = [a, b];

    // SQLite leaves data_version alone for the connection that made the commit.
    const beforeOwn = a.dataVersion();
    a.write("INSERT INTO t (k, v) VALUES ('a', '1')");
    expect(a.dataVersion()).toBe(beforeOwn);

    // Another connection's commit is what A polls for.
    const beforeB = a.dataVersion();
    b.write("INSERT INTO t (k, v) VALUES ('b', '2')");
    expect(a.dataVersion()).not.toBe(beforeB);

    // An uncommitted write on B is not visible to A and must not move its version.
    const beforeUncommitted = a.dataVersion();
    b.raw.exec("BEGIN");
    b.write("INSERT INTO t (k, v) VALUES ('c', '3')");
    expect(a.dataVersion()).toBe(beforeUncommitted);

    // The commit moves it, even though A made no change of its own.
    const beforeCommit = a.dataVersion();
    b.raw.exec("COMMIT");
    expect(a.dataVersion()).not.toBe(beforeCommit);
  });
});

describe("migration rollback", () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "concord-migration-"));
    path = join(directory, "test.sqlite");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("rolls back every statement and can retry with a corrected migration", () => {
    expect(() => {
      const db = new Db(path, ["CREATE TABLE a (x); CREATE TABLE b (y); INSERT INTO nope VALUES (1);"]);
      db.raw.close();
    }).toThrow(/^no such table: nope$/);

    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      expect(inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
      expect(inspection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    } finally {
      inspection.close();
    }

    const retried = new Db(path, ["CREATE TABLE ok (x);"]);
    try {
      expect(retried.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
        { name: "ok" },
      ]);
      expect(retried.raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    } finally {
      retried.raw.close();
    }
  });

  it("rejects a migration that leaves dangling foreign keys", () => {
    expect(() => {
      const db = new Db(path, [
        "CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES (1);",
      ]);
      db.raw.close();
    }).toThrow(/^migration 1 leaves dangling references$/);
  });
});

describe("Db.tx", () => {
  it("commits on success: inserts row, returns callback value, row count is 1", () => {
    const db = new Db(":memory:", ["CREATE TABLE x (a INTEGER);"]);
    try {
      const result = db.tx(() => {
        db.insert("INSERT INTO x (a) VALUES (1)");
        return "success-value";
      });
      expect(result).toBe("success-value");
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM x")?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("rolls back on throw: rethrows the original error object and row count is 0", () => {
    const db = new Db(":memory:", ["CREATE TABLE x (a INTEGER);"]);
    try {
      const originalError = new Error("custom rollback error");
      let caught: unknown;
      try {
        db.tx(() => {
          db.insert("INSERT INTO x (a) VALUES (1)");
          throw originalError;
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(originalError);
      expect((caught as Error).message).toBe("custom rollback error");
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM x")?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("refuses nested transaction: inner throws and outer insert is rolled back", () => {
    const db = new Db(":memory:", ["CREATE TABLE x (a INTEGER);"]);
    try {
      let innerError: unknown;
      let outerError: unknown;
      try {
        db.tx(() => {
          db.insert("INSERT INTO x (a) VALUES (1)");
          try {
            db.tx(() => {
              db.insert("INSERT INTO x (a) VALUES (2)");
            });
          } catch (err) {
            innerError = err;
            throw err;
          }
        });
      } catch (err) {
        outerError = err;
      }
      expect(innerError).toBeInstanceOf(Error);
      expect((innerError as Error).message).toMatch(/cannot start a transaction within a transaction/);
      expect(outerError).toBe(innerError);
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM x")?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("recovers afterwards: new transaction works and commits after nested transaction failure", () => {
    const db = new Db(":memory:", ["CREATE TABLE x (a INTEGER);"]);
    try {
      expect(() => {
        db.tx(() => {
          db.insert("INSERT INTO x (a) VALUES (1)");
          db.tx(() => {
            db.insert("INSERT INTO x (a) VALUES (2)");
          });
        });
      }).toThrow(/cannot start a transaction within a transaction/);
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM x")?.n).toBe(0);

      const recoveredResult = db.tx(() => {
        db.insert("INSERT INTO x (a) VALUES (3)");
        return "recovered-ok";
      });
      expect(recoveredResult).toBe("recovered-ok");
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM x")?.n).toBe(1);
    } finally {
      db.close();
    }
  });
});
