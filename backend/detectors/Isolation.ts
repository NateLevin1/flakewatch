import type { DetectorInfo, StackTraceObj } from "../detectors.js";
import { exec, md5, toArray, type DetectorRun } from "../runutils.js";
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
    const reruns = 99; // TODO: can we vary if this is a long-running test?
    const { stdout: output } = await exec(
        `cd ${projectPath} && mvn test -Dmaven.ext.class.path="/home/flakewatch/surefire-changing-maven-extension-1.0-SNAPSHOT.jar" -Dsurefire.runOrder=testorder -Dtest=${qualifiedTestName} -Dsurefire.rerunTestsCount=${reruns} ${pl} -B`
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
