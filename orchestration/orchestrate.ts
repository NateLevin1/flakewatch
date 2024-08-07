import util from "util";
import { exec as execC } from "child_process";
import fs from "fs/promises";
import type {
    FlakewatchResults,
    Project,
    ProjectInfo,
    UpdateResults,
} from "./shared.js";
import { config, projects, reloadProjects } from "./config.js";
import {
    getFlaky,
    getProjectLastCheckedCommit,
    insertFlaky,
    setProjectLastCheckedCommit,
} from "./db.js";

export const exec = util.promisify(execC);

export async function orchestrate() {
    reloadProjects();
    const currentVersion = (await exec("git rev-parse HEAD")).stdout.trim();
    console.log(
        "Orchestrating " +
            projects.length +
            " projects, version=" +
            currentVersion
    );
    for (const project of projects) {
        orchestrateProject(project);
    }
}

async function orchestrateProject(project: Project) {
    const passedInInfo = JSON.stringify({
        ...project,
        lastCheckedCommit: "1fb14a8deddd6b9a0a40c9ea49e0c95b1ca18078", //getProjectLastCheckedCommit(project.name),
        githubToken: process.env.GITHUB_TOKEN!,
    } satisfies ProjectInfo).replaceAll('"', '\\"');

    const projectImageName = `flakewatch-${project.name}:latest`;

    let imageExists = false;
    try {
        imageExists =
            (
                await exec(`docker images -q ${projectImageName}`)
            ).stdout.trimEnd().length > 0;
    } catch (e) {}

    if (!imageExists)
        console.log(project.name + ": creating initial project image");

    const imageName = imageExists ? projectImageName : "flakewatch:base";
    const updateContainerName = `flakewatch-update-${project.name}`;
    const updateCmd = `/bin/bash -c "cd /home/flakewatch/flakewatch/backend && git pull && npm install && npm run build && npm run update -- '${passedInInfo}'"`;
    try {
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
        try {
            await exec(`docker image rm ${projectImageName}`); // remove the old image if present
        } catch (e) {}
        await exec(`docker commit ${updateContainerName} ${projectImageName}`);
        await exec(`docker rm ${updateContainerName}`);
        if (updateResults.shouldRunFlakewatch) {
            const startCmd = `/bin/bash -c "cd /home/flakewatch/flakewatch/backend && rm -f /home/flakewatch/flakewatch-results.json && rm -rf /home/flakewatch/ci-logs && npm run flakewatch -- '${passedInInfo}'"`;
            // NOTE: we expect the below line could take hours
            const containerName = `flakewatch-${project.name}`;
            await exec(
                `docker run --name='${containerName}' -i ${projectImageName} ${startCmd}`
            );
            await readFlakewatchResultsToDB(project, containerName);
        }
        if (updateResults.newLastCheckedCommit) {
            setProjectLastCheckedCommit(
                project.name,
                updateResults.newLastCheckedCommit
            );
        }
    } catch (e) {
        console.error(
            project.name + ": Something went wrong during orchestration:"
        );
        console.error(e);
        try {
            await exec(`docker rm ${updateContainerName}`);
        } catch (e) {}
        try {
            await exec(`docker rm flakewatch-${project.name}`);
        } catch (e) {}
    }
}

export async function readFlakewatchResultsToDB(
    project: Project,
    containerName: string
) {
    const firstDetectTime = Date.now();

    const resultsPath = `./results/flakewatch-results-${project.name}.json`;
    await fs.mkdir("results", { recursive: true });
    await fs.mkdir("ci-logs/" + project.name, { recursive: true });
    await fs.mkdir("run-logs/" + project.name, { recursive: true });
    await fs.mkdir("detector-errors/" + project.name, { recursive: true });

    await exec(
        `docker cp ${containerName}:/home/flakewatch/flakewatch-results.json ${resultsPath}`
    );
    await exec(
        `docker cp ${containerName}:/home/flakewatch/ci-logs/. ./ci-logs/${project.name}/`
    );
    await exec(
        `docker cp ${containerName}:/home/flakewatch/run-logs/. ./run-logs/${project.name}/`
    );
    await exec(
        `docker cp ${containerName}:/home/flakewatch/detector-errors/. ./detector-errors/${project.name}/`
    );

    const results = JSON.parse(
        (await fs.readFile(resultsPath)).toString()
    ) as FlakewatchResults;

    let flakyDetected = false;

    for (const {
        testName,
        category,
        runSha,
        lastEditSha,
        module,
    } of results.detections) {
        if (category) {
            console.log(`${project.name}: ${testName} was flaky - ${category}`);
            flakyDetected = true;
        }

        insertFlaky({
            projectURL: project.gitURL,
            runSha,
            lastEditSha,
            detectTime: firstDetectTime,
            modulePath: module,
            qualifiedTestName: testName,
            category: category ?? "",
        });
    }

    if (flakyDetected && config.saveImageOnFlaky) {
        // save the image
        await exec(
            `docker commit ${containerName} flakewatch-failure-${project.name}-${firstDetectTime}:latest`
        );
    }
    if (!project.debug?.leaveContainers) {
        await exec(`docker rm ${containerName}`);
    }

    for (const { testName, sha, module } of results.ciDetections) {
        console.log(project.name + ": " + testName + " was flaky in CI.");
        insertFlaky({
            projectURL: project.gitURL,
            runSha: sha,
            lastEditSha: "",
            detectTime: firstDetectTime,
            modulePath: module,
            qualifiedTestName: testName,
            category: "CI",
        });
    }
}
