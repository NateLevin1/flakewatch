import fs from "fs";

export type Project = {
    name: string;
    gitURL: string;
    branch: string;
    mvnTestArgs?: string;
    owner: string;
    repo: string;
};

export const projects: Project[] = [];
export let config = {} as { port: number; mavenSurefireExtPath: string };

export function loadConfig() {
    config = JSON.parse(fs.readFileSync("./projects/_config.json").toString());
    if (!config.port || isNaN(Number(config.port)))
        throw new Error("You must provide port in _config.json");
    if (!config.mavenSurefireExtPath)
        throw new Error(
            "You must provide mavenSurefireExtPath in _config.json"
        );

    fs.readdirSync("./projects").forEach((filename) => {
        if (filename.startsWith("_")) return;
        const project = JSON.parse(
            fs.readFileSync(`./projects/${filename}`).toString()
        );
        project.owner = project.gitURL.split("/")[3];
        project.repo = project.gitURL.split("/")[4].replace(".git", "");
        projects.push(project);
    });
}
