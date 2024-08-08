import type { DetectorInfo, TestCaseType } from "../detectors.js";
import { exec, md5, toArray, type DetectorRun } from "../runutils.js";
import fs from "fs/promises";
import { XMLParser } from "fast-xml-parser";

const OBO_FAILURE_RERUN_COUNT = 4;

const xmlParser = new XMLParser();
// Section 2.3.2 One-By-One in Lam et al https://cs.gmu.edu/~winglam/publications/2020/LamETAL20OOPSLA.pdf
export default async function detectOneByOne(
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
            `cd ${projectPath} && mvn test -Dmaven.ext.class.path="/home/flakewatch/surefire-changing-maven-extension-1.0-SNAPSHOT.jar" -Dsurefire.runOrder=testorder -Dtest=${test},${qualifiedTestName} -Dsurefire.rerunFailingTestsCount=${OBO_FAILURE_RERUN_COUNT} ${pl} -B`
        );

        const prefixMd5 = md5(test + qualifiedTestName);

        const reportPath = `${fullModulePath}/target/surefire-reports/TEST-${className}.xml`;
        const testXml = await fs.readFile(reportPath, "utf-8");

        const cleanTest = test.replaceAll(".", "-");
        await exec(
            `mkdir -p /tmp/obo-logs && cp ${reportPath} /tmp/obo-logs/${cleanTest}-report.xml`
        );
        await fs.writeFile(`/tmp/obo-logs/${cleanTest}-output.log`, output);

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
