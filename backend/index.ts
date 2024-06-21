import express from "express";
import { CronJob } from "cron";
import { flakewatch, setup } from "./flakewatch";

const app = express();
const port = 3000;

app.get("/", (req, res) => {
    res.send("Hello, world!");
});

app.listen(port, () => {
    console.log(
        `Flakewatch started. Server is running on http://localhost:${port}`
    );
    setup();
    new CronJob("0 * * * * *", flakewatch, null, true, null, null, true);
});
