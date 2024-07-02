// This is the type that ~/flakewatch-results.json in the container should match
// Both backend/shared.ts and orchestration/shared.ts contain this same file
export type FlakewatchResults = {
    newLastCheckedCommit?: string;
    detections: {
        testName: string;
        detections: DetectionCause[];
        module: string;
        sha: string;
    }[];
    ciDetections: { testName: string; sha: string }[];
};
export type DetectionCause =
    | "NonDex"
    | "Isolation"
    | "OBO"
    | "iDFl-OD"
    | "iDFl-NOD";
export type Project = {
    name: string;
    gitURL: string;
    branch: string;
    mvnTestArgs?: string;
    owner: string;
    repo: string;
};
export type ProjectInfo = Project & {
    lastCheckedCommit?: string;
    githubToken?: string;
};
