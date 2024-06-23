import fs from "fs";

export type Project = {
    name: string;
    gitURL: string;
    buildCmd: string;
};

export const projects: Project[] = [];
export let config = {} as { port: number };

export function loadConfig() {
    config = JSON.parse(fs.readFileSync("./projects/_config.json").toString());
    if (!config.port || isNaN(Number(config.port)))
        throw new Error("You must provide port in _config.json");

    fs.readdirSync("./projects").forEach((filename) => {
        if (filename.startsWith("_")) return;
        const project = JSON.parse(
            fs.readFileSync(`./projects/${filename}`).toString()
        );
        projects.push(project);
    });
}
