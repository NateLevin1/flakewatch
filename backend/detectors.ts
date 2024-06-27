import util from "util";
import { exec as execC } from "child_process";
import fs from "fs/promises";
import { type Project, config } from "./config.js";

const exec = util.promisify(execC);

export type DetectorInfo = {
    qualifiedTestName: string;
    fullModulePath: string;
    projectPath: string;
    module: string;
    allTests: string[];
    path: string;
    pl: string;
};

export type DetectionCause = "NonDex" | "Isolation" | "OBO";

// TODO: base on page 12 of Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function runDetectors(
    qualifiedTestName: string,
    projectPath: string,
    module: string,
    project: Project
) {
    const fullModulePath = projectPath + "/" + module;

    const testArgs = project.mvnTestArgs ?? "";
    const pl = module ? `-pl ${module}` : "";
    const path = module ? fullModulePath : projectPath;

    // we run `mvn test` and parse its output to get the list of all tests
    await exec(`cd ${path} && rm -rf target/surefire-reports`);
    await exec(
        `cd ${path} && mvn test ${pl} ${testArgs} -DskipITs -Dmaven.test.failure.ignore=true -DtestFailureIgnore=true`
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
        path,
        pl,
    } satisfies DetectorInfo;

    const detections: DetectionCause[] = [];

    (
        await Promise.allSettled([
            // detectIDFlakies(detectorInfo, detections);
            detectNonDex(detectorInfo, detections),
            detectIsolation(detectorInfo, detections),
            detectOneByOne(detectorInfo, detections),
        ])
    ).forEach((result) => {
        if (result.status === "rejected") {
            console.error(result.reason);
        }
    });

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
    );
}

export async function detectNonDex(
    { qualifiedTestName, path }: DetectorInfo,
    detections: string[]
) {
    try {
        const result = await exec(
            `cd ${path} && mvn edu.illinois:nondex-maven-plugin:2.1.7:nondex -Dtest=${qualifiedTestName}`
        );
        if (qualifiedTestName.includes("testGetAlphabet")) console.log(result);
    } catch (e) {
        // this is expected and is actually what we want
        const error = e as { stdout: string; stderr: string };

        const isNonDexError = error.stdout.includes(
            "Unable to execute mojo: There are test failures."
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
    { qualifiedTestName, path, pl }: DetectorInfo,
    detections: string[]
) {
    const results = await exec(
        `cd ${path} && mvn test -Dmaven.ext.class.path=${config.mavenSurefireExtPath} -Dsurefire.runOrder=testorder -Dtest=${qualifiedTestName} -Dsurefire.rerunTestsCount=100 ${pl}`
    );
    const flakyDetected = results.stdout.includes("[WARNING] Flakes:");
    if (flakyDetected) {
        detections.push("Isolation");
    }
}

// Section 2.3.2 One-By-One in Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function detectOneByOne(
    { qualifiedTestName, allTests, path, pl }: DetectorInfo,
    detections: string[]
) {
    // run every test before qualifiedTestName
    for (const test of allTests) {
        if (test === qualifiedTestName) continue;
        const results = await exec(
            `cd ${path} && mvn test -Dmaven.ext.class.path=${config.mavenSurefireExtPath} -Dsurefire.runOrder=testorder -Dtest=${test},${qualifiedTestName} ${pl}`
        );

        const flakyDetected = results.stdout.includes("FAILURE!");
        if (flakyDetected) {
            detections.push("OBO");
            break;
        }
    }
}
