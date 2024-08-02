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
