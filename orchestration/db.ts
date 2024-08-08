import Database from "better-sqlite3";
import { ulid } from "ulid";

export type Flaky = {
    ulid: string;
    projectURL: string;
    runSha: string;
    lastEditSha: string;
    detectTime: number;
    modulePath: string;
    qualifiedTestName: string;
    category?: string;
};

let db: Database.Database | undefined = undefined;

export function setupDB() {
    db = new Database("flakewatch.db");
    db.pragma("journal_mode = WAL");
    db.prepare(
        "CREATE TABLE IF NOT EXISTS flakies (ulid TEXT PRIMARY KEY, projectURL TEXT NOT NULL, runSha TEXT NOT NULL, lastEditSha TEXT NOT NULL, detectTime INTEGER NOT NULL, modulePath TEXT NOT NULL, qualifiedTestName TEXT NOT NULL, category TEXT)"
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
        "id,projectURL,runSha,lastEditSha,detectTime,modulePath,qualifiedTestName,category\n" +
        fn()
            .map(
                (flaky) =>
                    `${flaky.ulid},${flaky.projectURL},${flaky.runSha},${flaky.lastEditSha},${flaky.detectTime},${flaky.modulePath},${flaky.qualifiedTestName},${flaky.category}`
            )
            .join("\n")
    );
}

export function getAllFlakies() {
    if (!db) return [];
    return db
        .prepare(
            "SELECT * FROM flakies ORDER BY projectURL ASC, qualifiedTestName ASC, detectTime DESC"
        )
        .all() as Flaky[];
}

export function insertFlaky({
    projectURL,
    runSha,
    lastEditSha,
    detectTime,
    modulePath,
    qualifiedTestName,
    category,
}: {
    projectURL: string;
    runSha: string;
    lastEditSha: string;
    detectTime: number;
    modulePath: string;
    qualifiedTestName: string;
    category: string;
}) {
    if (!db) return;
    db.prepare(
        "INSERT INTO flakies (ulid, projectURL, runSha, lastEditSha, detectTime, modulePath, qualifiedTestName, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
        ulid(),
        projectURL,
        runSha,
        lastEditSha,
        detectTime,
        modulePath,
        qualifiedTestName,
        category
    );
}

export function getFlaky(qualifiedTestName: string) {
    if (!db) return;
    return db
        .prepare(
            "SELECT * FROM flakies WHERE qualifiedTestName = ? ORDER BY detectTime DESC LIMIT 1"
        )
        .get(qualifiedTestName) as Flaky | undefined;
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
