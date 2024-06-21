import { getProjectLastCheckedCommit, setProjectLastCheckedCommit } from "./db";
import { projects } from "./projects";
import { simpleGit, CleanOptions } from "simple-git";

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
            } catch (e) {
                // clone fails if non-empty, so pull instead if it's already cloned
                await git.pull();
            }
            await git.cwd("clones/" + project.name);

            const lastCheckedCommit = getProjectLastCheckedCommit(project.name);
            const log = await git.log({
                from: lastCheckedCommit,
                to: "HEAD",
            });
            if (!log.latest) continue;

            if (!lastCheckedCommit) {
                setProjectLastCheckedCommit(project.name, log.latest.hash);
                console.log(
                    `Initializing ${project.name} to commit ${log.latest.hash}`
                );
                continue;
            }

            const newCommitsExist = log.latest.hash !== lastCheckedCommit;
            if (newCommitsExist) {
                // * Find all tests that have been modified in this commit, by parsing the git diff
                setProjectLastCheckedCommit(project.name, log.latest.hash);
                console.log(
                    `${project.name}: ${log.all.length} new commits found`
                );

                let modifiedTests: string[] = [];
                for (const commit of log.all) {
                    const diff = await git.diff([
                        commit.hash + "^",
                        commit.hash,
                        "--unified=0",
                        "--diff-filter=AM",
                    ]);
                    const lines = diff.split("\n");

                    let curTestPrefix: string | null = null;
                    let curFile: string[] | null = null;
                    for (const line of lines) {
                        if (line.startsWith("+++")) {
                            const filepath = line.split(" ")[1]!.slice(2);
                            if (!filepath.endsWith(".java")) {
                                curFile = null;
                                continue;
                            }
                            curTestPrefix = filepath
                                .split("/")
                                .at(-1)!
                                .split(".")[0]!;
                            curFile = (
                                await git.show([commit.hash + ":" + filepath])
                            ).split("\n");
                        } else if (line.startsWith("@@") && curFile != null) {
                            const match = line.match(
                                /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/
                            );
                            if (match) {
                                const start = parseInt(match[1]!) - 1;
                                const count = parseInt(match[2] ?? "1");
                                if (count == 0) continue;
                                for (let i = 0; i < count; i++) {
                                    const lineNum = start + i;
                                    // for each line, search for the test that it is potentially in
                                    const line = curFile![lineNum]!.trimEnd();
                                    if (!line) continue;
                                    const indentation = line.search(/\S/);
                                    // while the indentation is decreasing, check if the line contains @Test. If so, add the test to modifiedTests
                                    let j = lineNum - 1;
                                    while (j >= 0) {
                                        const checkLine =
                                            curFile![j]!.trimEnd();
                                        if (!checkLine) {
                                            j--;
                                            continue;
                                        }
                                        if (
                                            checkLine.search(/\S/) > indentation
                                        )
                                            break;
                                        if (checkLine.includes("@Test")) {
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
                                                checkLine.match(
                                                    testRegex
                                                )?.[1] ??
                                                curFile![j + 1]!.match(
                                                    testRegex
                                                )?.[1];
                                            if (testName) {
                                                const qualifiedTestName =
                                                    curTestPrefix +
                                                    "." +
                                                    testName;
                                                if (
                                                    !modifiedTests.includes(
                                                        qualifiedTestName
                                                    )
                                                )
                                                    modifiedTests.push(
                                                        qualifiedTestName
                                                    );
                                                break;
                                            } else {
                                                console.warn(
                                                    "Failed to find test name in:",
                                                    checkLine,
                                                    curFile![j + 1]!
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
                if (modifiedTests.length > 0) {
                    const sha = log.latest.hash.slice(0, 7);
                    console.log(
                        `${modifiedTests.length} tests modified in commit ${sha}:`,
                        modifiedTests
                    );
                }
            }
        }
    } catch (e) {
        console.error("Something went wrong when running flakewatch.");
        console.error(e);
    }
}
