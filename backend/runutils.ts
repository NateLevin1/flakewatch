import util from "util";
import { exec as execC } from "child_process";
import crypto from "crypto";
import AdmZip from "adm-zip";
import { serializeError } from "serialize-error";

export type DetectorRun = {
    test: string;
    prefixMd5: string;
    tool: string;
    passed: boolean;
    failure: string | undefined;
    log: string | undefined;
};

export type ToolTimings = {
    _minsAllowed: { module: number; test: number };
} & {
    [tool: string]: number;
};

export const run = async (fn: () => Promise<void>) => {
    try {
        return await fn();
    } catch (e: any) {
        console.error("Error running detector.");
        console.error(e);

        await writeDetectorError(e);
    }
};

export async function writeDetectorError(e: any) {
    const zip = new AdmZip();
    zip.addFile("error.json", Buffer.from(JSON.stringify(serializeError(e))));

    if (typeof e.stdout === "string") {
        console.error("\nStdout:");
        console.error(e.stdout);
        zip.addFile("stdout.log", Buffer.from(e.stdout));
    }
    if (typeof e.stderr === "string") {
        console.error("\nStderr:");
        console.error(e.stderr);
        zip.addFile("stderr.log", Buffer.from(e.stderr));
    }

    const errorStr: string = e.message ? e.message : e.toString();
    const shortErrorStr = errorStr
        .slice(0, 64)
        .match(/[a-zA-Z ]/g)
        ?.join("")
        ?.replaceAll(" ", "_");

    const rand = crypto.randomBytes(3).toString("base64url");
    const zipName = `${Date.now()}-${shortErrorStr ?? "error"}-${rand}`;
    await zip.writeZipPromise(
        `/home/flakewatch/detector-errors/${zipName}.zip`
    );
}

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

export function toArray<T>(obj: T | T[] | undefined): T[] | undefined {
    if (!obj) return undefined;
    return Array.isArray(obj) ? obj : [obj];
}
