import util from "util";
import { exec as execC } from "child_process";
import crypto from "crypto";

export type DetectorRun = {
    test: string;
    prefixMd5: string;
    tool: string;
    passed: boolean;
    failure: string | undefined;
    log: string | undefined;
};

export const run = async (fn: () => Promise<void>) => {
    try {
        return await fn();
    } catch (e: any) {
        console.error("Error running detector.");
        console.error(e);
        if (typeof e.stdout === "string") {
            console.error("\nStdout:");
            console.error(e.stdout);
            return;
        }
    }
};

export const createTimeoutFunction = (
    minsAllowed: number,
    numDetectors: number,
    minDetectorSec: number
) => {
    const startTime = Date.now();

    return (detectorIndex: number) => {
        const elapsed = Date.now() - startTime;
        const totalRemaining = minsAllowed * 60 * 1000 - elapsed;
        const divisor = detectorIndex - numDetectors;
        return Math.max(
            Math.round(totalRemaining / divisor / 1000),
            minDetectorSec
        );
    };
};

export const md5 = (str: string) => {
    return crypto.createHash("md5").update(str).digest("hex");
};

export const exec = util.promisify(execC);
// NOTE: The cmd passed in should *not* include a `timeout` command or single quotes
export const execTimeout = async (
    cmd: string,
    timeoutSecs: number,
    ifErrorStdoutMustInclude?: string
) => {
    if (/timeout \d|'/g.test(cmd))
        throw new Error("cmd should not include timeout or single quotes");

    try {
        return await exec(`timeout ${timeoutSecs} bash -c '${cmd}'`);
    } catch (e) {
        // this can happen if A) the timeout hit B) something went wrong or C) a tool returns non-zero when successful
        const error = e as { stdout: string; stderr: string; code: number };
        if (error.code === 124) {
            // case A: 124 is the code for timeout
            console.log(" ----- ran out of time (given " + timeoutSecs + "s)");
        } else {
            // case B or C
            if (
                !ifErrorStdoutMustInclude ||
                !error.stdout.includes(ifErrorStdoutMustInclude) // check case C
            )
                throw e;
        }

        return error;
    }
};
