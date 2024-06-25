import express from "express";
import { CronJob } from "cron";
import { flakewatch } from "./flakewatch";
import { getActiveFlakies, setup as setupDB } from "./db";
import { config, loadConfig, projects } from "./config";

const app = express();
loadConfig();

app.get("/list.csv", (req, res) => {
    res.type("text/csv");
    res.status(200);
    res.send(
        "id,projectURL,firstDetectCommit,firstDetectTime,fixCommit,fixTime,modulePath,qualifiedTestName,category\n" +
            getActiveFlakies()
                .map(
                    (flaky) =>
                        `${flaky.ulid},${flaky.projectURL},${flaky.firstDetectCommit},${flaky.firstDetectTime},${flaky.fixCommit},${flaky.fixTime},${flaky.modulePath},${flaky.qualifiedTestName},${flaky.category}`
                )
                .join("\n")
    );
});

app.listen(config.port, () => {
    console.log(
        `Flakewatch started. Server is running on http://localhost:${config.port}/list`
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
