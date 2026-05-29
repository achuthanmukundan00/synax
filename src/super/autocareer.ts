export type AutoCareerContextProvider = {
  buildContext(): Promise<string>;
};

export type AutoCareerToolName =
  | 'draftResumeBullet'
  | 'searchCareerEvidence'
  | 'generateCoverLetterDraft'
  | 'rankJobFit'
  | 'summarizeGitHubEvidence';

export type AutoCareerToolRegistration = {
  name: AutoCareerToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export function defaultAutoCareerToolNames(): AutoCareerToolName[] {
  return [
    'draftResumeBullet',
    'searchCareerEvidence',
    'generateCoverLetterDraft',
    'rankJobFit',
    'summarizeGitHubEvidence',
  ];
}
