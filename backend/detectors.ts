import util from "util";
import { exec as execC } from "child_process";
import fs from "fs/promises";
import type { DetectionCause, ProjectInfo } from "./shared.js";

export const exec = util.promisify(execC);

export type DetectorInfo = {
    qualifiedTestName: string;
    fullModulePath: string;
    projectPath: string;
    module: string;
    allTests: string[];
    pl: string;
};

const run = async (fn: () => Promise<void>) => {
    try {
        await fn();
    } catch (e: any) {
        console.error("Error running detector.");
        console.error(e);
        if (typeof e.stdout === "string") {
            console.error("\nStdout:");
            console.error(e.stdout);
            return;
        }
    }
};

// TODO: base on page 12 of Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function runDetectors(
    qualifiedTestName: string,
    projectPath: string,
    module: string,
    project: ProjectInfo
) {
    const fullModulePath = projectPath + "/" + module;

    const testArgs = project.mvnTestArgs ?? "";
    const pl = module ? `-pl ${module}` : "";

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

    const detectorInfo = {
        qualifiedTestName,
        projectPath,
        fullModulePath,
        module,
        allTests,
        pl,
    } satisfies DetectorInfo;

    const detections: DetectionCause[] = [];

    await run(async () => await detectIDFlakies(detectorInfo, detections));
    await run(async () => await detectNonDex(detectorInfo, detections));
    await run(async () => await detectIsolation(detectorInfo, detections));
    await run(async () => await detectOneByOne(detectorInfo, detections));

    if (detections.length > 0) {
        console.log(
            project.name +
                ": " +
                qualifiedTestName +
                " is flaky. Reason(s): " +
                detections.join(", ")
        );
    }

    return detections;
}

export async function detectIDFlakies(
    { qualifiedTestName, fullModulePath }: DetectorInfo,
    detections: string[]
) {
    await exec(
        `cd ${fullModulePath} && mvn edu.illinois.cs:idflakies-maven-plugin:2.0.0:detect -Ddetector.detector_type=random-class-method -Ddt.randomize.rounds=10 -Ddt.detector.original_order.all_must_pass=false`
    );
    const flakyLists = JSON.parse(
        await fs.readFile(
            fullModulePath +
                "/.dtfixingtools/detection-results/flaky-lists.json",
            "utf-8"
        )
    ) as { dts: { name: string; type: "OD" | "NOD" }[] };
    for (const flaky of flakyLists.dts) {
        if (flaky.name === qualifiedTestName.replace("#", ".")) {
            detections.push("iDFl-" + flaky.type);
        }
    }
}

export async function detectNonDex(
    { qualifiedTestName, fullModulePath }: DetectorInfo,
    detections: string[]
) {
    try {
        const result = await exec(
            `cd ${fullModulePath} && mvn edu.illinois:nondex-maven-plugin:2.1.7:nondex -Dtest=${qualifiedTestName}`
        );
        if (qualifiedTestName.includes("testGetAlphabet")) console.log(result);
    } catch (e) {
        // this is expected and is actually what we want
        const error = e as { stdout: string; stderr: string };

        const isNonDexError =
            error.stdout.includes(
                "Unable to execute mojo: There are test failures."
            ) &&
            !error.stdout.includes(
                "Error occurred in starting fork, check output in log"
            );

        if (isNonDexError) {
            detections.push("NonDex");
        } else {
            console.error(error);
        }
    }
}

// Section 2.3.1 Isolation in Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function detectIsolation(
    { qualifiedTestName, projectPath, pl }: DetectorInfo,
    detections: string[]
) {
    let results;
    let reportIfFail = false;
    try {
        results = await exec(
            `cd ${projectPath} && mvn test -Dmaven.ext.class.path='/home/flakewatch/surefire-changing-maven-extension-1.0-SNAPSHOT.jar' -Dsurefire.runOrder=testorder -Dtest=${qualifiedTestName} -Dsurefire.rerunTestsCount=100 ${pl}`
        );
    } catch (e) {
        const error = e as { stdout: string; stderr: string };
        results = error;
        reportIfFail = true;
    }
    const flakyDetected = results.stdout.includes("[WARNING] Flakes:");
    if (flakyDetected) {
        detections.push("Isolation");
    } else if (reportIfFail) {
        console.error(results);
    }
}

// Section 2.3.2 One-By-One in Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function detectOneByOne(
    { qualifiedTestName, allTests, projectPath, pl }: DetectorInfo,
    detections: string[]
) {
    // run every test before qualifiedTestName
    for (const test of allTests) {
        if (test === qualifiedTestName) continue;
        const results = await exec(
            `cd ${projectPath} && mvn test -Dmaven.ext.class.path='/home/flakewatch/surefire-changing-maven-extension-1.0-SNAPSHOT.jar' -Dsurefire.runOrder=testorder -Dtest=${test},${qualifiedTestName} ${pl}`
        );

        const flakyDetected = results.stdout.includes("FAILURE!");
        if (flakyDetected) {
            detections.push("OBO");
            break;
        }
    }
}
