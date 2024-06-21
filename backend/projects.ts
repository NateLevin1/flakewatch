import * as fs from "fs";

export type Project = {
    name: string;
    gitURL: string;
    buildCmd: string;
};

export const projects: Project[] = [];

export function loadProjects() {
    fs.readdirSync("./projects").forEach((filename) => {
        const project = JSON.parse(
            fs.readFileSync(`./projects/${filename}`).toString()
        );
        projects.push(project);
    });
}
