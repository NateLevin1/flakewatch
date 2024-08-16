import fs from "fs/promises";
import type { ProjectInfo } from "./shared.js";
import {
    exec,
    toArray,
    writeDetectorError,
    type ToolTimings,
} from "./runutils.js";
import {
    createTimeoutFunction,
    md5,
    run,
    type DetectorRun,
} from "./runutils.js";
import { XMLParser } from "fast-xml-parser";

type ModuleDetectorRuns = Map<string, DetectorRun[]>;

export type ModuleInfo = {
    allTests: string[];
    detectorRuns: ModuleDetectorRuns;
    toolTimings: ToolTimings;
};

const NUM_MODULE_DETECTORS = 1;
const MIN_DETECTOR_SEC = 60;

const xmlParser = new XMLParser({ ignoreAttributes: false });

// detectors that work per-module, not per-test
export async function runModuleDetectors({
    projectPath,
    module,
    project,
    minsAllowed,
}: {
    projectPath: string;
    module: string;
    project: ProjectInfo;
    minsAllowed: number;
}): Promise<ModuleInfo> {
    const startTime = Date.now();

    const fullModulePath = module ? projectPath + "/" + module : projectPath;
    const testArgs = project.mvnTestArgs ?? "";
    const pl = module ? `-pl ${module}` : "";
    const toolTimings: ToolTimings = {} as any;
    toolTimings._minsAllowed = { module: minsAllowed, test: 0 };

    console.log("Running module detectors for " + fullModulePath);
    let allTests: string[] | undefined = undefined;
    await run(async () => {
        allTests = await getAllTests({
            fullModulePath,
            projectPath,
            pl,
            testArgs,
        });
    });
    if (!allTests) {
        console.error(" - error: failed to get tests.");
        allTests = [];
    }
    console.log(" - found " + allTests.length + ' tests in "' + module + '"');
    toolTimings["TestFinder"] = Date.now() - startTime;

    const detectorMinsAllowed =
        (minsAllowed * 60 * 1000 - (Date.now() - startTime)) / 1000 / 60;
    const getTimeout = createTimeoutFunction(
        detectorMinsAllowed,
        NUM_MODULE_DETECTORS,
        MIN_DETECTOR_SEC
    );

    const detectorRuns = new Map() as ModuleDetectorRuns;

    const iDFlakiesStartTime = Date.now();
    await run(() =>
        detectIDFlakies(
            {
                fullModulePath,
                timeoutSecs: getTimeout(0),
                minDetectorSecs: MIN_DETECTOR_SEC,
                module,
            },
            detectorRuns
        )
    );
    toolTimings["iDFlakies"] = Date.now() - iDFlakiesStartTime;
    console.log(" - finished iDFlakies");

    return { allTests, detectorRuns, toolTimings };
}

async function getAllTests({
    fullModulePath,
    projectPath,
    pl,
    testArgs,
}: {
    fullModulePath: string;
    projectPath: string;
    pl: string;
    testArgs: string;
}) {
    // we run `mvn test` and parse its output to get the list of all tests
    await exec(`cd ${fullModulePath} && rm -rf target/surefire-reports`);
    await exec(
        `cd ${projectPath} && mvn test ${pl} ${testArgs} -DskipITs -Dmaven.test.failure.ignore=true -DtestFailureIgnore=true`
    );
    // fullModulePath/target/surefire-reports/TEST-*.xml has the test cases
    const reportFiles = await fs.readdir(
        fullModulePath + "/target/surefire-reports"
    );
    const allTestsPromises = [] as Promise<string[]>[];
    for (const file of reportFiles) {
        if (!file.startsWith("TEST") || file.includes("ALLCLASS")) continue;
        allTestsPromises.push(
            new Promise(async (resolve) => {
                const content = await fs.readFile(
                    fullModulePath + "/target/surefire-reports/" + file,
                    "utf-8"
                );
                const result = toArray(
                    xmlParser.parse(content).testsuite.testcase
                )!.map(
                    (test) => test["@_classname"] + "#" + test["@_name"]
                ) as string[];
                resolve(result);
            })
        );
    }
    const allTests = (await Promise.all(allTestsPromises)).flat();
    return allTests;
}

export async function detectIDFlakies(
    {
        fullModulePath,
        timeoutSecs,
        minDetectorSecs,
        module,
    }: {
        fullModulePath: string;
        timeoutSecs: number;
        minDetectorSecs: number;
        module: string;
    },
    detectorRuns: ModuleDetectorRuns
): Promise<void> {
    const startTime = Date.now();

    await exec(
        `cd ${fullModulePath} && mvn edu.illinois.cs:idflakies-maven-plugin:2.0.0:detect -Ddetector.detector_type=reverse-class-method -Ddt.detector.original_order.all_must_pass=false`
    );
    console.log(" - finished iDFlakies Reverse C+M");

    const remainingSecs = Math.max(
        timeoutSecs - (Date.now() - startTime) / 1000,
        minDetectorSecs
    );

    await exec(
        `cd ${fullModulePath} && mvn edu.illinois.cs:idflakies-maven-plugin:2.0.0:detect -Ddetector.detector_type=random-class-method -Ddt.detector.original_order.all_must_pass=false -Ddetector.timeout=${remainingSecs}`
    );

    const testRunsDir = fullModulePath + "/.dtfixingtools/test-runs/";
    const resultsDir = testRunsDir + "results/";
    const files = await fs.readdir(resultsDir);
    const filesWithCreationTime = await Promise.all(
        files.map(async (file) => ({
            file,
            creationTime: (await fs.stat(resultsDir + file)).birthtimeMs,
        }))
    );
    const orderedFiles = filesWithCreationTime
        .sort((a, b) => a.creationTime - b.creationTime)
        .map((f) => f.file);
    for (const file of orderedFiles) {
        const content = await fs.readFile(resultsDir + file, "utf-8");
        const ordering = JSON.parse(content) as {
            id: string;
            testOrder: string[];
            results: {
                [key: string]: {
                    result: "PASS" | "FAILURE" | "SKIPPED";
                    stackTrace: {
                        declaringClass: string;
                        methodName: string;
                        fileName: string;
                        lineNumber: number;
                    }[];
                };
            };
        };

        const prefixStack: string[] = [];
        for (const idflakiesTest of ordering.testOrder) {
            const result = ordering.results[idflakiesTest]!;
            if (result.result === "SKIPPED") continue;

            const passed = result.result === "PASS";
            const test = convertIdFlakiesTestName(idflakiesTest);

            let existingRuns = detectorRuns.get(test);
            if (!existingRuns) {
                existingRuns = [];
                detectorRuns.set(test, existingRuns);
            }
            let failure: string | undefined = undefined;
            if (!passed) {
                // we have to get the failure from the output file,
                // because iDFlakies only gives us the stack trace for some reason
                const output = await fs.readFile(
                    testRunsDir + "output/" + file,
                    "utf-8"
                );
                const originIndex = result.stackTrace.findIndex(
                    (st) => !st.declaringClass.startsWith("org.junit")
                );
                if (originIndex === -1) {
                    await writeDetectorError({
                        message:
                            "Couldn't find failure message in stack trace.",
                        result,
                        stdout: output,
                    });
                } else {
                    const origin = result.stackTrace[originIndex]!;
                    const searchStr = origin.fileName + ":" + origin.lineNumber;
                    const occurrences = searchStr.split(searchStr).length - 1;
                    if (occurrences > 1) {
                        // if there are multiple occurrences, we can't be sure which one is the right one
                        const warning =
                            "Warning: multiple occurrences of the same file and line number in the stack trace. Choosing the first one.";
                        console.warn(warning);
                        await writeDetectorError({
                            message: warning,
                            result,
                            stdout: output,
                        });
                    }
                    const filenameIndex = output.indexOf(searchStr);
                    // go back originIndex+1 lines to get the failure (+1 to get to the start of the line)
                    let index = filenameIndex;
                    for (let i = 0; i < originIndex + 2; i++) {
                        index = output.lastIndexOf("\n", index - 1);
                    }
                    const failureEndIndex = output.indexOf("\n", index + 1);
                    failure = md5(output.slice(index + 1, failureEndIndex));
                }
            }
            existingRuns.push({
                test,
                prefixMd5: md5(prefixStack.join("")),
                tool: "iDFlakies",
                passed,
                failure,
                log: undefined,
            });

            prefixStack.push(test);
        }
    }

    await exec(
        `cp -r ${fullModulePath}/.dtfixingtools /tmp/idflakies${
            module ? "-" + module : ""
        }`
    );
}

function convertIdFlakiesTestName(testName: string) {
    const methodName = testName.split(".").at(-1);
    const className = testName.split(".").slice(0, -1).join(".");
    return className + "#" + methodName;
}
