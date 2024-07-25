import AdmZip from "adm-zip";
import { exec } from "./detectors.js";
import fs from "fs/promises";
import type { DetectorRun } from "./runutils.js";
import type { FlakyCategory } from "./shared.js";

export async function categorize(
    qualifiedTestName: string,
    detectorRuns: DetectorRun[],
    commitSha: string
): Promise<FlakyCategory | undefined> {
    // if this file gets too large, we may want to write it gzipped
    const detectorRunsCsv = detectorRuns
        .map(({ test, passed, prefixMd5, tool, log }) => {
            const status = passed ? "pass" : "fail";
            return `${test},${prefixMd5},${tool},${status},${log
                .replaceAll("\n", "\\n")
                .replaceAll(",", " ")}`;
        })
        .join("\n");
    await fs.writeFile("/tmp/detectorRuns.csv", detectorRunsCsv);

    const { stdout } = await exec(
        `python3 /home/flakewatch/flakewatch/backend/scripts/categorizeflaky.py /tmp/detectorRuns.csv`
    );

    const category = JSON.parse(stdout.trim())[qualifiedTestName];

    if (category) {
        console.log("[!] " + qualifiedTestName + " is flaky: " + category);

        const zip = new AdmZip();
        zip.addFile("detectorRuns.csv", Buffer.from(detectorRunsCsv));
        const hash = commitSha.slice(0, 7);
        const testName = qualifiedTestName.replaceAll(".", "-");
        await zip.writeZipPromise(
            `/home/flakewatch/failure-logs/${testName}-${hash}.zip`
        );
    }

    return category || undefined;
}
