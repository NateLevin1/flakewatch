import { runDetectors, exec } from "./detectors.js";
import {
    simpleGit,
    CleanOptions,
    type LogResult,
    type DefaultLogFields,
} from "simple-git";
import fs from "fs/promises";
import { Octokit } from "@octokit/rest";
import type {
    DetectionCause,
    FlakewatchResults,
    ProjectInfo,
} from "./shared.js";

if (!process.argv[2]) throw new Error("Missing project info argument");
const projectInfo = JSON.parse(process.argv[2]) as ProjectInfo;

export const git = simpleGit({ baseDir: "/home/flakewatch/clone" });

export const octokit: Octokit = new Octokit({
    auth: projectInfo.githubToken,
});

flakewatch(projectInfo);

export async function flakewatch(project: ProjectInfo) {
    let result = {} as FlakewatchResults;
    try {
        // * Update the project to the latest commit
        try {
            await git.clone(project.gitURL, project.name);
            await git.cwd("/home/flakewatch/clone/" + project.name);
        } catch (e) {
            await git.cwd("/home/flakewatch/clone/" + project.name);
            // clone fails if non-empty, so pull instead if it's already cloned
            await git.reset(["--hard"]);
            await git.checkout(project.branch);
            await git.reset(["--hard"]);
            await git.pull();
        }

        const lastCheckedCommit = project.lastCheckedCommit;
        const log = await git.log({
            from: lastCheckedCommit ?? "HEAD~",
            to: "HEAD",
        });
        if (!log.latest) return;

        if (!lastCheckedCommit) {
            result.newLastCheckedCommit = log.latest.hash;
            console.log(
                `${project.name}: Initializing at commit ${log.latest.hash}`
            );
            return;
        }

        const newCommitsExist = log.latest.hash !== lastCheckedCommit;
        if (newCommitsExist) {
            result.newLastCheckedCommit = log.latest.hash;
            console.log(
                `${project.name}: ${log.all.length} new commit(s) found`
            );

            const ciLogsPromise = downloadCILogs(project, log, result);

            const modifiedTests = await findModifiedTests(log);
            if (modifiedTests.length > 0) {
                const sha = log.latest.hash.slice(0, 7);
                console.log(
                    `${project.name}: ${
                        modifiedTests.length
                    } tests modified up to commit ${sha}: ${modifiedTests
                        .map((s) => s.testName.split(".").at(-1))
                        .join(", ")}`
                );

                // * Run flakiness detectors
                for (const { testName, commit, module } of modifiedTests) {
                    await git.reset(["--hard"]);
                    await git.checkout(commit);
                    let detections: DetectionCause[] = [];
                    try {
                        detections = await runDetectors(
                            testName,
                            `/home/flakewatch/clone/${project.name}`,
                            module,
                            project
                        );
                    } catch (e) {
                        console.error(
                            project.name +
                                ": Something went wrong when running detectors for " +
                                testName
                        );
                        console.error(e);
                    }
                    await git.reset(["--hard"]);
                    await git.checkout(project.branch);

                    result.detections.push({
                        testName,
                        detections,
                        module,
                        sha: commit,
                    });
                }
                await ciLogsPromise;
                console.log(project.name + ": Finished running detectors.");
            }
        }
    } finally {
        fs.writeFile(
            "/home/flakewatch/flakewatch-results.json",
            JSON.stringify(result)
        );
    }
}

export async function findModifiedTests(log: LogResult<DefaultLogFields>) {
    let modifiedTests: {
        testName: string;
        commit: string;
        module: string;
        count: number;
    }[] = [];
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
                file: string[];
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
                    curDetails = {
                        testPrefix: qualifiedTestClass,
                        file: (
                            await git.show([commit.hash + ":" + filepath])
                        ).split("\n"),
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
                        if (count == 0) continue; // FIXME: handle this case
                        const isJUnit3 =
                            line.includes("public class") &&
                            line.includes("extends TestCase");
                        for (let i = 0; i < count; i++) {
                            const lineNum = start + i;
                            // for each line, search for the test that it is potentially in
                            const line = curDetails.file[lineNum]!.trimEnd();
                            if (!line) continue;
                            const indentation = line.search(/\S/);
                            // while the indentation is decreasing, check if the line contains @Test. If so, add the test to modifiedTests
                            let j = lineNum - 1;
                            while (j >= 0) {
                                const checkLine = curDetails.file[j]!.trimEnd();
                                if (!checkLine) {
                                    j--;
                                    continue;
                                }
                                if (checkLine.search(/\S/) > indentation) break;
                                if (
                                    isJUnit3
                                        ? checkLine.includes("public void") &&
                                          checkLine.includes("test")
                                        : checkLine.match(/@Test(?:$|\W)/)
                                ) {
                                    // now we have to find the actual test name
                                    // most tests are written in syntax similar to either:
                                    // @Test
                                    // void testMethod() { ...
                                    // or
                                    // @Test void testMethod() { ...
                                    // so we just run a regex on both lines to find the test name
                                    // we will assume no JUnit 5 parameterized tests for now
                                    const testRegex = /(\w+) *\(/;
                                    let testName =
                                        checkLine.match(testRegex)?.[1];
                                    if (!testName) {
                                        for (
                                            let index = 1;
                                            index < 9;
                                            index++
                                        ) {
                                            const line =
                                                curDetails.file[j + index]!;
                                            if (!line) break;
                                            const match = line.match(testRegex);
                                            if (match) {
                                                testName = match[1];
                                                break;
                                            }
                                        }
                                    }

                                    if (testName) {
                                        const qualifiedTestName =
                                            curDetails.testPrefix +
                                            "#" +
                                            testName;
                                        if (
                                            !modifiedTests.find(
                                                (t) =>
                                                    t.testName ===
                                                    qualifiedTestName
                                            )
                                        ) {
                                            modifiedTests.push({
                                                testName: qualifiedTestName,
                                                commit: commit.hash,
                                                module: curDetails.module,
                                                count: 1,
                                            });
                                        } else {
                                            const existingTest =
                                                modifiedTests.find(
                                                    (t) =>
                                                        t.testName ===
                                                        qualifiedTestName
                                                );
                                            if (existingTest) {
                                                existingTest.count =
                                                    existingTest.count + 1;
                                            }
                                        }
                                    } else {
                                        console.warn(
                                            "Failed to find test name in:\n" +
                                                curDetails.file
                                                    .slice(
                                                        Math.max(j, 0),
                                                        Math.min(
                                                            j + 9,
                                                            curDetails.file
                                                                .length
                                                        )
                                                    )
                                                    .join("\n")
                                        );
                                    }
                                    break;
                                }
                                j--;
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

const failureRegex = /FAILURE!.+in (.+)\n.*?Error(?::|])\s*(\w+)/gi;
async function downloadCILogs(
    project: ProjectInfo,
    log: LogResult<DefaultLogFields>,
    result: FlakewatchResults
) {
    if (!project.githubToken) return;

    await fs.mkdir(`/home/flakewatch/ci-logs/${project.name}`, {
        recursive: true,
    });

    for (const commit of log.all) {
        try {
            const workflowRuns = (
                await octokit.rest.actions.listWorkflowRunsForRepo({
                    owner: project.owner,
                    repo: project.repo,
                    head_sha: commit.hash,
                })
            ).data.workflow_runs;
            for (const run of workflowRuns) {
                const runLogs =
                    await octokit.rest.actions.downloadWorkflowRunLogs({
                        owner: project.owner,
                        repo: project.repo,
                        run_id: run.id,
                    });

                const date = commit.date.slice(0, 10).replaceAll("-", "");
                const hash = commit.hash.slice(0, 7);
                const filePath = `/home/flakewatch/ci-logs/${project.name}/${date}-${hash}-${run.id}.zip`;

                await fs.writeFile(
                    filePath,
                    Buffer.from(runLogs.data as ArrayBuffer)
                );

                // extract flaky tests from the logs
                let failures;
                try {
                    failures = (await exec(`zipgrep 'FAILURE!' ${filePath}`))
                        .stdout;
                } catch (e) {
                    // no failures, woohoo!
                    continue;
                }

                const flakies = failures.matchAll(failureRegex);
                for (const flaky of flakies) {
                    const qualifiedTestName = flaky[1] + "#" + flaky[2];
                    console.log(
                        `${project.name}: ${qualifiedTestName} failed in CI`
                    );
                    result.ciDetections.push({
                        testName: qualifiedTestName,
                        sha: commit.hash,
                    });
                }
            }
        } catch (e) {
            console.error("Failed to download CI logs:");
            console.error(e);
        }
    }
}
