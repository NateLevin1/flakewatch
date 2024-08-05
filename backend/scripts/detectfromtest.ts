import { simpleGit } from "simple-git";
import {
    handleModifiedTests,
    onFlakewatchComplete,
} from "../handlemodified.js";

if (!process.argv[2]) throw new Error("Missing project info argument");

const projectInfo = JSON.parse(process.argv[2]) as {
    name: string;
    gitURL: string;
    test: string;
    commit: string;
    module?: string;
    debug: {
        keepContainerAlive: boolean;
    };
};
const { name, commit, module, test } = projectInfo;

const git = simpleGit({ baseDir: "/home/flakewatch/clone/" + name });
const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();

console.log("Running detectors for", name, commit, test, module, branch);

const results = { detections: [], ciDetections: [] };

try {
    await handleModifiedTests(
        [
            {
                commit,
                count: 1,
                module: module ?? "",
                testName: test,
            },
        ],
        commit,
        results,
        { ...projectInfo, branch } as any,
        git
    );
} finally {
    console.log("[!] Results:");
    console.log(results.detections);

    await onFlakewatchComplete(projectInfo as any, results);
}
