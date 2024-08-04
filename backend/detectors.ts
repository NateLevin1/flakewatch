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

const xmlParser = new XMLParser();
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

type StackTraceObj = { stackTrace: string };

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

    const category = await categorize({
        qualifiedTestName,
        detectorRuns,
        commitSha,
        fullModulePath,
    });

    // cleanup
    await exec(`rm -rf /tmp/*-logs`);

    return { category };
}

export async function detectNonDex(
    detectorInfo: DetectorInfo,
    detectorRuns: DetectorRun[],
    rerunSeed = ""
) {
    const { qualifiedTestName, fullModulePath, timeoutSecs } = detectorInfo;
    const nondexDir = fullModulePath + "/.nondex";
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
            // 124 means time ran out
            if (error.code === 124) {
                console.log(
                    " --- NonDex ran out of time (given " + timeoutSecs + "s)"
                );
            } else {
                if (!error.stdout.includes("There are test failures.")) throw e;
            }
        }

        const files = await fs.readdir(nondexDir, {
            withFileTypes: true,
        });
        const filesWithCreationTime = await Promise.all(
            files.map(async (file) => ({
                file,
                creationTime: (
                    await fs.stat(`${nondexDir}/${file.name}`)
                ).birthtimeMs,
            }))
        );
        const orderedFiles = filesWithCreationTime
            .sort((a, b) => a.creationTime - b.creationTime)
            .map((f) => f.file);

        const reruns: string[] = [];
        for (const file of orderedFiles) {
            if (file.isDirectory()) {
                if (file.name.startsWith("clean_")) continue;

                let infoFiles;
                try {
                    infoFiles = await Promise.all([
                        fs.readFile(
                            `${nondexDir}/${file.name}/failures`,
                            "utf-8"
                        ),
                        fs.readFile(
                            `${nondexDir}/${file.name}/config`,
                            "utf-8"
                        ),
                    ]);
                } catch (e) {
                    continue; // possible, if interrupted/similar
                }
                const [failuresFile, configFile] = infoFiles;

                const seedIndex = configFile.indexOf("nondexSeed=") + 11;
                const nondexSeed = configFile.slice(
                    seedIndex,
                    configFile.indexOf("\n", seedIndex)
                );

                const passed = failuresFile.length == 0;

                let failure: string | undefined = undefined;
                if (!passed) {
                    const className = qualifiedTestName.split("#")[0];
                    const xml = xmlParser.parse(
                        await fs.readFile(
                            `${nondexDir}/${file.name}/TEST-${className}.xml`,
                            "utf-8"
                        )
                    );
                    const fullFailure = xml.testsuite.testcase.failure;
                    failure = md5(
                        fullFailure.slice(0, fullFailure.indexOf("\n"))
                    );
                }

                detectorRuns.push({
                    passed,
                    prefixMd5: "",
                    test: qualifiedTestName,
                    tool: "NonDex",
                    failure,
                    log: nondexSeed,
                });

                if (!passed && !rerunSeed) {
                    reruns.push(nondexSeed);
                }
            }
        }

        await exec(
            `mkdir -p /tmp/nondex-logs && cp -r ${nondexDir} /tmp/nondex-logs/nondex${
                rerunSeed ? "-" + rerunSeed : ""
            } && rm -rf ${nondexDir}`
        );
        for (const seed of reruns) {
            await detectNonDex(detectorInfo, detectorRuns, seed);
        }
    } finally {
        await exec(`rm -rf ${nondexDir}`);
    }
}

const runRegex = /[R|O]\]   Run \d/g;
// Section 2.3.1 Isolation in Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
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
    const { stdout: output } = await exec(
        `cd ${projectPath} && mvn test -Dmaven.ext.class.path='/home/flakewatch/surefire-changing-maven-extension-1.0-SNAPSHOT.jar' -Dsurefire.runOrder=testorder -Dtest=${qualifiedTestName} -Dsurefire.rerunTestsCount=${reruns} ${pl} -B`
    );

    const reportPath = `${fullModulePath}/target/surefire-reports/TEST-${className}.xml`;
    const testXml = await fs.readFile(reportPath, "utf-8");

    await exec(
        `mkdir -p /tmp/isolation-logs && cp ${reportPath} /tmp/isolation-logs/report.xml`
    );
    await fs.writeFile("/tmp/isolation-logs/output.log", output);

    const flakyFailures = toArray(
        xmlParser.parse(testXml).testclass.testcase.flakyFailure as
            | StackTraceObj
            | StackTraceObj[]
            | undefined
    );

    const pushPass = () => {
        detectorRuns.push({
            passed: true,
            prefixMd5: "",
            test: qualifiedTestName,
            tool: "Isolation",
            failure: undefined,
            log: undefined,
        });
    };

    if (flakyFailures) {
        const runs = output.match(runRegex)!;
        let failureIndex = 0;
        for (const run of runs) {
            if (run[0] === "R") {
                // ERRO(R)
                const { stackTrace } = flakyFailures[failureIndex]!;
                detectorRuns.push({
                    passed: false,
                    prefixMd5: "",
                    test: qualifiedTestName,
                    tool: "Isolation",
                    failure: md5(stackTrace.slice(0, stackTrace.indexOf("\n"))),
                    log: undefined,
                });
                failureIndex += 1;
            } else {
                // INF(O)
                pushPass();
            }
        }
    } else {
        for (let i = 0; i < reruns + 1; i++) {
            pushPass();
        }
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

        const { stdout: output } = await exec(
            `cd ${projectPath} && mvn test -Dmaven.ext.class.path='/home/flakewatch/surefire-changing-maven-extension-1.0-SNAPSHOT.jar' -Dsurefire.runOrder=testorder -Dtest=${test},${qualifiedTestName} -Dsurefire.rerunFailingTestsCount=${OBO_FAILURE_RERUN_COUNT} ${pl} -B`
        );

        const prefixMd5 = md5(test + qualifiedTestName);

        const reportPath = `${fullModulePath}/target/surefire-reports/TEST-${className}.xml`;
        const testXml = await fs.readFile(reportPath, "utf-8");

        const cleanTest = test.replaceAll(".", "-");
        await exec(
            `mkdir -p /tmp/obo-logs && cp ${reportPath} /tmp/obo-logs/${cleanTest}-report.xml`
        );
        await fs.writeFile(`/tmp/obo-logs/${cleanTest}-output.log`, output);

        type TestCaseType =
            | {
                  failure: string;
                  rerunFailure: StackTraceObj | StackTraceObj[] | undefined;
              }
            | {
                  flakyFailure: StackTraceObj | StackTraceObj[];
              }
            | "";
        const testcase = toArray(
            (xmlParser.parse(testXml).testclass.testcase as
                | TestCaseType
                | TestCaseType[]
                | "") || undefined
        );
        const result =
            testcase && (testcase.length === 1 ? testcase[0]! : testcase[1]!);

        if (!testcase || !result) {
            detectorRuns.push({
                passed: true,
                prefixMd5,
                test: qualifiedTestName,
                tool: "OBO",
                failure: undefined,
                log: test,
            });
            continue;
        }

        if ("failure" in result) {
            const failure = result.failure;
            detectorRuns.push({
                passed: false,
                prefixMd5,
                test: qualifiedTestName,
                tool: "OBO",
                failure: md5(failure.slice(0, failure.indexOf("\n"))),
                log: test,
            });
        }

        const stackTraces = toArray(
            "rerunFailure" in result ? result.rerunFailure : result.flakyFailure
        );
        if (stackTraces) {
            for (const { stackTrace } of stackTraces) {
                detectorRuns.push({
                    passed: false,
                    prefixMd5,
                    test: qualifiedTestName,
                    tool: "OBO",
                    failure: md5(stackTrace.slice(0, stackTrace.indexOf("\n"))),
                    log: test,
                });
            }
        }
    }
}

function toArray<T>(obj: T | T[] | undefined): T[] | undefined {
    if (!obj) return undefined;
    return Array.isArray(obj) ? obj : [obj];
}
