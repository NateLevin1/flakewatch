import type { FlakyCategory, ProjectInfo } from "./shared.js";
import type { ModuleCommitInfo } from "./moduledetectors.js";
import {
    createTimeoutFunction,
    exec,
    run,
    type DetectorRun as DetectorRun,
} from "./runutils.js";
import fs from "fs/promises";
import { categorize } from "./categorize.js";

const MIN_DETECTOR_SEC = 30;

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

export type StackTraceObj = { stackTrace: string };

let detectors:
    | {
          name: string;
          run: (info: DetectorInfo, runs: DetectorRun[]) => Promise<void>;
      }[] = await (async () => {
    const files = await fs.readdir(import.meta.dirname + "/detectors");
    return Promise.all(
        files.map(async (file) => {
            const { default: run } = await import(
                import.meta.dirname + "/detectors/" + file
            );
            return { name: file.split(".")[0]!, run };
        })
    );
})();

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
        detectors.length,
        MIN_DETECTOR_SEC
    );

    console.log(" - " + qualifiedTestName + " in " + fullModulePath);

    const detectorRuns: DetectorRun[] =
        moduleCommitInfo.detectorRuns.get(qualifiedTestName) ?? [];

    for (let i = 0; i < detectors.length; i++) {
        const detector = detectors[i]!;
        console.log(" --- Running " + detector.name);
        await run(() =>
            detector.run(
                { ...detectorInfo, timeoutSecs: getTimeout(i) },
                detectorRuns
            )
        );
        console.log(" --- Finished " + detector.name);
    }

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

export function toArray<T>(obj: T | T[] | undefined): T[] | undefined {
    if (!obj) return undefined;
    return Array.isArray(obj) ? obj : [obj];
}
