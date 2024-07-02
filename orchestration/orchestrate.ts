import util from "util";
import { exec as execC } from "child_process";
import fs from "fs/promises";
import type { FlakewatchResults, Project, ProjectInfo } from "./shared.js";
import { projects } from "./config.js";
import {
    getFlaky,
    getProjectLastCheckedCommit,
    insertFlaky,
    markFlakyFixed,
    updateFlakyCategory,
} from "./db.js";

export const exec = util.promisify(execC);

export async function orchestrate() {
    console.log(
        projects.length +
            " projects loaded: " +
            projects.map((p) => p.name).join(", ") +
            "."
    );
    for (const project of projects) {
        orchestrateProject(project);
    }
}

async function orchestrateProject(project: Project) {
    let containerExists = false;
    try {
        containerExists =
            (await exec(`docker ps -a | grep flakewatch-${project.name}`))
                .stdout.length > 0;
    } catch (e) {}

    const passedInInfo = JSON.stringify({
        ...project,
        lastCheckedCommit: getProjectLastCheckedCommit(project.name),
        githubToken: process.env.GITHUB_TOKEN!,
    } satisfies ProjectInfo).replaceAll('"', '\\"');

    try {
        const startCmd = `/bin/bash -c "cd /home/flakewatch/flakewatch/backend && git pull && npm install && npm start -- '${passedInInfo}'"`;
        let promise: Promise<unknown>;
        if (containerExists) {
            await exec(`docker start flakewatch-${project.name}`);
            promise = exec(
                `docker exec flakewatch-${project.name} ${startCmd}`
            );
        } else {
            promise = exec(
                `docker run --name='flakewatch-${project.name}' -i -t flakewatch:base ${startCmd}`
            );
        }
        await promise; // we expect this to take hours!
        await readFlakewatchResultsToDB(project);
    } catch (e) {
        console.error(project.name + ": Something went wrong during start up:");
        console.error(e);
    }
}

async function readFlakewatchResultsToDB(project: Project) {
    const resultsPath = `./results/flakewatch-results-${project.name}.json`;
    await fs.mkdir("results", { recursive: true });
    await fs.mkdir("ci-logs/" + project.name, { recursive: true });

    await exec(
        `docker cp flakewatch-${project.name}:/home/flakewatch/flakewatch-results.json ${resultsPath}`
    );
    await exec(
        `docker exec flakewatch-${project.name} rm /home/flakewatch/flakewatch-results.json`
    );
    await exec(
        `docker cp flakewatch-${project.name}:/home/flakewatch/ci-logs/. ./ci-logs/${project.name}/`
    );
    await exec(
        `docker exec flakewatch-${project.name} rm -rf /home/flakewatch/ci-logs`
    );
    await exec(`docker stop flakewatch-${project.name}`);

    const results = JSON.parse(
        (await fs.readFile(resultsPath)).toString()
    ) as FlakewatchResults;

    for (const { testName, detections, sha, module } of results.detections) {
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
