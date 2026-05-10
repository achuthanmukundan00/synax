/**
 * Skills module — file-system-based skill discovery and injection.
 *
 * Skills are markdown files (SKILL.md) in subdirectories of
 * ~/.synax/skills/ (global) or .synax/skills/ (project-local).
 *
 * Each skill is injected as an additional system message,
 * giving the model specialized knowledge without modifying
 * the agent code.
 */

export { discoverSkills, buildSkillMessages, parseFrontmatter } from './SkillLoader';
export type { Skill, SkillDiscovery, SkillFrontmatter } from './types';
