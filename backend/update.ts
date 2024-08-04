import fs from "fs/promises";
import { simpleGit } from "simple-git";
import type { ProjectInfo, UpdateResults } from "./shared.js";
import { exec } from "./runutils.js";

if (!process.argv[2]) throw new Error("Missing project info argument");
const projectInfo = JSON.parse(process.argv[2]) as ProjectInfo;

export const git = simpleGit({ baseDir: "/home/flakewatch/clone" });

update(projectInfo);

export async function update(project: ProjectInfo) {
    console.log("Started updater.");
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
                `cd /home/flakewatch/clone/${project.name} && mvn install -ff -B -DskipTests`
            );
            result.compileSuccess = true;
            console.log("Compilation succeeded.");
        } catch (e) {
            console.error("Compilation failed: ");
            console.error(e);
        }

        if (!result.compileSuccess) return;

        const lastCheckedCommit = project.lastCheckedCommit;
        const log = await git.log({
            from: lastCheckedCommit ?? "HEAD~",
            to: "HEAD",
        });

        if (!log.latest) {
            console.log("No new commits found.");
            console.log("Last checked commit: " + lastCheckedCommit);
            console.log("Log:", log.all);
            console.log("Current:", await git.raw(["rev-parse", "HEAD"]));
            return;
        }

        if (!lastCheckedCommit) {
            result.newLastCheckedCommit = log.latest.hash;
            console.log(`Initializing at commit ${log.latest.hash}`);
            return;
        }

        const newCommitsExist = log.latest.hash !== lastCheckedCommit;
        if (newCommitsExist) {
            result.newLastCheckedCommit = log.latest.hash;
            console.log(`${log.all.length} new commit(s) found`);
            result.shouldRunFlakewatch = true;
        }
    } catch (e) {
        console.error("Error updating project: ");
        console.error(e);
    } finally {
        await fs.writeFile(
            "/home/flakewatch/update-results.json",
            JSON.stringify(result)
        );
    }
}
