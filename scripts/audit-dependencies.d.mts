/**
 * Types for the dependency audit, so its test can import the same functions the script runs
 * (change: extend-api-for-supervising-hosts).
 */
export declare const IMPLICIT: Readonly<Record<string, string>>;
export declare function collectSources(dir: string): string[];
export declare function findUnreferencedDependencies(dependencies: string[], sources: string[]): string[];
