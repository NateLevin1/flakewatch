import Database from "better-sqlite3";

const db = new Database("flakewatch.db");
db.pragma("journal_mode = WAL");

export function setup() {
    db.prepare(
        "CREATE TABLE IF NOT EXISTS flakies (ulid TEXT PRIMARY KEY, projectURL TEXT NOT NULL, firstDetectCommit TEXT NOT NULL, firstDetectTime INTEGER NOT NULL, fixCommit TEXT, fixTime INTEGER, modulePath TEXT NOT NULL, qualifiedTestName TEXT NOT NULL, category TEXT)"
    ).run();
}

export function flakewatch() {
    console.log("Checking for flakies...");
}
