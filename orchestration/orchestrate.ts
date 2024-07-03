import util from "util";
import { exec as execC } from "child_process";
import fs from "fs/promises";
import type {
    FlakewatchResults,
    Project,
    ProjectInfo,
    UpdateResults,
} from "./shared.js";
import { projects } from "./config.js";
import {
    getFlaky,
    getProjectLastCheckedCommit,
    insertFlaky,
    markFlakyFixed,
    setProjectLastCheckedCommit,
    updateFlakyCategory,
} from "./db.js";

export const exec = util.promisify(execC);

export async function orchestrate() {
    for (const project of projects) {
        orchestrateProject(project);
    }
}

async function orchestrateProject(project: Project) {
    const passedInInfo = JSON.stringify({
        ...project,
        lastCheckedCommit: "93bb996341f21b73f1e7dc46afcd07104061f1e3", //getProjectLastCheckedCommit(project.name),
        githubToken: process.env.GITHUB_TOKEN!,
    } satisfies ProjectInfo).replaceAll('"', '\\"');

    const projectImageName = `flakewatch-${project.name}:latest`;

    let containerExists = false;
    try {
        containerExists =
            (
                await exec(`docker images | grep ${projectImageName}`)
            ).stdout.split("\n").length > 0;
    } catch (e) {}

    try {
        const imageName = containerExists
            ? projectImageName
            : "flakewatch:base";
        const updateContainerName = `flakewatch-update-${project.name}`;
        const updateCmd = `/bin/bash -c "cd /home/flakewatch/flakewatch/backend && git pull && npm install && npm run update -- '${passedInInfo}'"`;
        await exec(
            `docker run --name='${updateContainerName}' -i ${imageName} ${updateCmd}`
        );
        await exec(
            `docker cp ${updateContainerName}:/home/flakewatch/update-results.json ./results/update-results-${project.name}.json`
        );
        const updateResults = JSON.parse(
            (
                await fs.readFile(
                    `./results/update-results-${project.name}.json`
                )
            ).toString()
        ) as UpdateResults;
        if (!updateResults.compileSuccess) {
            console.error(project.name + ": Compilation failed.");
            return;
        }
        await exec(`docker image rm ${projectImageName}`); // remove the old image
        await exec(`docker commit ${updateContainerName} ${projectImageName}`);
        await exec(`docker rm ${updateContainerName}`);
        if (updateResults.newLastCheckedCommit) {
            setProjectLastCheckedCommit(
                project.name,
                updateResults.newLastCheckedCommit
            );
        }
        if (!updateResults.shouldRunFlakewatch) return;

        const startCmd = `/bin/bash -c "cd /home/flakewatch/flakewatch/backend && rm -f /home/flakewatch/flakewatch-results.json && rm -rf /home/flakewatch/ci-logs && git pull && npm install && npm run flakewatch -- '${passedInInfo}'"`;
        // NOTE: we expect the below line could take hours
        await exec(
            `docker run --name='flakewatch-${project.name}' -i ${projectImageName} ${startCmd}`
        );
        await readFlakewatchResultsToDB(project);
    } catch (e) {
        console.error(
            project.name + ": Something went wrong during orchestration:"
        );
        console.error(e);
    }
}

async function readFlakewatchResultsToDB(project: Project) {
    const resultsPath = `./results/flakewatch-results-${project.name}.json`;
    await fs.mkdir("results", { recursive: true });
    await fs.mkdir("ci-logs/" + project.name, { recursive: true });

    const containerName = `flakewatch-${project.name}`;
    await exec(
        `docker cp ${containerName}:/home/flakewatch/flakewatch-results.json ${resultsPath}`
    );
    await exec(
        `docker cp ${containerName}:/home/flakewatch/ci-logs/. ./ci-logs/${project.name}/`
    );
    await exec(`docker rm ${containerName}`);

    const results = JSON.parse(
        (await fs.readFile(resultsPath)).toString()
    ) as FlakewatchResults;

    for (const { testName, detections, sha, module } of results.detections) {
        console.log(
            project.name +
                ": " +
                testName +
                " is flaky. Reason(s): " +
                detections.join(", ")
        );
        const existing = getFlaky(testName);

        if (detections.length > 0) {
            // add to DB
            const newCategory = detections.join("&");
            const insert = () => {
                insertFlaky({
                    projectURL: project.gitURL,
                    firstDetectCommit: sha,
                    firstDetectTime: Date.now(),
                    modulePath: module,
                    qualifiedTestName: testName,
                    category: newCategory,
                });
            };
            if (existing) {
                if (existing.category !== newCategory) {
                    if (existing.fixCommit) {
                        insert();
                    } else {
                        updateFlakyCategory(
                            existing.ulid,
                            existing.category ?? "",
                            newCategory
                        );
                    }
                }
            } else {
                insert();
            }
        } else {
            if (existing) {
                // we previously detected this test as flaky, but we no longer do
                markFlakyFixed(sha, Date.now(), testName);
            }
        }
    }

    for (const { testName, sha } of results.ciDetections) {
        console.log(project.name + ": " + testName + " is flaky in CI.");
        const existing = getFlaky(testName);
        const insert = () => {
            insertFlaky({
                projectURL: project.gitURL,
                firstDetectCommit: sha,
                firstDetectTime: Date.now(),
                modulePath: "UNKNOWN!", // TODO: how can we know this information?
                qualifiedTestName: testName,
                category: "CI",
            });
        };
        if (existing) {
            if (existing.fixCommit) {
                insert();
            } else {
                if (!existing.category || !existing.category.includes("CI")) {
                    updateFlakyCategory(
                        existing.ulid,
                        existing.category ?? "",
                        "CI"
                    );
                }
            }
        } else {
            insert();
        }
    }
}
