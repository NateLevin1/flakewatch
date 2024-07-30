import fs from "fs/promises";
import type { ProjectInfo } from "./shared.js";
import { exec } from "./detectors.js";
import {
    createTimeoutFunction,
    md5,
    run,
    type DetectorRun,
} from "./runutils.js";

type ModuleDetectorRuns = Map<string, DetectorRun[]>;

export type ModuleCommitInfo = {
    allTests: string[];
    detectorRuns: ModuleDetectorRuns;
};

const NUM_MODULE_DETECTORS = 1;
const MIN_DETECTOR_SEC = 60;

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
}): Promise<ModuleCommitInfo> {
    const startTime = Date.now();

    const fullModulePath = projectPath + "/" + module;
    const testArgs = project.mvnTestArgs ?? "";
    const pl = module ? `-pl ${module}` : "";

    console.log("Running module detectors for " + fullModulePath);
    // we run `mvn test` and parse its output to get the list of all tests
    await exec(`cd ${fullModulePath} && rm -rf target/surefire-reports`);
    await exec(
        `cd ${projectPath} && mvn test ${pl} ${testArgs} -DskipITs -Dmaven.test.failure.ignore=true -DtestFailureIgnore=true`
    );
    // modulePath/target/surefire-reports/TEST-*.xml has the test cases
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
                const className = file.slice(5, -4);
                const tests = content.matchAll(/<testcase name="([^"]+)"/g);
                const result = [];
                for (const test of tests) {
                    if (test[1]) result.push(className + "#" + test[1]);
                }
                resolve(result);
            })
        );
    }
    const allTests = (await Promise.all(allTestsPromises)).flat();
    console.log(" - found " + allTests.length + ' tests in "' + module + '"');

    const detectorMinsAllowed =
        (minsAllowed * 60 * 1000 - (Date.now() - startTime)) / 1000 / 60;
    const getTimeout = createTimeoutFunction(
        detectorMinsAllowed,
        NUM_MODULE_DETECTORS,
        MIN_DETECTOR_SEC
    );

    const detectorRuns = new Map() as ModuleDetectorRuns;

    await run(() =>
        detectIDFlakies(
            {
                fullModulePath,
                timeoutSecs: getTimeout(0),
                minDetectorSecs: MIN_DETECTOR_SEC,
            },
            detectorRuns
        )
    );
    console.log(" - finished iDFlakies");

    return { allTests, detectorRuns };
}

export async function detectIDFlakies(
    {
        fullModulePath,
        timeoutSecs,
        minDetectorSecs,
    }: { fullModulePath: string; timeoutSecs: number; minDetectorSecs: number },
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

    const files = await fs.readdir(
        fullModulePath + "/.dtfixingtools/test-runs/results/"
    );
    for (const file of files) {
        const content = await fs.readFile(
            fullModulePath + "/.dtfixingtools/test-runs/results/" + file,
            "utf-8"
        );
        const ordering = JSON.parse(content) as {
            id: string;
            testOrder: string[];
            results: {
                [key: string]: {
                    result: "PASS" | "FAILURE";
                };
            };
        };

        const prefixStack: string[] = [];
        for (const idflakiesTest of ordering.testOrder) {
            const passed = ordering.results[idflakiesTest]?.result === "PASS";
            const test = convertIdFlakiesTestName(idflakiesTest);

            let existingRuns = detectorRuns.get(test);
            if (!existingRuns) {
                existingRuns = [];
                detectorRuns.set(test, existingRuns);
            }
            existingRuns.push({
                test,
                prefixMd5: md5(prefixStack.join("")),
                tool: "iDFlakies",
                passed,
                log: "",
            });

            prefixStack.push(test);
        }
    }
}

function convertIdFlakiesTestName(testName: string) {
    const methodName = testName.split(".").at(-1);
    const className = testName.split(".").slice(0, -1).join(".");
    return className + "#" + methodName;
}
