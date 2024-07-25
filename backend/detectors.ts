import util from "util";
import { exec as execC } from "child_process";
import type { FlakyCategory, ProjectInfo } from "./shared.js";
import type { ModuleCommitInfo } from "./moduledetectors.js";
import {
    createTimeoutFunction,
    md5,
    run,
    type DetectorRun as DetectorRun,
} from "./runutils.js";
import fs from "fs/promises";
import { categorize } from "./categorize.js";
import { XMLParser } from "fast-xml-parser";

const NUM_DETECTORS = 3;
const MIN_DETECTOR_SEC = 30;
const NONDEX_FAILURE_RERUN_COUNT = 5;
const OBO_FAILURE_RERUN_COUNT = 4;

export const exec = util.promisify(execC);

export type DetectorInfo = {
    qualifiedTestName: string;
    fullModulePath: string;
    projectPath: string;
    module: string;
    allTests: string[];
    pl: string;
    className: string;
    timeoutSecs: number;
};

// based on page 12 of Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function runDetectors({
    qualifiedTestName,
    projectPath,
    module,
    project,
    moduleCommitInfo,
    commitSha,
    minsAllowed,
}: {
    qualifiedTestName: string;
    projectPath: string;
    module: string;
    project: ProjectInfo;
    moduleCommitInfo: ModuleCommitInfo;
    commitSha: string;
    minsAllowed: number;
}): Promise<{ category: FlakyCategory | undefined }> {
    const fullModulePath = module ? projectPath + "/" + module : projectPath;
    const pl = module ? `-pl ${module}` : "";

    const detectorInfo = {
        qualifiedTestName,
        projectPath,
        fullModulePath,
        module,
        allTests: moduleCommitInfo.allTests,
        pl,
        className: qualifiedTestName.split("#")[0]!,
        timeoutSecs: 0,
    } satisfies DetectorInfo;

    const getTimeout = createTimeoutFunction(
        minsAllowed,
        NUM_DETECTORS,
        MIN_DETECTOR_SEC
    );

    console.log(" - " + qualifiedTestName + " in " + fullModulePath);

    const detectorRuns: DetectorRun[] =
        moduleCommitInfo.detectorRuns.get(qualifiedTestName) ?? [];

    await run(() =>
        detectIsolation(
            { ...detectorInfo, timeoutSecs: getTimeout(0) },
            detectorRuns
        )
    );
    console.log(" --- Finished isolation.");
    await run(() =>
        detectOneByOne(
            { ...detectorInfo, timeoutSecs: getTimeout(1) },
            detectorRuns
        )
    );
    console.log(" --- Finished OBO.");
    await run(() =>
        detectNonDex(
            { ...detectorInfo, timeoutSecs: getTimeout(2) },
            detectorRuns
        )
    );
    console.log(" --- Finished NonDex");

    const category = await categorize(
        qualifiedTestName,
        detectorRuns,
        commitSha
    );

    return { category };
}

export async function detectNonDex(
    detectorInfo: DetectorInfo,
    detectorRuns: DetectorRun[],
    rerunSeed = ""
) {
    const { qualifiedTestName, fullModulePath, timeoutSecs } = detectorInfo;
    // TODO: reruns don't follow timeouts & may take up too much time with brittle tests (50 runs guaranteed)
    const nondexOpts = rerunSeed
        ? `-DnondexSeed=${rerunSeed} -DnondexRerun=true -DnondexRuns=${NONDEX_FAILURE_RERUN_COUNT}`
        : "-DnondexRuns=10";
    try {
        try {
            await exec(
                `cd ${fullModulePath} && timeout ${timeoutSecs} mvn edu.illinois:nondex-maven-plugin:2.1.7:nondex -Dtest=${qualifiedTestName} -DnondexMode=ONE ${nondexOpts} -B`
            );
        } catch (e) {
            // this will happen if A) something went wrong or B) nondex detected a failure
            // let's check if it is a NonDex error or if the tool failed
            const error = e as { stdout: string; stderr: string; code: number };

            const isNonDexError =
                error.stdout.includes(
                    "Unable to execute mojo: There are test failures."
                ) &&
                !error.stdout.includes(
                    "Error occurred in starting fork, check output in log"
                );

            if (error.code === 124 || !isNonDexError) {
                // 124 means time ran out, which is fine
                throw e;
            }
        }

        const files = await fs.readdir(fullModulePath + "/.nondex", {
            withFileTypes: true,
        });
        for (const file of files) {
            if (file.isDirectory()) {
                const [failuresFile, configFile] = await Promise.all([
                    fs.readFile(
                        `${fullModulePath}/.nondex/${file.name}/failures`,
                        "utf-8"
                    ),
                    fs.readFile(
                        `${fullModulePath}/.nondex/${file.name}/config`,
                        "utf-8"
                    ),
                ]);

                const seedIndex = configFile.indexOf("nondexSeed=" + 11);
                const nondexSeed = configFile.slice(
                    seedIndex,
                    configFile.indexOf("\n", seedIndex)
                );

                const passed = failuresFile.length > 0;

                detectorRuns.push({
                    passed,
                    prefixMd5: "",
                    test: qualifiedTestName,
                    tool: "NonDex",
                    log: nondexSeed,
                });

                if (!passed && !rerunSeed) {
                    detectNonDex(detectorInfo, detectorRuns, nondexSeed);
                }
            }
        }
    } finally {
        await exec(`rm -rf ${fullModulePath}/.nondex`);
    }
}

// Section 2.3.1 Isolation in Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
const xmlParser = new XMLParser();
export async function detectIsolation(
    {
        qualifiedTestName,
        projectPath,
        pl,
        fullModulePath,
        className,
    }: DetectorInfo,
    detectorRuns: DetectorRun[]
) {
    const reruns = 99; // TODO: can we vary if this is a long-running test?
    await exec(
        `cd ${projectPath} && mvn test -Dmaven.ext.class.path='/home/flakewatch/surefire-changing-maven-extension-1.0-SNAPSHOT.jar' -Dsurefire.runOrder=testorder -Dtest=${qualifiedTestName} -Dsurefire.rerunTestsCount=${reruns} ${pl} -B`
    );

    const testXml = await fs.readFile(
        `${fullModulePath}/target/surefire-reports/TEST-${className}.xml`,
        "utf-8"
    );

    const flakyFailure = xmlParser.parse(testXml).testclass.testcase
        .flakyFailure as { stackTrace: string }[] | undefined;

    if (flakyFailure) {
        for (const { stackTrace } of flakyFailure) {
            detectorRuns.push({
                passed: false,
                prefixMd5: "",
                test: qualifiedTestName,
                tool: "Isolation",
                log: stackTrace,
            });
        }
    }
    for (let i = 0; i < reruns + 1 - (flakyFailure?.length ?? 0); i++) {
        detectorRuns.push({
            passed: true,
            prefixMd5: "",
            test: qualifiedTestName,
            tool: "Isolation",
            log: "",
        });
    }
}

// Section 2.3.2 One-By-One in Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export async function detectOneByOne(
    {
        qualifiedTestName,
        allTests,
        projectPath,
        pl,
        fullModulePath,
        className,
    }: DetectorInfo,
    detectorRuns: DetectorRun[]
) {
    // run every test before qualifiedTestName
    for (const test of allTests) {
        if (test === qualifiedTestName) continue;

        await exec(
            `cd ${projectPath} && mvn test -Dmaven.ext.class.path='/home/flakewatch/surefire-changing-maven-extension-1.0-SNAPSHOT.jar' -Dsurefire.runOrder=testorder -Dtest=${test},${qualifiedTestName} -Dsurefire.rerunFailingTestsCount=${OBO_FAILURE_RERUN_COUNT} -Dmaven.test.failure.ignore=true ${pl} -B`
        );

        const prefixMd5 = md5(test + qualifiedTestName);

        const testXml = await fs.readFile(
            `${fullModulePath}/target/surefire-reports/TEST-${className}.xml`,
            "utf-8"
        );
        const result =
            (xmlParser.parse(testXml).testclass.testcase[1] as
                | {
                      failure: string;
                      rerunFailure: { stackTrace: string }[] | undefined;
                  }
                | "") || undefined;

        if (!result) {
            detectorRuns.push({
                passed: true,
                prefixMd5,
                test: qualifiedTestName,
                tool: "OBO",
                log: test + " run first",
            });
            continue;
        }

        detectorRuns.push({
            passed: false,
            prefixMd5,
            test: qualifiedTestName,
            tool: "OBO",
            log: test + " run first. failure: " + result.failure,
        });

        if (result.rerunFailure) {
            for (const { stackTrace } of result.rerunFailure) {
                detectorRuns.push({
                    passed: false,
                    prefixMd5,
                    test: qualifiedTestName,
                    tool: "OBO",
                    log: stackTrace,
                });
            }
        }
    }
}
