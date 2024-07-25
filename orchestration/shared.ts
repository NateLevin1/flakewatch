// This is the type that /home/flakewatch/flakewatch-results.json in the container should match
// Both backend/shared.ts and orchestration/shared.ts contain this same file
export type FlakewatchResults = {
    detections: {
        testName: string;
        category?: FlakyCategory;
        module: string;
        sha: string;
    }[];
    ciDetections: { testName: string; sha: string; module: string }[];
};
export type FlakyCategory = "OD-Vic" | "OD-Brit" | "ID" | "NOD";
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
        keepContainerRunning?: boolean;
    };
};
export type ProjectInfo = Project & {
    lastCheckedCommit?: string;
    githubToken?: string;
};
