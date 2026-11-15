/**
 * Shared skill format: SKILL.md frontmatter parsing plus the safe `.tar.gz`
 * archive, canonical digest, and directory read/write helpers used by the
 * desktop Host and the intranet skill catalog.
 *
 * @module @huaanwork/skill-format
 */

export {
  MAX_SKILL_ARCHIVE_BYTES,
  MAX_SKILL_ARCHIVE_CONTENT_BYTES,
  MAX_SKILL_ENTRIES,
  MAX_SKILL_PATH_BYTES,
  buildSkillArchive,
  createSkillDigest,
  inspectSkillArchive,
  readSkillDirectory,
  writeSkillDirectory,
} from './archive.ts'
export type { InspectedSkillArchive, SkillArchiveFile } from './archive.ts'
export {
  SKILL_NAME_RE,
  parseSkillMarkdown,
  serializeSkillMarkdown,
} from './markdown.ts'
export type { ParsedSkillMarkdown } from './markdown.ts'
