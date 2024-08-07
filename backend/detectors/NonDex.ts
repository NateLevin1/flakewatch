import type { DetectorInfo } from "../detectors.js";
import { exec, execTimeout, md5, type DetectorRun } from "../runutils.js";
import fs from "fs/promises";
import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser();

const NONDEX_FAILURE_RERUN_COUNT = 5;

export default async function detectNonDex(
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
        await execTimeout(
            `cd ${fullModulePath} && mvn edu.illinois:nondex-maven-plugin:2.1.7:nondex -Dtest=${qualifiedTestName} -DnondexMode=ONE ${nondexOpts} -B`,
            timeoutSecs,
            "There are test failures."
        );

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
        let isBrittleMode = false;
        for (const file of orderedFiles) {
            if (file.isDirectory()) {
                if (file.name.startsWith("clean_")) {
                    const failuresFile = await fs.readFile(
                        `${nondexDir}/${file.name}/failures`,
                        "utf-8"
                    );
                    if (failuresFile.length > 0) {
                        // NonDex is in "brittle" mode. It will invert the `failures` file
                        // meaning, it will have len > 0 only if the test passes
                        isBrittleMode = true;
                    }
                    continue;
                }

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

                const failuresEmpty = failuresFile.length == 0;
                const passed = isBrittleMode ? !failuresEmpty : failuresEmpty;

                let failure: string | undefined = undefined;
                if (!passed) {
                    const xml = xmlParser.parse(
                        await fs.readFile(
                            `${nondexDir}/${file.name}/TEST-${detectorInfo.className}.xml`,
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
