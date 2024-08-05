import { exec, readFlakewatchResultsToDB } from "./orchestrate.js";
import type { ProjectInfo } from "./shared.js";

export async function cli(args: string[]) {
    const keepAliveIndex = args.findIndex((arg) => arg === "--keep-alive");
    if (keepAliveIndex != -1) args.splice(keepAliveIndex, 1);

    const [gitURL, commit, test, module] = args;
    if (!gitURL || !commit || !test) {
        console.log(
            "Usage: npm start -- <gitURL> <commit> <test> (module) (--keep-alive)"
        );
        return;
    }

    console.log("Running detectors for", gitURL, commit, test, module);
    if (keepAliveIndex != -1)
        console.log("- keeping container alive, press Ctrl+C to stop");

    const name = gitURL.split("/").at(-1)!;
    const project = {
        name,
        gitURL,
        test,
        commit,
        module,
        debug: {
            keepContainerAlive: keepAliveIndex != -1,
            leaveContainers: true,
            minsAllowedPerModuleCommit: process.env.MINS_PER_MODULE_COMMIT ?? 3,
            minsAllowedPerTest: process.env.MINS_PER_TEST ?? 3,
        },
    };

    const cloneCmd = `cd /home/flakewatch/clone/ && git clone ${gitURL} ${name} && cd ${name} && git checkout ${commit}`;
    const updateFlakewatchCmd = `cd /home/flakewatch/flakewatch/backend && git pull && npm install && npm run build`;
    const projectJson = JSON.stringify(project).replaceAll('"', '\\"');
    const cmd = `/bin/bash -c "${cloneCmd} && ${updateFlakewatchCmd} && npm run detect-from-test -- '${projectJson}'"`;
    await exec(
        `docker run --name='flakewatch-${project.name}' -i flakewatch:base ${cmd}`
    );
    await readFlakewatchResultsToDB(project as unknown as ProjectInfo);
}
