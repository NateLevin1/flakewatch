import { getProjectLastCheckedCommit, setProjectLastCheckedCommit } from "./db";
import { runDetectors } from "./detectors";
import { projects } from "./config";
import {
    simpleGit,
    CleanOptions,
    LogResult,
    DefaultLogFields,
} from "simple-git";

const git = simpleGit({ baseDir: "clones" }).clean(CleanOptions.FORCE);

export type Flaky = {
    ulid: string;
    projectURL: string;
    firstDetectCommit: string;
    firstDetectTime: number;
    fixCommit?: string;
    fixTime?: number;
    modulePath: string;
    qualifiedTestName: string;
    category?: string;
};

export async function flakewatch() {
    try {
        for (const project of projects) {
            // * Update the project to the latest commit
            try {
                await git.clone(project.gitURL, project.name);
                await git.cwd("clones/" + project.name);
            } catch (e) {
                await git.cwd("clones/" + project.name);
                // clone fails if non-empty, so pull instead if it's already cloned
                await git.checkout(project.branch);
                await git.reset(["--hard"]);
                await git.pull();
            }

            const lastCheckedCommit = getProjectLastCheckedCommit(project.name);
            const log = await git.log({
                from: lastCheckedCommit,
                to: "HEAD",
            });
            if (!log.latest) continue;

            if (!lastCheckedCommit) {
                setProjectLastCheckedCommit(project.name, log.latest.hash);
                console.log(
                    `${project.name}: Initializing at commit ${log.latest.hash}`
                );
                continue;
            }

            const newCommitsExist = log.latest.hash !== lastCheckedCommit;
            if (newCommitsExist) {
                setProjectLastCheckedCommit(project.name, log.latest.hash);
                console.log(
                    `${project.name}: ${log.all.length} new commits found`
                );

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
                        await git.checkout(commit);
                        try {
                            await runDetectors(
                                testName,
                                `${__dirname}/clones/${project.name}/${module}`
                            );
                        } catch (e) {
                            console.error(
                                project.name +
                                    ": Something went wrong when running detectors for " +
                                    testName
                            );
                            console.error(e);
                        }
                        await git.checkout(project.branch);
                    }
                    console.log(project.name + ": Finished running detectors.");
                }
            }
        }
    } catch (e) {
        console.error("Something went wrong when running flakewatch.");
        console.error(e);
    }
}

async function findModifiedTests(log: LogResult<DefaultLogFields>) {
    let modifiedTests: {
        testName: string;
        commit: string;
        module: string;
    }[] = [];
    for (const commit of log.all) {
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
                const filepath = line.split(" ")[1]!.slice(2);
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
                                // public void testMethod() { ...
                                // or
                                // @Test public void testMethod() { ...
                                // so we just run a regex on both lines to find the test name
                                // we will assume no JUnit 5 parameterized tests for now
                                const testRegex = /(\w+)\(\)/;
                                const testName =
                                    checkLine.match(testRegex)?.[1] ??
                                    curDetails.file[j + 1]!.match(
                                        testRegex
                                    )?.[1] ??
                                    curDetails.file[j + 2]!.match(
                                        testRegex
                                    )?.[1];
                                if (testName) {
                                    const qualifiedTestName =
                                        curDetails.testPrefix + "#" + testName;
                                    if (
                                        !modifiedTests.find(
                                            (t) =>
                                                t.testName === qualifiedTestName
                                        )
                                    )
                                        modifiedTests.push({
                                            testName: qualifiedTestName,
                                            commit: commit.hash,
                                            module: curDetails.module,
                                        });
                                    break;
                                } else {
                                    console.warn(
                                        "Failed to find test name in:\n" +
                                            checkLine +
                                            "\nnor:" +
                                            curDetails.file[j + 1]! +
                                            "\nnor:" +
                                            curDetails.file[j + 2]!
                                    );
                                }
                            }
                            j--;
                        }
                    }
                }
            }
        }
    }
    return modifiedTests;
}
