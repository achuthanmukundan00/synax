# AutoCareer Integration

AutoCareer is the product gateway. It provides profile, evidence, job, and
career-specific context to Super.

Super expects AutoCareer to provide:

- profile and resume data
- career goals
- GitHub evidence
- job preferences
- application tracker state
- domain tools:
  - `draftResumeBullet`
  - `searchCareerEvidence`
  - `generateCoverLetterDraft`
  - `rankJobFit`
  - `summarizeGitHubEvidence`

AutoCareer may start, stop, and configure Super. AutoCareer should not own the
generic daemon loop, pulse scheduler, dream cycle, channel lifecycle, world
documents, self model, or Synax orchestration.

AutoCareer integration should flow through:

```txt
AutoCareer UI/API
  -> SuperRuntimeManager
  -> superd / Super daemon
  -> SuperSynaxSdkAdapter
  -> Synax SDK
  -> Relay
```
