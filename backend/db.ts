import Database from "better-sqlite3";
import { ulid } from "ulid";
import { Flaky } from "./flakewatch";

const db = new Database("flakewatch.db");
db.pragma("journal_mode = WAL");

export function setup() {
    db.prepare(
        "CREATE TABLE IF NOT EXISTS flakies (ulid TEXT PRIMARY KEY, projectURL TEXT NOT NULL, firstDetectCommit TEXT NOT NULL, firstDetectTime INTEGER NOT NULL, fixCommit TEXT, fixTime INTEGER, modulePath TEXT NOT NULL, qualifiedTestName TEXT NOT NULL, category TEXT)"
    ).run();
}

export function getActiveFlakies() {
    return db
        .prepare("SELECT * FROM flakies WHERE fixCommit IS NULL")
        .all() as Flaky[];
}

export function insertFlaky({
    projectURL,
    firstDetectCommit,
    firstDetectTime,
    modulePath,
    qualifiedTestName,
    category,
}: {
    projectURL: string;
    firstDetectCommit: string;
    firstDetectTime: number;
    modulePath: string;
    qualifiedTestName: string;
    category: string;
}) {
    db.prepare(
        "INSERT INTO flakies (ulid, projectURL, firstDetectCommit, firstDetectTime, modulePath, qualifiedTestName, category) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
        ulid(),
        projectURL,
        firstDetectCommit,
        firstDetectTime,
        modulePath,
        qualifiedTestName,
        category
    );
}

export function markFlakyFixed(
    fixCommit: string,
    fixTime: number,
    qualifiedTestName: string
) {
    db.prepare(
        "UPDATE flakies SET fixCommit = ?, fixTime = ? WHERE ulid in (SELECT ulid FROM flakies WHERE qualifiedTestName = ? ORDER BY firstDetectTime DESC LIMIT 1);"
    ).run(fixCommit, fixTime, qualifiedTestName);
}

export function deleteFlaky(ulid: string) {
    db.prepare("DELETE FROM flakies WHERE ulid = ?").run(ulid);
}
