import { simpleGit, type LogResult, type DefaultLogFields } from "simple-git";
import fs from "fs/promises";
import { Octokit } from "@octokit/rest";
import type { FlakewatchResults, ProjectInfo } from "./shared.js";
import { parseTests, type Test } from "./parsetests.js";
import path from "path";
import { downloadCILogs } from "./cilogs.js";
import { handleModifiedTests } from "./handlemodified.js";

if (!process.argv[2]) throw new Error("Missing project info argument");
const projectInfo = JSON.parse(process.argv[2]) as ProjectInfo;

export const git = simpleGit({ baseDir: "/home/flakewatch/clone" });

export const octokit: Octokit = new Octokit({
    auth: projectInfo.githubToken,
});

flakewatch(projectInfo);

export async function flakewatch(project: ProjectInfo) {
    console.log("Started flakewatch.");
    let result: FlakewatchResults = {
        detections: [],
        ciDetections: [],
    } satisfies FlakewatchResults;

    try {
        await fs.unlink("/home/flakewatch/flakewatch-results.json");
        await fs.unlink(
            "/home/flakewatch/clone/" + project.name + "/.git/index.lock"
        );
    } catch (e) {}

    try {
        // the project should already be cloned & updated by the time this is called - see update.ts
        await git.cwd("/home/flakewatch/clone/" + project.name);

        const lastCheckedCommit = project.lastCheckedCommit;
        const log = await git.log({
            from: lastCheckedCommit ?? "HEAD~",
            to: "HEAD",
        });
        if (!log.latest) return;

        if (!lastCheckedCommit) {
            console.log(`Initializing at commit ${log.latest.hash}`);
            return;
        }

        const newCommitsExist = log.latest.hash !== lastCheckedCommit;
        if (newCommitsExist) {
            result.ciDetections = await downloadCILogs(project, log);

            const modifiedTests = await findModifiedTests(log);
            if (modifiedTests.length > 0) {
                const sha = log.latest.hash.slice(0, 7);
                handleModifiedTests(modifiedTests, sha, result, project, git);
                console.log("Finished running detectors.");
            }
        }
    } finally {
        await fs.writeFile(
            "/home/flakewatch/flakewatch-results.json",
            JSON.stringify(result)
        );

        if (project.debug?.keepContainerAlive) {
            console.log(
                "[!] [!] [!] DEBUG ENABLED: KEEPING CONTAINER ALIVE. [!] [!] [!]"
            );
            setInterval(() => {
                console.log("container heartbeat");
            }, 1000 * 60 * 60);
            setTimeout(() => {
                console.log("Killing container after time out.");
                process.exit(1);
            }, 1000 * 60 * 60 * 24);
        }
    }
}

export type ModifiedTests = {
    testName: string;
    commit: string;
    module: string;
    count: number;
}[];
export async function findModifiedTests(log: LogResult<DefaultLogFields>) {
    let modifiedTests: ModifiedTests = [];
    for (const commit of log.all) {
        try {
            const diff = await git.diff([
                commit.hash + "^",
                commit.hash,
                "--unified=0",
                "--diff-filter=AM",
            ]);
            const lines = diff.split("\n");

            let curDetails: {
                tests: Test[];
                testPrefix: string;
                module: string;
            } | null = null;
            for (const line of lines) {
                if (line.startsWith("+++")) {
                    const filepath = line.split(" ")[1]?.slice(2);
                    if (!filepath) continue;
                    const srcTestIndex = filepath.indexOf("src/test/java");
                    if (!filepath.endsWith(".java") || srcTestIndex === -1) {
                        curDetails = null;
                        continue;
                    }
                    const qualifiedTestClass = filepath
                        .slice(srcTestIndex + 14, -5)
                        .replaceAll("/", ".");
                    const filename = path.basename(filepath);
                    const file = await git.show([commit.hash + ":" + filepath]);
                    curDetails = {
                        testPrefix: qualifiedTestClass,
                        tests: parseTests(filename, file),
                        module:
                            srcTestIndex != 0
                                ? filepath.slice(0, srcTestIndex - 1)
                                : "",
                    };
                } else if (line.startsWith("@@") && curDetails != null) {
                    const match = line.match(
                        /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/
                    );
                    if (match) {
                        const start = parseInt(match[1]!) - 1;
                        const count = parseInt(match[2] ?? "1");
                        if (count == 0) continue; // FIXME: do we need to handle this case?

                        for (let i = 0; i < count; i++) {
                            const lineNum = start + i;
                            for (const test of curDetails.tests) {
                                if (
                                    lineNum < test.startLine ||
                                    lineNum > test.endLine
                                )
                                    continue;

                                const qualifiedTestName =
                                    curDetails.testPrefix + "#" + test.name;
                                if (
                                    !modifiedTests.find(
                                        (t) => t.testName === qualifiedTestName
                                    )
                                ) {
                                    modifiedTests.push({
                                        testName: qualifiedTestName,
                                        commit: commit.hash,
                                        module: curDetails.module,
                                        count: 1,
                                    });
                                } else {
                                    const existingTest = modifiedTests.find(
                                        (t) => t.testName === qualifiedTestName
                                    );
                                    if (existingTest) {
                                        existingTest.count =
                                            existingTest.count + 1;
                                    }
                                }
                                break;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error(`Failed to process commit ${commit.hash}`);
            console.error(e);
        }
    }
    return modifiedTests;
}
