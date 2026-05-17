# Synax Super Edition Branch

This branch contains the experimental Synax Super Edition runtime.

`main` remains the stable Synax SDK/runtime release line.

`experiment/synax-super-edition` contains the higher-level Super agent layer:
- world model
- self model
- daemon runtime
- pulse/dream/reflection loops
- patch suggestion guardrails
- AutoCareer adapter
- future channel integrations such as Discord, web use, GitHub, and LinkedIn/job workflows

AutoCareer should integrate with Synax Super Edition as an external runtime/process boundary.

AutoCareer owns product UI, setup/admin flows, career data, evidence, database, exports, and bounded career APIs.

Synax Super Edition owns long-running agent runtime, world/self memory, agent loops, channel adapters, patch proposal logic, and bounded execution over supplied tools/context.

Relay/model serving remains separate.
