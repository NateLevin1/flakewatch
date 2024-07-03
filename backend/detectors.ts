import util from "util";
import { exec as execC } from "child_process";
import fs from "fs/promises";
import AdmZip from "adm-zip";
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

type ReportFn = (detection: DetectionCause, logs?: string) => void;

// based on page 12 of Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function runDetectors(
    qualifiedTestName: string,
    projectPath: string,
    module: string,
    project: ProjectInfo,
    commitSha: string
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
    let logFiles: { cause: DetectionCause; content: string }[] = [];

    const report: ReportFn = (detection: DetectionCause, logs?: string) => {
        if (!detections.includes(detection)) {
            detections.push(detection);
            if (logs) logFiles.push({ cause: detection, content: logs });
        }
    };

    await run(async () => await detectIDFlakies(detectorInfo, report));
    await run(async () => await detectNonDex(detectorInfo, report));
    await run(async () => await detectIsolation(detectorInfo, report));
    await run(async () => await detectOneByOne(detectorInfo, report));

    if (detections.length > 0) {
        console.log(
            project.name +
                ": " +
                qualifiedTestName +
                " is flaky. Reason(s): " +
                detections.join(", ")
        );

        const zip = new AdmZip();
        for (const { cause, content } of logFiles) {
            zip.addFile(cause + ".log", Buffer.from(content));
        }
        const hash = commitSha.slice(0, 7);
        const testName = qualifiedTestName.replaceAll(".", "-");
        await zip.writeZipPromise(
            `/home/flakewatch/failure-logs/${testName}-${hash}.zip`
        );
    }

    return detections;
}

export async function detectIDFlakies(
    { qualifiedTestName, fullModulePath }: DetectorInfo,
    report: ReportFn
) {
    const timeout = 60 * 1000; // TODO: vary by # of tests detected
    await exec(
        `cd ${fullModulePath} && mvn edu.illinois.cs:idflakies-maven-plugin:2.0.0:detect -Ddetector.detector_type=random-class-method -Ddt.detector.original_order.all_must_pass=false -Ddetector.timeout=${timeout}`
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
            report(
                ("iDFl-" + flaky.type) as DetectionCause,
                JSON.stringify(flaky, null, 2)
            );
        }
    }
}

export async function detectNonDex(
    { qualifiedTestName, fullModulePath }: DetectorInfo,
    report: ReportFn
) {
    const runs = 9; // TODO: vary by # of tests detected (default is 3)
    try {
        const result = await exec(
            `cd ${fullModulePath} && mvn edu.illinois:nondex-maven-plugin:2.1.7:nondex -Dtest=${qualifiedTestName} -DnondexRuns=${100} -B`
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
            report("NonDex", error.stdout);
        } else {
            throw e;
        }
    }
}

// Section 2.3.1 Isolation in Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function detectIsolation(
    { qualifiedTestName, projectPath, pl }: DetectorInfo,
    report: ReportFn
) {
    let results;
    let reportIfFail = false;
    const runs = 100; // TODO: vary by # of tests detected
    try {
        results = await exec(
            `cd ${projectPath} && mvn test -Dmaven.ext.class.path='/home/flakewatch/surefire-changing-maven-extension-1.0-SNAPSHOT.jar' -Dsurefire.runOrder=testorder -Dtest=${qualifiedTestName} -Dsurefire.rerunTestsCount=${runs} ${pl} -B`
        );
    } catch (e) {
        const error = e as { stdout: string; stderr: string };
        results = error;
        reportIfFail = true;
    }
    const flakyDetected = results.stdout.includes("[WARNING] Flakes:");
    if (flakyDetected) {
        report("Isolation", results.stdout);
    } else if (reportIfFail) {
        throw results;
    }
}

// Section 2.3.2 One-By-One in Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function detectOneByOne(
    { qualifiedTestName, allTests, projectPath, pl }: DetectorInfo,
    report: ReportFn
) {
    // run every test before qualifiedTestName
    for (const test of allTests) {
        if (test === qualifiedTestName) continue;
        const results = await exec(
            `cd ${projectPath} && mvn test -Dmaven.ext.class.path='/home/flakewatch/surefire-changing-maven-extension-1.0-SNAPSHOT.jar' -Dsurefire.runOrder=testorder -Dtest=${test},${qualifiedTestName} ${pl} -B`
        );

        const flakyDetected = results.stdout.includes("FAILURE!");
        if (flakyDetected) {
            report(
                "OBO",
                "order: " +
                    test +
                    "," +
                    qualifiedTestName +
                    "\n\n\n" +
                    results.stdout
            );
            break;
        }
    }
}
