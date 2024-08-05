import { runDetectors } from "./detectors.js";
import type { FlakewatchResults, ProjectInfo } from "./shared.js";
import {
    runModuleDetectors,
    type ModuleCommitInfo,
} from "./moduledetectors.js";
import type { ModifiedTests } from "./flakewatch.js";
import type { SimpleGit } from "simple-git";

export async function handleModifiedTests(
    modifiedTests: ModifiedTests,
    sha: string,
    result: FlakewatchResults,
    project: ProjectInfo,
    git: SimpleGit
) {
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
                ({ module: m, commit: c }) => m === module && c === commit
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
        const moduleCommitInfo = await runModuleDetectors({
            projectPath,
            module,
            project,
            minsAllowed: minsAllowedPerModuleCommit,
        });
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
            ({ module: m, commit: c }) => m === module && c === commit
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
            const { category } = await runDetectors({
                qualifiedTestName: testName,
                projectPath,
                module,
                project,
                moduleCommitInfo,
                commitSha: commit,
                minsAllowed: minsAllowedPerTest,
            });
            result.detections.push({
                testName,
                category,
                module,
                sha: commit,
            });
        } catch (e) {
            console.error(
                "Something went wrong when running detectors for " + testName
            );
            console.error(e);
        }
        await git.reset(["--hard"]);
        await git.checkout(project.branch);
    }
}
