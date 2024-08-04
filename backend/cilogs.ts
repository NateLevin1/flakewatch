import fs from "fs/promises";
import type { DefaultLogFields, LogResult } from "simple-git";
import type { FlakewatchResults, ProjectInfo } from "./shared.js";
import { octokit } from "./flakewatch.js";
import { exec } from "./runutils.js";

const failureRegexA =
    /(?<className>[A-Za-z0-9_.]+)\.(?<testName>[A-Za-z0-9_]+)\s*-.+ <<< ERROR!/gi;
const failureRegexB =
    /(?<testName>[A-Za-z0-9_]+)\((?<className>[^\)]+)\).+<<< FAILURE!/gi;
export async function downloadCILogs(
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
