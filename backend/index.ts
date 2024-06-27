import express from "express";
import { CronJob } from "cron";
import { flakewatch } from "./flakewatch.js";
import {
    getActiveFlakies,
    toCsv,
    setup as setupDB,
    getAllFlakies,
} from "./db.js";
import { config, loadConfig, projects } from "./config.js";

const app = express();
loadConfig();

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
    new CronJob("*/15 * * * *", flakewatch, null, true, null, null, true);
});
