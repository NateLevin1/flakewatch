import AdmZip from "adm-zip";
import { exec } from "./runutils.js";
import fs from "fs/promises";
import type { DetectorRun } from "./runutils.js";
import type { FlakyCategory } from "./shared.js";

const escape = (str: string) =>
    str.replaceAll("\n", "\\n").replaceAll(",", " ");

export async function categorize({
    qualifiedTestName,
    detectorRuns,
    commitSha,
    fullModulePath,
}: {
    qualifiedTestName: string;
    detectorRuns: DetectorRun[];
    commitSha: string;
    fullModulePath: string;
}): Promise<FlakyCategory | undefined> {
    // if this file gets too large, we may want to write it gzipped
    const detectorRunsCsv =
        "test,prefix_md5,tool,status,failure_md5,log\n" +
        detectorRuns
            .map(({ test, passed, prefixMd5, tool, log, failure }) => {
                const status = passed ? "pass" : "fail";
                return [
                    test,
                    prefixMd5,
                    tool,
                    status,
                    failure ? escape(failure) : "",
                    log ? escape(log) : "",
                ].join(",");
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
        await addLocalFolderToZip(
            fullModulePath + "/.dtfixingtools/",
            "idflakies",
            zip
        );
        const tmpFiles = await fs.readdir("/tmp/", { withFileTypes: true });
        for (const file of tmpFiles) {
            if (file.isDirectory() && file.name.endsWith("-logs")) {
                await addLocalFolderToZip(
                    `/tmp/${file.name}/`,
                    file.name.replace("-logs", ""),
                    zip
                );
            }
        }
        const hash = commitSha.slice(0, 7);
        const testName = qualifiedTestName.replaceAll(".", "-");
        const date = new Date().toISOString().slice(0, 10);
        await zip.writeZipPromise(
            `/home/flakewatch/failure-logs/${testName}-${date}-${hash}.zip`
        );
    }

    return category || undefined;
}

function addLocalFolderToZip(localPath: string, folder: string, zip: AdmZip) {
    return new Promise((res, rej) =>
        zip.addLocalFolderAsync(
            localPath,
            (success, err) => (err ? rej(err) : res(success)),
            "logs/" + folder + "/"
        )
    );
}
