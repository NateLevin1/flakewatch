import Database from "better-sqlite3";
import { ulid } from "ulid";

export type Flaky = {
    ulid: string;
    projectURL: string;
    firstDetectCommit: string;
    firstDetectTime: number;
    fixCommit?: string;
    fixTime?: number;
    modulePath: string;
    qualifiedTestName: string;
    category?: string;
};

let db: Database.Database | undefined = undefined;

export function setup() {
    db = new Database("flakewatch.db");
    db.pragma("journal_mode = WAL");
    db.prepare(
        "CREATE TABLE IF NOT EXISTS flakies (ulid TEXT PRIMARY KEY, projectURL TEXT NOT NULL, firstDetectCommit TEXT NOT NULL, firstDetectTime INTEGER NOT NULL, fixCommit TEXT, fixTime INTEGER, modulePath TEXT NOT NULL, qualifiedTestName TEXT NOT NULL, category TEXT)"
    ).run();
    db.prepare(
        "CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, lastCheckedCommit TEXT)"
    ).run();

    process.on("exit", () => db && db.close());
    process.on("SIGHUP", () => process.exit(128 + 1));
    process.on("SIGINT", () => process.exit(128 + 2));
    process.on("SIGTERM", () => process.exit(128 + 15));
}

export function toCsv(fn: () => Flaky[]) {
    return (
        "id,projectURL,firstDetectCommit,firstDetectTime,fixCommit,fixTime,modulePath,qualifiedTestName,category\n" +
        fn()
            .map(
                (flaky) =>
                    `${flaky.ulid},${flaky.projectURL},${flaky.firstDetectCommit},${flaky.firstDetectTime},${flaky.fixCommit},${flaky.fixTime},${flaky.modulePath},${flaky.qualifiedTestName},${flaky.category}`
            )
            .join("\n")
    );
}

export function getActiveFlakies() {
    if (!db) return [];
    return db
        .prepare(
            "SELECT * FROM flakies WHERE fixCommit IS NULL ORDER BY projectURL ASC"
        )
        .all() as Flaky[];
}

export function getAllFlakies() {
    if (!db) return [];
    return db
        .prepare("SELECT * FROM flakies ORDER BY projectURL ASC")
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
    if (!db) return;
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

export function getFlaky(qualifiedTestName: string) {
    if (!db) return;
    return db
        .prepare(
            "SELECT * FROM flakies WHERE qualifiedTestName = ? ORDER BY firstDetectTime DESC LIMIT 1"
        )
        .get(qualifiedTestName) as Flaky | undefined;
}

export function markFlakyFixed(
    fixCommit: string,
    fixTime: number,
    qualifiedTestName: string
) {
    if (!db) return;
    db.prepare(
        "UPDATE flakies SET fixCommit = ?, fixTime = ? WHERE ulid in (SELECT ulid FROM flakies WHERE qualifiedTestName = ? ORDER BY firstDetectTime DESC LIMIT 1);"
    ).run(fixCommit, fixTime, qualifiedTestName);
}

export function updateFlakyCategory(
    ulid: string,
    oldCategory: string,
    category: string
) {
    if (!db) return;
    // merge categories
    const newCategory = oldCategory
        .split("&")
        .concat(category.split("&"))
        // remove duplicates
        .filter((s) => s.length > 0)
        .filter((value, index, self) => self.indexOf(value) === index)
        .join("&");
    db.prepare("UPDATE flakies SET category = ? WHERE ulid = ?").run(
        newCategory,
        ulid
    );
}

export function deleteFlaky(ulid: string) {
    if (!db) return;
    db.prepare("DELETE FROM flakies WHERE ulid = ?").run(ulid);
}

export function getProjectLastCheckedCommit(projectName: string) {
    if (!db) return;
    return (
        db
            .prepare("SELECT lastCheckedCommit FROM projects WHERE name = ?")
            .get(projectName) as { lastCheckedCommit: string } | undefined
    )?.lastCheckedCommit;
}

export function setProjectLastCheckedCommit(
    projectName: string,
    commit: string
) {
    if (!db) return;
    db.prepare(
        "REPLACE INTO projects (name, lastCheckedCommit) VALUES (?, ?)"
    ).run(projectName, commit);
}
