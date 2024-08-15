import type {
    DetectorInfo,
    StackTraceObj,
    TestCaseType,
} from "../detectors.js";
import {
    exec,
    md5,
    toArray,
    writeDetectorError,
    type DetectorRun,
} from "../runutils.js";
import fs from "fs/promises";
import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser();

const runRegex = /[R|O]\]   Run \d/g;
// Section 2.3.1 Isolation in Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export default async function detectIsolation(
    {
        qualifiedTestName,
        projectPath,
        pl,
        fullModulePath,
        className,
    }: DetectorInfo,
    detectorRuns: DetectorRun[]
) {
    // * ### Step 1: Run the test 100 times using the Surefire plugin
    const reruns = 99; // FIXME: can we vary if this is a long-running test?
    const { stdout: output } = await exec(
        `cd ${projectPath} && mvn test -Dmaven.ext.class.path="/home/flakewatch/surefire-changing-maven-extension-1.0-SNAPSHOT.jar" -Dsurefire.runOrder=testorder -Dtest=${qualifiedTestName} -Dsurefire.rerunTestsCount=${reruns} ${pl} -B`
    );

    // * ### Step 2: Read the test results
    const reportPath = `${fullModulePath}/target/surefire-reports/TEST-${className}.xml`;
    const testXml = await fs.readFile(reportPath, "utf-8");

    // * ### Step 3: Save the logs. Note that /tmp/*-logs will be included in failure logs, and will all be auto-deleted after each test
    await exec(
        `mkdir -p /tmp/isolation-logs && cp ${reportPath} /tmp/isolation-logs/report.xml`
    );
    await fs.writeFile("/tmp/isolation-logs/output.log", output);

    // * ### Step 4: Parse the test results
    const testCase =
        (xmlParser.parse(testXml).testclass.testcase as TestCaseType) ||
        undefined;

    // * ### Step 5: Save the detector runs, depending on pass/fail status

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
    const pushFail = (stackTrace: string) => {
        detectorRuns.push({
            passed: false,
            prefixMd5: "",
            test: qualifiedTestName,
            tool: "Isolation",
            failure: md5(stackTrace.slice(0, stackTrace.indexOf("\n"))),
            log: undefined,
        });
    };

    if (testCase) {
        let failures: StackTraceObj[] = [];
        if ("flakyFailure" in testCase) {
            failures = toArray(testCase.flakyFailure)!;
        } else {
            failures = [
                { stackTrace: testCase.failure },
                ...(toArray(testCase.rerunFailure) || []),
            ];
        }
        const runs = output.match(runRegex);
        if (runs) {
            let failureIndex = 0;
            for (const run of runs) {
                if (run[0] === "R") {
                    // ERRO(R)
                    const { stackTrace } = failures[failureIndex]!;
                    pushFail(stackTrace);
                    failureIndex += 1;
                } else {
                    // INF(O)
                    pushPass();
                }
            }
        } else {
            for (const { stackTrace } of failures) {
                pushFail(stackTrace);
            }
            for (let i = 0; i < reruns + 1 - failures.length; i++) {
                pushPass();
            }
            const warning =
                "No runs found in Isolation output - order of failures unknown.";
            console.warn(warning);
            await writeDetectorError({
                message: warning,
                stdout: output,
                testXml,
            });
        }
    } else {
        for (let i = 0; i < reruns + 1; i++) {
            pushPass();
        }
    }
}
