import { projects } from "./projects";
import { simpleGit, CleanOptions } from "simple-git";

const git = simpleGit({ baseDir: "clones" }).clean(CleanOptions.FORCE);

export type Flaky = {
    ulid: string;
    projectURL: string;
    firstDetectCommit: string;
    firstDetectTime: number;
    fixCommit?: string;
    fixTime?: number;
    modulePath: string;
    qualifiedTestName: string;
    category?: string;
};

export async function flakewatch() {
    try {
        for (const project of projects) {
            git.clone(project.gitURL, `${project.name}`);
        }
    } catch (e) {
        console.error("Something went wrong when running flakewatch.");
        console.error(e);
    }
}
