import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

import {
  attachmentSavePath,
  isResultAttachmentFilename,
} from "../../src/client-huaanwork/logic/attachmentDownload.ts";

test("the two attachment names map into the downloads dir; everything else is untouched", () => {
  const downloadsDir = join("/dl");
  assert.equal(isResultAttachmentFilename("结果.md"), true);
  assert.equal(isResultAttachmentFilename("结果.html"), true);
  assert.equal(isResultAttachmentFilename("其他.txt"), false);
  assert.equal(attachmentSavePath("结果.md", downloadsDir), join(downloadsDir, "结果.md"));
  assert.equal(attachmentSavePath("结果.html", downloadsDir), join(downloadsDir, "结果.html"));
  assert.equal(attachmentSavePath("其他.txt", downloadsDir), undefined);
  assert.equal(attachmentSavePath("结果.md.exe", downloadsDir), undefined);
});

test("the main window session owns the will-download interception (wiring contract)", () => {
  const source = readFileSync(join(import.meta.dirname, "../../src/electron-shell-generation.ts"), "utf8");
  assert.ok(source.includes("will-download"));
  assert.ok(source.includes("attachmentSavePath"));
  // The interception must attach to the WebContents session after the renderer
  // has been selected, not to the BrowserWindow constructed above it.
  const afterRendererAssignment = source.slice(source.indexOf("this.renderer = renderer"));
  assert.ok(afterRendererAssignment.includes("renderer.session.on('will-download'"));
  assert.ok(afterRendererAssignment.includes("attachmentSavePath"));
});
