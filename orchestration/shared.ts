// This is the type that /home/flakewatch/flakewatch-results.json in the container should match
// Both backend/shared.ts and orchestration/shared.ts contain this same file
export type FlakewatchResults = {
    detections: {
        testName: string;
        detections: DetectionCause[];
        module: string;
        sha: string;
    }[];
    ciDetections: { testName: string; sha: string; module: string }[];
};
export type DetectionCause =
    | "NonDex"
    | "Isolation"
    | "OBO"
    | "OBO-Brit"
    | "iDFl-OD"
    | "iDFl-NOD";
export type UpdateResults = {
    compileSuccess?: boolean;
    shouldRunFlakewatch?: boolean;
    newLastCheckedCommit?: string;
};
export type Project = {
    name: string;
    gitURL: string;
    branch: string;
    mvnTestArgs?: string;
    owner: string;
    repo: string;
    debug?: {
        minsAllowedPerModuleCommit?: number;
        minsAllowedPerTest?: number;
        leaveContainers?: boolean;
    };
};
export type ProjectInfo = Project & {
    lastCheckedCommit?: string;
    githubToken?: string;
};
