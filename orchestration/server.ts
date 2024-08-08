import express from "express";
import { CronJob } from "cron";
import { toCsv, setupDB, getAllFlakies } from "./db.js";
import { config, loadConfig, projects } from "./config.js";
import { orchestrate } from "./orchestrate.js";

export function startServer() {
    loadConfig();

    if (!process.env.GITHUB_TOKEN)
        console.warn(
            "No GITHUB_TOKEN provided. CI logs will not be downloaded."
        );

    const app = express();

    app.get("/list.csv", (_req, res) => {
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
        CronJob.from({
            cronTime: "0 0 * * *",
            onTick: orchestrate,
            timeZone: "America/New_York",
            start: true,
        });
    });
}
