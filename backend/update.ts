import util from "util";
import { exec as execC } from "child_process";
import fs from "fs/promises";
import { simpleGit } from "simple-git";
import type { ProjectInfo, UpdateResults } from "./shared.js";

if (!process.argv[2]) throw new Error("Missing project info argument");
const projectInfo = JSON.parse(process.argv[2]) as ProjectInfo;

export const git = simpleGit({ baseDir: "/home/flakewatch/clone" });

update(projectInfo);

export const exec = util.promisify(execC);

export async function update(project: ProjectInfo) {
    console.log(project.name + ": Started updater.");
    let result: UpdateResults = {
        compileSuccess: false,
        shouldRunFlakewatch: false,
    } satisfies UpdateResults;

    try {
        await fs.unlink("/home/flakewatch/update-results.json");
        await fs.unlink(
            "/home/flakewatch/clone/" + project.name + "/.git/index.lock"
        );
    } catch (e) {}

    try {
        // * Update the project to the latest commit
        try {
            await git.clone(project.gitURL, project.name);
            await git.cwd("/home/flakewatch/clone/" + project.name);
        } catch (e) {
            console.log(
                "Clone failed; this is expected if the project is already cloned."
            );
            console.log(e);
            await git.cwd("/home/flakewatch/clone/" + project.name);
            // clone fails if non-empty, so pull instead if it's already cloned
            await git.reset(["--hard"]);
            await git.checkout(project.branch);
            await git.reset(["--hard"]);
            await git.pull();
        }

        // try compiling the project
        try {
            await exec(
                `cd /home/flakewatch/clone/${project.name} && mvn compile -ff -B`
            );
            result.compileSuccess = true;
            console.log(project.name + ": Compilation succeeded.");
        } catch (e) {
            // compilation failed
            console.error(project.name + ": Compilation failed: ");
            console.error(e);
        }

        if (!result.compileSuccess) return;

        const lastCheckedCommit = project.lastCheckedCommit;
        const log = await git.log({
            from: lastCheckedCommit ?? "HEAD~",
            to: "HEAD",
        });
        console.log("Last checked commit: " + lastCheckedCommit);
        console.log("Latest:", log.latest?.hash);
        console.log("Log:", log.all);
        if (!log.latest) return;

        if (!lastCheckedCommit) {
            result.newLastCheckedCommit = log.latest.hash;
            console.log(
                `${project.name}: Initializing at commit ${log.latest.hash}`
            );
            return;
        }

        const newCommitsExist = log.latest.hash !== lastCheckedCommit;
        if (newCommitsExist) {
            result.newLastCheckedCommit = log.latest.hash;
            console.log(
                `${project.name}: ${log.all.length} new commit(s) found`
            );
            result.shouldRunFlakewatch = true;
        }
    } catch (e) {
        console.error(project.name + ": Error updating project: ");
        console.error(e);
    } finally {
        await fs.writeFile(
            "/home/flakewatch/update-results.json",
            JSON.stringify(result)
        );
    }
}
