import { join } from "node:path";

import { RESULT_ATTACHMENT_FILES, type ResultAttachmentFile } from "./runResultAttachments.ts";

export function isResultAttachmentFilename(filename: string): filename is ResultAttachmentFile {
  return (RESULT_ATTACHMENT_FILES as readonly string[]).includes(filename);
}

/** 规格 §5：仅两个固定附件名接管，保存到下载目录同名文件；其他下载不接管。 */
export function attachmentSavePath(filename: string, downloadsDir: string): string | undefined {
  return isResultAttachmentFilename(filename) ? join(downloadsDir, filename) : undefined;
}
