import express from "express";
import { CronJob } from "cron";
import {
    getActiveFlakies,
    toCsv,
    setup as setupDB,
    getAllFlakies,
} from "./db.js";
import { config, loadConfig, projects } from "./config.js";
import { orchestrate } from "./orchestrate.js";

export function startServer() {
    loadConfig();

    if (!process.env.GITHUB_TOKEN)
        console.warn(
            "No GITHUB_TOKEN provided. CI logs will not be downloaded."
        );
    if (process.env.SAVE_FAILURES === "true")
        console.log(
            "SAVE_FAILURES is set. Will save failure images in Docker."
        );

    const app = express();

    app.get("/active.csv", (req, res) => {
        res.type("text/csv");
        res.status(200);
        res.send(toCsv(getActiveFlakies));
    });

    app.get("/list.csv", (req, res) => {
        res.type("text/csv");
        res.status(200);
        res.send(toCsv(getAllFlakies));
    });

    app.listen(config.port, () => {
        console.log(
            `Flakewatch started. Server is running on http://localhost:${config.port}/list.csv`
        );
        setupDB();
        console.log(
            "Loaded " +
                projects.length +
                " projects: " +
                projects.map((p) => p.name).join(", ") +
                "."
        );
        new CronJob("0 0 * * *", orchestrate, null, true, null, null, true);
    });
}
