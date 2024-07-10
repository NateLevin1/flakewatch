import util from "util";
import { exec as execC } from "child_process";
import AdmZip from "adm-zip";
import type { DetectionCause, ProjectInfo } from "./shared.js";
import type { ModuleCommitInfo } from "./moduledetectors.js";

export const exec = util.promisify(execC);

export type DetectorInfo = {
    qualifiedTestName: string;
    fullModulePath: string;
    projectPath: string;
    module: string;
    allTests: string[];
    pl: string;
};

const run = async <T>(fn: () => Promise<T>) => {
    try {
        return await fn();
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
    moduleCommitInfo: ModuleCommitInfo,
    commitSha: string,
    minsAllowed: number
) {
    const startTime = Date.now();

    const fullModulePath = projectPath + "/" + module;
    const pl = module ? `-pl ${module}` : "";

    const detectorInfo = {
        qualifiedTestName,
        projectPath,
        fullModulePath,
        module,
        allTests: moduleCommitInfo.allTests,
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

    console.log(" - " + qualifiedTestName + " in " + fullModulePath);

    // we run isolation and OBO first, without regard for elapsed time
    // this is because we cannot split up OBO's runs, and we need failing info to run OBO.
    // luckily, these are the fastest detectors! so we can afford to run them first.
    const isFailing =
        (await run(
            async () => await detectIsolation(detectorInfo, commitSha, report)
        )) === "failing";
    if (isFailing) {
        console.log(qualifiedTestName + " is a failing test");
    }
    console.log(" --- Finished isolation.");
    await run(
        async () => await detectOneByOne(detectorInfo, isFailing, report)
    );
    console.log(" --- Finished OBO.");
    if (!isFailing) {
        const nonDexTimeoutMs =
            minsAllowed * 60 * 1000 - (Date.now() - startTime); // remaining time
        await run(
            async () =>
                await detectNonDex(detectorInfo, nonDexTimeoutMs, report)
        );
        console.log(
            " --- Finished NonDex (given " +
                Math.round(nonDexTimeoutMs / 1000) +
                "s)"
        );
    }

    for (const test of moduleCommitInfo.idFlakiesResults) {
        if (test.test !== qualifiedTestName) continue;
        report(`iDFl-${test.type}`, JSON.stringify(test));
        console.log(" --- Reported iDFlakies for " + test.type);
    }

    if (detections.length > 0) {
        console.log(
            "[!] " +
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

export async function detectNonDex(
    { qualifiedTestName, fullModulePath }: DetectorInfo,
    timeoutMs: number,
    report: ReportFn
) {
    const timeoutSecs = Math.round(timeoutMs / 1000);
    try {
        await exec(
            `cd ${fullModulePath} && timeout ${timeoutSecs} mvn edu.illinois:nondex-maven-plugin:2.1.7:nondex -Dtest=${qualifiedTestName} -DnondexRuns=10 -DnondexMode=ONE -B`
        );
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

const failureCountRegex = /Tests run: \d+, Failures: (\d+).+FAILURE!/;
// Section 2.3.1 Isolation in Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function detectIsolation(
    { qualifiedTestName, projectPath, pl }: DetectorInfo,
    commitSha: string,
    report: ReportFn
) {
    const reruns = 99; // TODO: can we vary if this is a long-running test?
    let results;
    let reportIfFail = false;
    try {
        results = await exec(
            `cd ${projectPath} && mvn test -Dmaven.ext.class.path='/home/flakewatch/surefire-changing-maven-extension-1.0-SNAPSHOT.jar' -Dsurefire.runOrder=testorder -Dtest=${qualifiedTestName} -Dsurefire.rerunTestsCount=${reruns} ${pl} -B`
        );
    } catch (e) {
        const error = e as { stdout: string; stderr: string };
        results = error;
        reportIfFail = true;
    }
    const flakyDetected = results.stdout.includes("[WARNING] Flakes:");
    const failureCount = Number(
        results.stdout.match(failureCountRegex)?.[1] ?? 0
    );

    if (failureCount >= reruns) {
        // this is a failing test, not a flaky test.
        const zip = new AdmZip();
        zip.addFile("isolation-failing.log", Buffer.from(results.stdout));
        const hash = commitSha.slice(0, 7);
        const testName = qualifiedTestName.replaceAll(".", "-");
        await zip.writeZipPromise(
            `/home/flakewatch/failure-logs/${testName}-${hash}.zip`
        );
        return "failing";
    }

    if (flakyDetected) {
        report(
            "Isolation",
            "failure-count: " + failureCount + "\n\n\n" + results.stdout
        );
    } else if (reportIfFail) {
        throw results;
    }
}

// Section 2.3.2 One-By-One in Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function detectOneByOne(
    { qualifiedTestName, allTests, projectPath, pl }: DetectorInfo,
    isFailing: boolean,
    report: ReportFn
) {
    // run every test before qualifiedTestName
    for (const test of allTests) {
        if (test === qualifiedTestName) continue;

        const initialResults = await exec(
            `cd ${projectPath} && mvn test -Dmaven.ext.class.path='/home/flakewatch/surefire-changing-maven-extension-1.0-SNAPSHOT.jar' -Dsurefire.runOrder=testorder -Dtest=${test},${qualifiedTestName} ${pl} -B`
        );
        const initiallyFailed = initialResults.stdout.includes("FAILURE!");
        if ((!isFailing && !initiallyFailed) || (isFailing && initiallyFailed))
            continue;

        const reruns = 4;
        const results = await exec(
            `cd ${projectPath} && mvn test -Dmaven.ext.class.path='/home/flakewatch/surefire-changing-maven-extension-1.0-SNAPSHOT.jar' -Dsurefire.runOrder=testorder -Dtest=${test},${qualifiedTestName} ${pl} -B -Dsurefire.rerunTestsCount=${reruns}`
        );

        const failureDetected = results.stdout.includes(
            "Failures: " + (reruns + 1)
        );
        if (failureDetected && !isFailing) {
            report(
                "OBO",
                "order: " +
                    test +
                    "," +
                    qualifiedTestName +
                    "\n\n\n" +
                    results.stdout
            );
        } else if (isFailing && results.stdout.includes("Failures: 0")) {
            report(
                "OBO-Brit",
                "order: " +
                    test +
                    "," +
                    qualifiedTestName +
                    "\n\n\n" +
                    results.stdout
            );
        }
    }
}
