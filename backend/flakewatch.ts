import { runDetectors, exec } from "./detectors.js";
import { simpleGit, type LogResult, type DefaultLogFields } from "simple-git";
import fs from "fs/promises";
import { Octokit } from "@octokit/rest";
import type { FlakewatchResults, ProjectInfo } from "./shared.js";
import {
    runModuleDetectors,
    type ModuleCommitInfo,
} from "./moduledetectors.js";
import { parseTests, type Test } from "./parsetests.js";
import path from "path";

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
                const projectPath = `/home/flakewatch/clone/${project.name}`;
                console.log(
                    `${
                        modifiedTests.length
                    } tests modified up to commit ${sha}: ${modifiedTests
                        .map((s) => s.testName.split(".").at(-1))
                        .join(", ")}`
                );

                const moduleCommits: { module: string; commit: string }[] = [];
                for (const { module, commit } of modifiedTests) {
                    if (
                        !moduleCommits.find(
                            ({ module: m, commit: c }) =>
                                m === module && c === commit
                        )
                    )
                        moduleCommits.push({ module, commit });
                }

                const minsAllowedPerModuleCommit =
                    project.debug?.minsAllowedPerModuleCommit ??
                    Math.floor((6 * 60) / moduleCommits.length);
                console.log(
                    `Found ${moduleCommits.length} module+commit combos. Spending ${minsAllowedPerModuleCommit} mins per combo.`
                );
                const moduleCommitInfos: ({
                    module: string;
                    commit: string;
                } & ModuleCommitInfo)[] = [];
                console.log("Getting module commit infos:");
                for (const { module, commit } of moduleCommits) {
                    await git.reset(["--hard"]);
                    await git.checkout(commit);
                    console.log(` - getting mod "${module}" @ "${commit}"`);
                    const moduleCommitInfo = await runModuleDetectors(
                        projectPath,
                        module,
                        project,
                        minsAllowedPerModuleCommit
                    );
                    moduleCommitInfos.push({
                        ...moduleCommitInfo,
                        module,
                        commit,
                    });
                    await git.reset(["--hard"]);
                    await git.checkout(project.branch);
                }

                // * Run flakiness detectors
                const minsAllowedPerTest =
                    project.debug?.minsAllowedPerTest ??
                    Math.floor((18 * 60) / modifiedTests.length);
                console.log(
                    `Running test-specific flakiness detectors. Spending ${minsAllowedPerTest} mins per test.`
                );
                for (const { testName, commit, module } of modifiedTests) {
                    const moduleCommitInfo = moduleCommitInfos.find(
                        ({ module: m, commit: c }) =>
                            m === module && c === commit
                    );
                    if (!moduleCommitInfo) {
                        console.error(
                            "Failed to find module commit info for " +
                                module +
                                " at " +
                                commit +
                                ". Skipping test " +
                                testName +
                                "."
                        );
                        continue;
                    }
                    await git.reset(["--hard"]);
                    await git.checkout(commit);
                    try {
                        const detections = await runDetectors(
                            testName,
                            projectPath,
                            module,
                            project,
                            moduleCommitInfo,
                            commit,
                            minsAllowedPerTest
                        );
                        result.detections.push({
                            testName,
                            detections,
                            module,
                            sha: commit,
                        });
                    } catch (e) {
                        console.error(
                            "Something went wrong when running detectors for " +
                                testName
                        );
                        console.error(e);
                    }
                    await git.reset(["--hard"]);
                    await git.checkout(project.branch);
                }
                console.log("Finished running detectors.");
            }
        }
    } finally {
        await fs.writeFile(
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

const failureRegexA =
    /(?<className>[A-Za-z0-9_.]+)\.(?<testName>[A-Za-z0-9_]+)\s*-.+ <<< ERROR!/gi;
const failureRegexB =
    /(?<testName>[A-Za-z0-9_]+)\((?<className>[^\)]+)\).+<<< FAILURE!/gi;
async function downloadCILogs(
    project: ProjectInfo,
    log: LogResult<DefaultLogFields>
) {
    if (!project.githubToken) return [];

    const result = [] as FlakewatchResults["ciDetections"];

    await fs.mkdir(`/home/flakewatch/ci-logs`, {
        recursive: true,
    });

    console.log("Downloading CI logs for " + project.name);
    for (const commit of log.all) {
        console.log(" - checking CI logs for commit " + commit.hash);
        try {
            const workflowRuns = (
                await octokit.rest.actions.listWorkflowRunsForRepo({
                    owner: project.owner,
                    repo: project.repo,
                    head_sha: commit.hash,
                })
            ).data.workflow_runs;
            console.log(" - found " + workflowRuns.length + " workflow runs");

            for (const run of workflowRuns) {
                const runLogs =
                    await octokit.rest.actions.downloadWorkflowRunLogs({
                        owner: project.owner,
                        repo: project.repo,
                        run_id: run.id,
                    });

                const date = commit.date.slice(0, 10).replaceAll("-", "");
                const hash = commit.hash.slice(0, 7);
                const filePath = `/home/flakewatch/ci-logs/${date}-${hash}-${run.id}.zip`;

                await fs.writeFile(
                    filePath,
                    Buffer.from(runLogs.data as ArrayBuffer)
                );
                console.log(` --- downloaded CI logs for run ${run.id}`);

                // extract flaky tests from the logs
                let failures;
                try {
                    failures = (
                        await exec(`zipgrep -C3 'FAILURE!' ${filePath}`)
                    ).stdout;
                } catch (e) {
                    // no failures, woohoo!
                    console.log(" --- no CI failures found in " + filePath);
                    continue;
                }
                console.log(" --- found CI failures in " + filePath);

                const flakiesA = Array.from(failures.matchAll(failureRegexA));
                const flakiesB = Array.from(failures.matchAll(failureRegexB));
                const flakies = flakiesA.concat(flakiesB);
                for (const flaky of flakies) {
                    const qualifiedClassName = flaky.groups!.className!;
                    const testName = flaky.groups!.testName!;
                    const qualifiedTestName =
                        qualifiedClassName + "#" + testName;
                    if (result.find((r) => r.testName === qualifiedTestName))
                        continue; // duplicate

                    // find the .java file by class name
                    let module = "UNKNOWN!";
                    const className = qualifiedClassName.split(".").at(-1);
                    try {
                        const javaFile = (
                            await exec(
                                `cd /home/flakewatch/clone/${project.name} && find . -name '${className}.java'`
                            )
                        ).stdout.trim();
                        if (javaFile.split("\n").length > 1) {
                            console.warn(
                                `Multiple .java files found for ${qualifiedClassName}. Using the first one.`
                            );
                        }
                        const srcTestIndex = javaFile.indexOf("src/test/java");
                        if (srcTestIndex !== -1) {
                            module = javaFile.slice(2, srcTestIndex - 1);
                        }
                    } catch (e) {
                        console.error(
                            `Failed to find .java file for ${qualifiedClassName}. Searched for ${className}.java`
                        );
                    }

                    console.log(`[!] ${qualifiedTestName} failed in CI`);
                    result.push({
                        testName: qualifiedTestName,
                        sha: commit.hash,
                        module,
                    });
                }
            }
        } catch (e) {
            console.error("Failed to download CI logs:");
            console.error(e);
        }
    }
    return result;
}
