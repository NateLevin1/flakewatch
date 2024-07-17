import fs from "fs/promises";
import type { ProjectInfo } from "./shared.js";
import { exec } from "./detectors.js";

export type ModuleCommitInfo = {
    allTests: string[];
    idFlakiesResults: iDFlakiesResult[];
};

type iDFlakiesResult = {
    test: string;
    type: "OD" | "NOD";
    passingOrder: string[];
    failingOrder: string[];
};

// detectors that work per-module, not per-test
export async function runModuleDetectors(
    projectPath: string,
    module: string,
    project: ProjectInfo,
    minsAllowed: number
): Promise<ModuleCommitInfo> {
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

    const idFlakiesTimeoutMs =
        minsAllowed * 60 * 1000 - (Date.now() - startTime); // remaining time
    const idFlakiesResults = await detectIDFlakies(
        fullModulePath,
        idFlakiesTimeoutMs
    );
    console.log(
        ` - finished iDFlakies, found ${
            idFlakiesResults.length
        } results. (given ${Math.round(idFlakiesTimeoutMs / 1000)}s)`
    );

    return { allTests, idFlakiesResults };
}

type FlakyListsType = {
    dts: {
        name: string;
        type: "OD" | "NOD";
        intended: { order: string[] };
        revealed: { order: string[] };
    }[];
};
export async function detectIDFlakies(
    fullModulePath: string,
    timeoutMs: number
): Promise<iDFlakiesResult[]> {
    const startTime = Date.now();
    await exec(
        `cd ${fullModulePath} && mvn edu.illinois.cs:idflakies-maven-plugin:2.0.0:detect -Ddetector.detector_type=reverse-class-method -Ddt.detector.original_order.all_must_pass=false`
    );
    const reverseCMResult = await readFlakyLists(fullModulePath);
    console.log(" - finished iDFlakies Reverse C+M");

    const remainingSecs = (timeoutMs - (Date.now() - startTime)) / 1000;

    await exec(
        `cd ${fullModulePath} && mvn edu.illinois.cs:idflakies-maven-plugin:2.0.0:detect -Ddetector.detector_type=random-class-method -Ddt.detector.original_order.all_must_pass=false -Ddetector.timeout=${remainingSecs}`
    );
    const randomCMResult = await readFlakyLists(fullModulePath);

    const allResults = [...reverseCMResult, ...randomCMResult];

    return allResults.filter(
        (value, index) =>
            allResults.findIndex((v) => v.test === value.test) === index
    );
}

async function readFlakyLists(
    fullModulePath: string
): Promise<iDFlakiesResult[]> {
    const flakyLists = JSON.parse(
        await fs.readFile(
            fullModulePath +
                "/.dtfixingtools/detection-results/flaky-lists.json",
            "utf-8"
        )
    ) as FlakyListsType;

    return flakyLists.dts.map((dt) => {
        return {
            test: convertIdFlakiesTestName(dt.name),
            type: dt.type,
            passingOrder: dt.intended.order,
            failingOrder: dt.revealed.order,
        };
    });
}

function convertIdFlakiesTestName(testName: string) {
    const methodName = testName.split(".").at(-1);
    const className = testName.split(".").slice(0, -1).join(".");
    return className + "#" + methodName;
}
