import { runDetectors } from "./detectors.js";
import type { FlakewatchResults, ProjectInfo } from "./shared.js";
import { runModuleDetectors, type ModuleInfo } from "./moduledetectors.js";
import type { ModifiedTests } from "./flakewatch.js";
import { ResetMode, type SimpleGit } from "simple-git";
import fs from "fs/promises";

const MODULE_HOURS = 6;
const TEST_HOURS = 18;

export async function handleModifiedTests(
    modifiedTests: ModifiedTests,
    latestSha: string,
    result: FlakewatchResults,
    project: ProjectInfo,
    git: SimpleGit
) {
    const projectPath = `/home/flakewatch/clone/${project.name}`;
    console.log(
        `${
            modifiedTests.length
        } tests modified up to commit ${latestSha}: ${modifiedTests
            .map((s) => s.testName.split(".").at(-1))
            .join(", ")}`
    );

    const modules = [...new Set(modifiedTests.map((t) => t.module))];

    const minsAllowedPerModule =
        project.debug?.minsAllowedPerModule ??
        Math.floor((MODULE_HOURS * 60) / modules.length);
    console.log(
        `Found ${modules.length} modules, spending ${minsAllowedPerModule} mins per module.`
    );
    const moduleInfos = new Map<string, ModuleInfo>();
    const existingTests = new Set<string>();
    console.log("Getting module infos:");

    await git.clean("fd");
    await git.reset(ResetMode.HARD);
    await git.checkout(latestSha);

    for (const module of modules) {
        console.log(` - getting mod "${module}" @ "${latestSha}"`);
        const moduleInfo = await runModuleDetectors({
            projectPath,
            module,
            project,
            minsAllowed: minsAllowedPerModule,
        });
        for (const test of moduleInfo.allTests) {
            existingTests.add(test);
        }
        moduleInfos.set(module, moduleInfo);
        await git.clean("fd");
        await git.reset(ResetMode.HARD);
    }

    // * Run flakiness detectors
    const testsToRun = modifiedTests.filter((t) => {
        const exists = existingTests.has(t.testName);
        if (!exists) {
            console.log(
                ` - skipping "${t.testName}" because it wasn't found in latest sha (modified ${t.commit})`
            );
        }
        return exists;
    });
    const minsAllowedPerTest =
        project.debug?.minsAllowedPerTest ??
        Math.floor((TEST_HOURS * 60) / testsToRun.length);
    console.log(
        `Running test-specific flakiness detectors. Spending ${minsAllowedPerTest} mins per test.`
    );
    for (const { testName, module, commit: lastEditSha } of testsToRun) {
        const moduleInfo = moduleInfos.get(module);
        if (!moduleInfo) {
            console.error(
                "Failed to find module info for " +
                    module +
                    ". Skipping test " +
                    testName +
                    "."
            );
            continue;
        }

        try {
            const { category } = await runDetectors({
                qualifiedTestName: testName,
                projectPath,
                module,
                project,
                moduleInfo,
                commitSha: latestSha,
                minsAllowed: minsAllowedPerTest,
            });
            result.detections.push({
                testName,
                category,
                module,
                runSha: latestSha,
                lastEditSha,
            });
        } catch (e) {
            console.error(
                "Something went wrong when running detectors for " + testName
            );
            console.error(e);
        }

        await git.clean("fd");
        await git.reset(ResetMode.HARD);
    }
}

export async function onFlakewatchComplete(
    project: ProjectInfo,
    result: FlakewatchResults
) {
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
