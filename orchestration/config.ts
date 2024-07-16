import fs from "fs";
import type { Project } from "./shared.js";

export let projects: Project[] = [];
export let config = {} as { port: number };

export function loadConfig() {
    config = JSON.parse(fs.readFileSync("./projects/_config.json").toString());
    if (!config.port || isNaN(Number(config.port)))
        throw new Error("You must provide port in _config.json");

    reloadProjects();
}

export function reloadProjects() {
    projects = [];

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
