# Single Desktop 首期 outer upstream 逐文件处置

- as-of: 2026-10-29T23:06:29.582Z
- range: `44084bdae0d44cac56948a223048d9c31541d0d0..092e2ecef750d10db43cedbab8e81fd48c8de38e`（56 commits）
- 规则：每个 direct file 继承 commit-default；FILE_OVERRIDES 只记录已有等价/更新实现。SKIP 是明确不移植，不是未审。merge direct files 为空，不重复子提交。
- 本货架无 PORT；7b3cddd2fe 的 browser 行为变化进入既有功能对齐债，不在本维护计划实施。

| upstream SHA | direct file | 裁定 | 理由 |
| --- | --- | --- | --- |
| c756ae722973dc4032026cdbfc80284000519a14 | deepseek-harness | SKIP | rc.2 runtime train；Harness pin 和 runtime 更新不属于本维护计划 |
| c756ae722973dc4032026cdbfc80284000519a14 | upstream.json | SKIP | rc.2 runtime train；Harness pin 和 runtime 更新不属于本维护计划 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | .yarn/patches/dshmarket-desktop.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-community-market/package.json | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-community-market/tests/contracts.spec.ts | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-desktop-next/package.json | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-desktop-next/scripts/verify-frontend.mjs | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-desktop-next/scripts/verify-host.mjs | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-desktop-next/scripts/verify-window-controls.mjs | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-desktop-next/upstream-reference.json | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-plugin-desktop-beta/THIRD_PARTY_NOTICES.md | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-plugin-desktop-beta/package.json | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-plugin-desktop/THIRD_PARTY_NOTICES.md | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-plugin-desktop/package.json | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-plugin-desktop/scripts/prepare-runtime.ts | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-plugin-desktop/scripts/primary-runtime.ts | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-plugin-desktop/scripts/sign-runtime.ts | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-plugin-desktop/tests/desktop-office.spec.ts | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-plugin-desktop/tests/package.spec.ts | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-plugin-desktop/tests/prepare-runtime.spec.ts | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-plugin-desktop/tests/primary-runtime.spec.ts | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-plugin-desktop/tests/profile.spec.ts | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-plugin-desktop/tests/request-inventory-resolution.spec.ts | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-plugin-desktop/tests/sign-runtime.spec.ts | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | dsh-plugin-desktop/tests/webserver.spec.ts | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | package.json | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-app-boot@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-app-boot@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-modules@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-modules@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-ui-conversation@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-ui-conversation@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-ui-directory-picker-browse@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-ui-directory-picker-browse@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-ui-plugin-manager@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-ui-plugin-manager@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-ui-primitives@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-ui-primitives@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-ui-settings-account@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-ui-settings-account@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-ui-settings-general@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-ui-settings-general@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-ui-settings-shell@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-ui-settings-shell@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-ui-sidebar@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-client-ui-sidebar@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-experimental-computer-use-cua-driver-native@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-experimental-computer-use-cua-driver-native@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-experimental-inspector@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-experimental-inspector@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-hmr@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-hmr@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-host-directory-picker-browse@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-host-directory-picker-browse@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-host-open-in-app@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-host-open-in-app@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-plugin-manager@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-plugin-manager@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-plugin-package-inventory-deepseek@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-plugin-package-inventory-deepseek@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-ptc-runtime-node@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-ptc-runtime-node@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-sandbox-windows-acl@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-sandbox-windows-acl@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-subprocess-local@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-subprocess-local@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-web-app@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh-web-app@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh@0.2.1-alpha.5.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | patches/dsh@0.2.1-rc.2.patch | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | scripts/inspector-compat.test.mjs | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/agents-anywhere/agents-anywhere-dsh-bridge-next-2.1.0-desktop.c58d98da25a23.r144209ac.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/agents-anywhere/agents-anywhere-dsh-bridge-next-2.1.0-desktop.c58d98da25a23.r2e406d2a.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/agents-anywhere/provenance.json | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-acp-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-acp-app-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-agent-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-agent-default-model-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-agent-instructions-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-agent-loop-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-agent-loop-testkit-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-agent-preset-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-agent-preset-registry-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-agent-tool-presentation-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-anonymous-user-id-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-api-account-controller-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-api-gateway-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-api-job-controller-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-api-remote-access-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-api-remotes-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-api-session-controller-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-api-settings-controller-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-api-terminal-controller-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-api-workspace-controller-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-api-workspace-files-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-app-boot-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-atomic-write-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-attachment-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-attachment-local-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-authorization-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-base-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-bash-local-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-bash-sandbox-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-brand-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-browser-use-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-chunked-list-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-connection-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-file-upload-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-hmr-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-locale-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-modules-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-product-analytics-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-resources-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-shortcuts-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-store-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-test-runtime-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-agent-preset-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-approval-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-attachment-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-brand-official-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-chat-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-commands-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-conversation-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-cordis-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-deliverables-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-directory-picker-browse-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-directory-picker-native-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-dockkit-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-goal-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-input-trigger-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-jobs-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-layout-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-message-feedback-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-model-selection-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-open-in-app-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-permission-presets-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-plan-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-plugin-manager-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-plugin-market-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-primitives-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-reference-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-renderer-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-schedule-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-secret-mask-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-session-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-settings-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-settings-account-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-settings-agent-loop-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-settings-general-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-settings-models-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-settings-plugin-inventory-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-settings-plugins-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-settings-session-log-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-settings-shell-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-settings-subagent-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-settings-web-search-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-shortcuts-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-sidebar-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-sidebar-browser-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-sidebar-documentpreview-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-sidebar-files-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-sidebar-right-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-sidebar-terminal-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-skill-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-slots-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-subagent-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-theme-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-tool-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-trajectory-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-user-questions-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-workflow-run-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-ui-workspace-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-client-web-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-cmdline-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-command-compact-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-command-feedback-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-command-goal-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-commands-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-compaction-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-compaction-basic-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-compaction-image-offload-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-compaction-tool-result-pruner-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-computer-use-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-config-editor-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-cordis-client-runner-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-cordis-host-runner-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-credentials-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-credentials-local-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-cua-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-deepseek-account-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-deepseek-account-platform-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-deepseek-llm-api-extensions-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-deque-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-agent-team-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-agent-team-profile-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-api-speech-to-text-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-auto-review-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-badge-skill-bundle-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-browser-use-chrome-devtools-mcp-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-browser-use-playwright-mcp-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-browser-use-runtime-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-browser-use-stagehand-native-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-claude-code-mods-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-client-ui-agent-team-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-client-ui-claude-code-mods-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-client-ui-cot-translation-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-client-ui-voice-input-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-computer-use-cua-driver-mcp-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-computer-use-cua-driver-native-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-cot-translation-bundle-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-cua-macos-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-inspector-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-inspector-profile-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-plugin-market-bundle-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-ptc-runtime-python-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-ralph-bundle-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-session-inspector-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-session-search-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-session-titles-bundle-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-speech-to-text-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-speech-to-text-sensevoice-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-terminal-bundle-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-tool-agent-team-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-tool-worktree-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-translator-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-voice-input-bundle-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-webworker-packer-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-webworker-runtime-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-experimental-worktree-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-file-reference-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-file-reference-local-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-fs-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-fs-local-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-fs-observation-policy-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-fs-sandbox-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-fs-ssh-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-goal-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-goal-round-driver-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-harness-dev-context-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-headless-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-hmr-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-home-paths-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-hook-protocol-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-hooks-claude-code-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-hooks-codex-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-host-directory-picker-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-host-directory-picker-auto-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-host-directory-picker-browse-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-host-directory-picker-native-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-host-frontend-static-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-host-open-in-app-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-host-plugin-inventory-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-host-product-telemetry-otel-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-host-webserver-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-http-proxy-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-jobs-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-jobs-local-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-launch-environment-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-lazy-require-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-llm-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-llm-deepseek-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-llm-deepseek-account-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-llm-deepseek-api-key-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-llm-mock-server-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-llm-pi-ai-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-llm-replay-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-llm-retry-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-loader-smoke-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-lsp-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-lsp-stdio-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-mcp-client-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-mcp-resources-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-message-feedback-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-native-command-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-office-to-pdf-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-otel-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-output-retention-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-package-manifest-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-permission-presets-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-persona-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-plan-mode-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-plugin-manager-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-plugin-market-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-plugin-market-index-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-plugin-package-inventory-deepseek-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-ptc-runtime-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-ptc-runtime-node-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-pwsh-local-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-pwsh-sandbox-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-remote-mock-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-repeat-tool-reminder-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-sandbox-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-sandbox-local-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-sandbox-policy-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-sandbox-ssh-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-sandbox-windows-acl-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-schedule-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-scope-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-sdk-app-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-sdk-client-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-sdk-jsonrpc-server-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-sdk-minimal-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-sdk-protocol-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-checkpoint-policy-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-format-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-format-catalog-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-format-v0-to-v1-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-format-v1-to-v2-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-format-v2-to-v3-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-format-v3-to-v4-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-log-deepseek-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-log-export-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-persistence-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-persistence-jsonl-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-projection-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-projection-cache-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-query-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-query-sqlite-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-reference-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-snapshot-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-stats-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-telemetry-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-telemetry-otel-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-title-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-title-all-prompts-llm-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-title-first-prompt-llm-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-title-llm-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-session-turn-outline-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-settings-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-shell-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-shell-env-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-skill-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-skill-badge-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-skill-filesystem-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-skill-office-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-spill-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-spill-local-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-spill-policy-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-ssh-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-storage-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-storage-domain-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-storage-json-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-storage-sqlite-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-subagent-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-subagent-acp-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-subagent-claude-code-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-subagent-codex-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-subagent-dsh-sdk-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-subagent-fork-in-process-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-subagent-spawn-in-process-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-subprocess-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-subprocess-local-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-subprocess-ssh-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-system-prompt-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-terminal-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-terminal-bash-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-time-context-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-timeout-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tmux-context-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-token-meter-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-ask-user-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-bash-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-bash-persistent-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-call-timeout-policy-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-cordis-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-fs-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-fs-search-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-goal-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-jobs-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-lsp-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-present-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-pwsh-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-pwsh-persistent-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-ralph-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-schedule-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-session-query-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-skill-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-str-replace-editor-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-subagent-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-subagent-control-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-terminal-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-todo-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-web-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-workflow-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-working-directory-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tool-workspace-dependencies-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-tools-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-typert-generator-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-typert-loader-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-typert-protocol-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-typert-registry-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-user-approval-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-user-questions-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-util-code-language-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-util-crypto-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-util-time-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-util-values-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-util-workspace-path-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-web-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-web-app-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-web-fetch-http-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-web-frontend-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-web-search-deepseek-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-web-search-exa-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-web-search-perplexity-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-webhook-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-webhook-github-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-win32-process-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-workflow-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-workflow-ptc-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-working-directory-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-workspace-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/deepseek-ai-dsh-workspace-changes-0.2.1-alpha.5.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-alpha.5/manifest.json | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-acp-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-acp-app-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-agent-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-agent-default-model-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-agent-instructions-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-agent-loop-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-agent-loop-testkit-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-agent-preset-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-agent-preset-registry-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-agent-tool-presentation-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-anonymous-user-id-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-account-controller-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-gateway-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-job-controller-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-remote-access-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-remotes-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-session-controller-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-settings-controller-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-terminal-controller-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-workspace-controller-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-workspace-files-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-app-boot-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-atomic-write-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-attachment-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-attachment-local-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-authorization-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-base-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-bash-local-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-bash-sandbox-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-brand-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-browser-use-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-chunked-list-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-connection-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-file-upload-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-hmr-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-locale-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-modules-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-product-analytics-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-resources-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-shortcuts-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-store-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-test-runtime-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-agent-preset-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-approval-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-attachment-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-brand-official-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-chat-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-commands-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-conversation-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-cordis-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-deepseek-model-label-1017-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-deliverables-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-directory-picker-browse-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-directory-picker-native-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-dockkit-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-goal-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-input-trigger-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-jobs-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-layout-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-message-feedback-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-model-selection-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-open-in-app-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-permission-presets-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-plan-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-plugin-manager-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-plugin-market-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-primitives-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-reference-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-renderer-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-schedule-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-secret-mask-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-session-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-account-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-agent-loop-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-general-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-models-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-plugin-inventory-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-plugins-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-session-log-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-shell-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-subagent-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-web-search-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-shortcuts-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-sidebar-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-sidebar-browser-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-sidebar-documentpreview-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-sidebar-files-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-sidebar-right-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-sidebar-terminal-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-skill-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-slots-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-subagent-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-theme-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-tool-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-trajectory-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-user-questions-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-workflow-run-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-workspace-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-web-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-cmdline-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-command-compact-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-command-feedback-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-command-goal-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-commands-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-compaction-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-compaction-basic-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-compaction-image-offload-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-compaction-tool-result-pruner-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-computer-use-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-config-editor-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-cordis-client-runner-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-cordis-host-runner-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-credentials-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-credentials-local-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-cua-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-deepseek-account-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-deepseek-account-platform-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-deepseek-llm-api-extensions-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-deque-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-agent-team-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-agent-team-profile-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-api-speech-to-text-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-auto-review-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-badge-skill-bundle-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-browser-use-chrome-devtools-mcp-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-browser-use-playwright-mcp-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-browser-use-runtime-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-browser-use-stagehand-native-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-claude-code-mods-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-client-ui-agent-team-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-client-ui-claude-code-mods-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-client-ui-cot-translation-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-client-ui-voice-input-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-computer-use-cua-driver-mcp-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-computer-use-cua-driver-native-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-cot-translation-bundle-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-cua-macos-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-inspector-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-inspector-profile-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-plugin-market-bundle-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-ptc-runtime-python-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-ralph-bundle-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-session-inspector-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-session-search-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-session-titles-bundle-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-speech-to-text-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-speech-to-text-sensevoice-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-terminal-bundle-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-tool-agent-team-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-tool-worktree-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-translator-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-voice-input-bundle-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-webworker-packer-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-webworker-runtime-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-worktree-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-file-reference-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-file-reference-local-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-fs-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-fs-local-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-fs-observation-policy-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-fs-sandbox-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-fs-ssh-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-goal-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-goal-round-driver-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-harness-dev-context-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-headless-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-hmr-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-home-paths-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-hook-protocol-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-hooks-claude-code-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-hooks-codex-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-directory-picker-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-directory-picker-auto-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-directory-picker-browse-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-directory-picker-native-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-frontend-static-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-open-in-app-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-plugin-inventory-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-product-telemetry-otel-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-webserver-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-http-proxy-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-jobs-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-jobs-local-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-launch-environment-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-lazy-require-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-llm-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-llm-deepseek-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-llm-deepseek-account-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-llm-deepseek-api-key-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-llm-mock-server-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-llm-pi-ai-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-llm-replay-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-llm-retry-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-loader-smoke-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-lsp-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-lsp-stdio-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-mcp-client-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-mcp-resources-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-message-feedback-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-native-command-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-office-to-pdf-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-otel-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-output-retention-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-package-manifest-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-permission-presets-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-persona-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-plan-mode-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-plugin-manager-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-plugin-market-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-plugin-market-index-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-plugin-package-inventory-deepseek-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-ptc-runtime-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-ptc-runtime-node-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-pwsh-local-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-pwsh-sandbox-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-remote-mock-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-repeat-tool-reminder-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sandbox-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sandbox-local-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sandbox-policy-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sandbox-ssh-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sandbox-windows-acl-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-schedule-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-scope-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sdk-app-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sdk-client-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sdk-jsonrpc-server-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sdk-minimal-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sdk-protocol-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-checkpoint-policy-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-format-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-format-catalog-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-format-v0-to-v1-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-format-v1-to-v2-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-format-v2-to-v3-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-format-v3-to-v4-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-log-deepseek-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-log-export-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-persistence-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-persistence-jsonl-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-projection-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-projection-cache-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-query-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-query-sqlite-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-reference-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-snapshot-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-stats-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-telemetry-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-telemetry-otel-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-title-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-title-all-prompts-llm-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-title-first-prompt-llm-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-title-llm-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-turn-outline-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-settings-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-shell-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-shell-env-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-skill-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-skill-badge-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-skill-filesystem-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-skill-office-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-spill-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-spill-local-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-spill-policy-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-ssh-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-storage-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-storage-domain-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-storage-json-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-storage-sqlite-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subagent-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subagent-acp-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subagent-claude-code-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subagent-codex-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subagent-dsh-sdk-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subagent-fork-in-process-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subagent-spawn-in-process-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subprocess-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subprocess-local-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subprocess-ssh-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-system-prompt-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-terminal-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-terminal-bash-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-time-context-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-timeout-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tmux-context-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-token-meter-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-ask-user-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-bash-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-bash-persistent-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-call-timeout-policy-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-cordis-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-fs-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-fs-search-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-goal-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-jobs-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-lsp-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-present-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-pwsh-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-pwsh-persistent-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-ralph-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-schedule-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-session-query-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-skill-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-str-replace-editor-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-subagent-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-subagent-control-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-terminal-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-todo-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-web-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-workflow-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-working-directory-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-workspace-dependencies-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tools-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-typert-generator-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-typert-loader-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-typert-protocol-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-typert-registry-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-user-approval-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-user-questions-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-util-code-language-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-util-crypto-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-util-time-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-util-values-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-util-workspace-path-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-app-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-deepseek-api-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-fetch-http-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-frontend-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-search-deepseek-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-search-exa-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-search-perplexity-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-webhook-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-webhook-github-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-win32-process-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-workflow-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-workflow-ptc-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-working-directory-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-workspace-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-workspace-changes-0.2.1-rc.2.tgz | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | vendor/dsh-runtime/0.2.1-rc.2/manifest.json | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| e19f7cfa896a028a14147c5d8d044e9ad985f948 | yarn.lock | SKIP | rc.2 适配和旧产品树；fork 保持 rc.1 |
| 3c0bb5aabb2b51981deeda4751a8100640cb7702 | (merge container, zero direct files) | SKIP | merge 容器；子提交已独立裁定 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | dsh-desktop-next/README.i18n.yaml | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | dsh-desktop-next/README.md | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | dsh-desktop-next/README.zh.md | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | dsh-desktop-next/package.json | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | dsh-desktop-next/scripts/verify-window-controls.mjs | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | dsh-desktop-next/tests/main-lifecycle.spec.ts | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | dsh-desktop-next/tests/package.spec.ts | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | dsh-desktop-next/tests/updates.spec.ts | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | dsh-plugin-desktop-beta/THIRD_PARTY_NOTICES.md | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | dsh-plugin-desktop-beta/package.json | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | dsh-plugin-desktop-beta/tests/package.spec.ts | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | dsh-plugin-desktop-beta/tests/update-checker.spec.ts | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | dsh-plugin-desktop/THIRD_PARTY_NOTICES.md | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | dsh-plugin-desktop/package.json | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | dsh-plugin-desktop/tests/package.spec.ts | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | dsh-plugin-desktop/tests/update-checker.spec.ts | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | package.json | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a | yarn.lock | SKIP | Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本 |
| 54779f32b93080328deafc73db93d570d7671e0b | (merge container, zero direct files) | SKIP | merge 容器；子提交已独立裁定 |
| 153f0df03478857d82e89cef0dd1b286e4ab74e1 | dsh-desktop-next/package.json | SKIP | Next 市场 UI 功能，非维护范围 |
| 153f0df03478857d82e89cef0dd1b286e4ab74e1 | dsh-desktop-next/src/client/market-toggle.ts | SKIP | Next 市场 UI 功能，非维护范围 |
| 153f0df03478857d82e89cef0dd1b286e4ab74e1 | dsh-desktop-next/src/client/plugin-controls.tsx | SKIP | Next 市场 UI 功能，非维护范围 |
| 153f0df03478857d82e89cef0dd1b286e4ab74e1 | dsh-desktop-next/tests/market-toggle.spec.ts | SKIP | Next 市场 UI 功能，非维护范围 |
| 153f0df03478857d82e89cef0dd1b286e4ab74e1 | dsh-plugin-desktop-beta/package.json | SKIP | Next 市场 UI 功能，非维护范围 |
| 153f0df03478857d82e89cef0dd1b286e4ab74e1 | dsh-plugin-desktop/package.json | SKIP | Next 市场 UI 功能，非维护范围 |
| 153f0df03478857d82e89cef0dd1b286e4ab74e1 | package.json | SKIP | Next 市场 UI 功能，非维护范围 |
| 153f0df03478857d82e89cef0dd1b286e4ab74e1 | yarn.lock | SKIP | Next 市场 UI 功能，非维护范围 |
| 28fa181ec61b5d2f064130ba8fa3a2bdf534b011 | (merge container, zero direct files) | SKIP | merge 容器；子提交已独立裁定 |
| 7b3cddd2fe4a403528f357f65b07832cb279ea9d | dsh-plugin-desktop-beta/cordis.patch.yml | SKIP | 跨 Profile 默认启用 browser 属产品行为变化；登记到既有 2.1 功能对齐债，本计划不移植 |
| 7b3cddd2fe4a403528f357f65b07832cb279ea9d | dsh-plugin-desktop-beta/tests/profile.spec.ts | SKIP | 跨 Profile 默认启用 browser 属产品行为变化；登记到既有 2.1 功能对齐债，本计划不移植 |
| 7b3cddd2fe4a403528f357f65b07832cb279ea9d | dsh-plugin-desktop/cordis.patch.yml | SKIP | 跨 Profile 默认启用 browser 属产品行为变化；登记到既有 2.1 功能对齐债，本计划不移植 |
| 7b3cddd2fe4a403528f357f65b07832cb279ea9d | dsh-plugin-desktop/tests/profile.spec.ts | SKIP | 跨 Profile 默认启用 browser 属产品行为变化；登记到既有 2.1 功能对齐债，本计划不移植 |
| 796e92bfb3ed4189a27bde2f348834fe2cf629f9 | (merge container, zero direct files) | SKIP | merge 容器；子提交已独立裁定 |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/package.json | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/src/client/DesktopSettingsSection.tsx | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/src/client/desktop-settings-locales.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/src/client/desktop-settings.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/src/client/index.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/src/client/market-toggle.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/src/client/plugin-controls-styles.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/src/client/plugin-controls.tsx | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/src/desktop-plugins.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/src/host-bootstrap.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/src/main.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/src/profile-context.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/src/profile.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/tests/client-desktop-settings.spec.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/tests/client-environment.spec.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/tests/market-toggle.spec.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop-beta/tests/profile-context.spec.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/package.json | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/src/client/DesktopSettingsSection.tsx | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/src/client/desktop-settings-locales.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/src/client/desktop-settings.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/src/client/index.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/src/client/market-toggle.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/src/client/plugin-controls-styles.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/src/client/plugin-controls.tsx | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/src/desktop-plugins.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/src/host-bootstrap.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/src/main.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/src/profile-context.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/src/profile.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/tests/client-desktop-settings.spec.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/tests/client-environment.spec.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/tests/market-toggle.spec.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | dsh-plugin-desktop/tests/profile-context.spec.ts | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | patches/dsh-hmr@0.2.1-rc.2.patch | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| 23257966a4d450721cc9c204c9a88c5d23d6f304 | yarn.lock | SKIP | plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI |
| d9c40826ad36dd4db13a836cc0b45b31361f4b5e | (merge container, zero direct files) | SKIP | merge 容器；子提交已独立裁定 |
| cc521f959dc416c1844aebefeabc7cc24b6aa867 | dsh-desktop-next/src/client/plugin-controls.tsx | SKIP | Stable/Beta/Next 市场 UI 文案与布局功能 |
| cc521f959dc416c1844aebefeabc7cc24b6aa867 | dsh-plugin-desktop-beta/src/client/plugin-controls.tsx | SKIP | Stable/Beta/Next 市场 UI 文案与布局功能 |
| cc521f959dc416c1844aebefeabc7cc24b6aa867 | dsh-plugin-desktop/src/client/plugin-controls.tsx | SKIP | Stable/Beta/Next 市场 UI 文案与布局功能 |
| 3e6fc93fd5f438f622770005104b84d708a2d089 | (merge container, zero direct files) | SKIP | merge 容器；子提交已独立裁定 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-desktop-next/src/client/index.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-desktop-next/src/main.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-desktop-next/src/native-ui/onboarding.tsx | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-desktop-next/src/profile-plugin-market.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-desktop-next/src/profiles.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-desktop-next/tests/main-lifecycle.spec.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-desktop-next/tests/profiles.spec.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop-beta/src/client/onboarding.css | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop-beta/src/main.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop-beta/src/native-ui/setup-wizard/App.tsx | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop-beta/src/profile.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop-beta/src/setup-wizard-contract.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop-beta/src/setup-wizard-copy.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop-beta/src/setup-wizard-window.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop-beta/tests/profile.spec.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop-beta/tests/setup-wizard-copy.spec.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop-beta/tests/setup-wizard-native-ui.spec.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop-beta/tests/setup-wizard-window.spec.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop/src/client/onboarding.css | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop/src/main.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop/src/native-ui/setup-wizard/App.tsx | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop/src/profile.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop/src/setup-wizard-contract.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop/src/setup-wizard-copy.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop/src/setup-wizard-window.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop/tests/profile.spec.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop/tests/setup-wizard-copy.spec.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop/tests/setup-wizard-native-ui.spec.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| 6c223c2c0441b344b981ed9bce04d7bb1e542add | dsh-plugin-desktop/tests/setup-wizard-window.spec.ts | SKIP | official market onboarding 功能；HuaAnWork 市场联合类型和向导不同 |
| c0b4250d9ef41179e4f347dd56830acb2be101df | (merge container, zero direct files) | SKIP | merge 容器；子提交已独立裁定 |
| 05dfeef22d985824d0d5a82cd10c1cdb4dfa7a46 | dsh-desktop-next/src/client/computer-use.tsx | SKIP | plugin-controls 是参考产品 UI，HuaAnWork 无该组件 |
| 05dfeef22d985824d0d5a82cd10c1cdb4dfa7a46 | dsh-desktop-next/src/client/plugin-controls.tsx | SKIP | plugin-controls 是参考产品 UI，HuaAnWork 无该组件 |
| 05dfeef22d985824d0d5a82cd10c1cdb4dfa7a46 | dsh-desktop-next/tests/plugin-detail-navigation.spec.ts | SKIP | plugin-controls 是参考产品 UI，HuaAnWork 无该组件 |
| 05dfeef22d985824d0d5a82cd10c1cdb4dfa7a46 | dsh-plugin-desktop-beta/src/client/plugin-controls.tsx | SKIP | plugin-controls 是参考产品 UI，HuaAnWork 无该组件 |
| 05dfeef22d985824d0d5a82cd10c1cdb4dfa7a46 | dsh-plugin-desktop/src/client/plugin-controls.tsx | SKIP | plugin-controls 是参考产品 UI，HuaAnWork 无该组件 |
| d5589338a7850b4cfac2c7d5773deb6161deb897 | (merge container, zero direct files) | SKIP | merge 容器；子提交已独立裁定 |
| 4096f20bf981f253b36f2c40f3706bd870645546 | dsh-desktop-next/README.md | SKIP | Next drag region 与 rc.2 patch 组合，不适用当前 HuaAnWork |
| 4096f20bf981f253b36f2c40f3706bd870645546 | dsh-desktop-next/scripts/verify-window-controls.mjs | SKIP | Next drag region 与 rc.2 patch 组合，不适用当前 HuaAnWork |
| 4096f20bf981f253b36f2c40f3706bd870645546 | dsh-desktop-next/src/client/index.ts | SKIP | Next drag region 与 rc.2 patch 组合，不适用当前 HuaAnWork |
| 4096f20bf981f253b36f2c40f3706bd870645546 | dsh-desktop-next/src/client/styles.ts | SKIP | Next drag region 与 rc.2 patch 组合，不适用当前 HuaAnWork |
| 4096f20bf981f253b36f2c40f3706bd870645546 | package.json | SKIP | Next drag region 与 rc.2 patch 组合，不适用当前 HuaAnWork |
| 4096f20bf981f253b36f2c40f3706bd870645546 | patches/dsh-client-ui-conversation@0.2.1-rc.2.patch | SKIP | Next drag region 与 rc.2 patch 组合，不适用当前 HuaAnWork |
| 4096f20bf981f253b36f2c40f3706bd870645546 | patches/dsh-client-ui-plugin-manager@0.2.1-rc.2.patch | SKIP | Next drag region 与 rc.2 patch 组合，不适用当前 HuaAnWork |
| 4096f20bf981f253b36f2c40f3706bd870645546 | yarn.lock | SKIP | Next drag region 与 rc.2 patch 组合，不适用当前 HuaAnWork |
| f35893965c12a209f46408a376759850ff128bbd | (merge container, zero direct files) | SKIP | merge 容器；子提交已独立裁定 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | .github/workflows/ci.yml | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/docs/stable-next-transition.i18n.yaml | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/docs/stable-next-transition.md | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/docs/stable-next-transition.zh.md | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/src/desktop-dialog-window.ts | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/src/electron-runtime.ts | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/src/native-dialog-copy.ts | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/src/native-ui/desktop-dialog/App.tsx | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/src/next-transition-notice.ts | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/src/update-checker.ts | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/src/update-download.ts | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/src/update-lifecycle.ts | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/tests/desktop-dialog-native-ui.spec.ts | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/tests/desktop-dialog-window.spec.ts | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/tests/electron-runtime.spec.ts | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/tests/next-transition-notice.spec.ts | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/tests/update-checker.spec.ts | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/tests/update-download.spec.ts | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | dsh-plugin-desktop/tests/updates.spec.ts | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| cd11e12395ff776653fd5c175688e5c8fe420049 | scripts/verify-desktop-variants.mjs | SKIP | Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变 |
| 4122ef3457c77a62a1d5e05632b077ade8a2bdce | dsh-desktop-next/README.i18n.yaml | SKIP | Next 文档翻译 |
| 4122ef3457c77a62a1d5e05632b077ade8a2bdce | dsh-desktop-next/README.zh.md | SKIP | Next 文档翻译 |
| 65321d32a3409e3d02e41eadce21b5f69c85a1ff | (merge container, zero direct files) | SKIP | merge 容器；子提交已独立裁定 |
| 6a63b9730b82cf4e858b9a11ac9783da9a5a0c3a | dsh-desktop-next/package.json | SKIP | 旧 AA artifact/测试覆盖变化；fork 已有 Schemastery 支持且 AA artifact 更新 |
| 6a63b9730b82cf4e858b9a11ac9783da9a5a0c3a | dsh-plugin-desktop-beta/package.json | SKIP | 旧 AA artifact/测试覆盖变化；fork 已有 Schemastery 支持且 AA artifact 更新 |
| 6a63b9730b82cf4e858b9a11ac9783da9a5a0c3a | dsh-plugin-desktop/package.json | SKIP | 旧 AA artifact/测试覆盖变化；fork 已有 Schemastery 支持且 AA artifact 更新 |
| 6a63b9730b82cf4e858b9a11ac9783da9a5a0c3a | package.json | SKIP | 旧 AA artifact/测试覆盖变化；fork 已有 Schemastery 支持且 AA artifact 更新 |
| 6a63b9730b82cf4e858b9a11ac9783da9a5a0c3a | scripts/agents-anywhere-release-policy.test.mjs | SKIP | 旧 AA artifact/测试覆盖变化；fork 已有 Schemastery 支持且 AA artifact 更新 |
| 6a63b9730b82cf4e858b9a11ac9783da9a5a0c3a | scripts/prepare-agents-anywhere-release.mjs | ALREADY | fork 已有 Schemastery 3.18.5 → cosmokit 1.8.6 映射 |
| 6a63b9730b82cf4e858b9a11ac9783da9a5a0c3a | vendor/agents-anywhere/agents-anywhere-dsh-bridge-next-2.1.0-desktop.c39b82d4fffb1.r2e406d2a.tgz | SKIP | 旧 AA artifact/测试覆盖变化；fork 已有 Schemastery 支持且 AA artifact 更新 |
| 6a63b9730b82cf4e858b9a11ac9783da9a5a0c3a | vendor/agents-anywhere/provenance.json | SKIP | 旧 AA artifact/测试覆盖变化；fork 已有 Schemastery 支持且 AA artifact 更新 |
| 6a63b9730b82cf4e858b9a11ac9783da9a5a0c3a | yarn.lock | SKIP | 旧 AA artifact/测试覆盖变化；fork 已有 Schemastery 支持且 AA artifact 更新 |
| a859a4791f8b86355f956746841e83b6dbd3d65a | README.en.md | SKIP | 上游团队介绍链接，不属于单桌面维护 |
| a859a4791f8b86355f956746841e83b6dbd3d65a | README.i18n.yaml | SKIP | 上游团队介绍链接，不属于单桌面维护 |
| a859a4791f8b86355f956746841e83b6dbd3d65a | README.md | SKIP | 上游团队介绍链接，不属于单桌面维护 |
| a5c914ce0aee4e80eed77ae1856dab7e642fd10e | (merge container, zero direct files) | SKIP | merge 容器；子提交已独立裁定 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | dsh-desktop-next/package.json | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | dsh-desktop-next/scripts/verify-frontend.mjs | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | dsh-desktop-next/src/client/index.ts | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | dsh-desktop-next/src/client/renderer-recovery.ts | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | dsh-desktop-next/src/desktop-contract.ts | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | dsh-desktop-next/src/ipc.ts | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | dsh-desktop-next/src/main.ts | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | dsh-desktop-next/src/preload-app.ts | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | dsh-desktop-next/src/renderer-recovery.ts | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | dsh-desktop-next/tests/client-renderer-recovery.spec.ts | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | dsh-desktop-next/tests/main-lifecycle.spec.ts | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | dsh-desktop-next/tests/renderer-recovery.spec.ts | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | dsh-plugin-desktop-beta/package.json | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | dsh-plugin-desktop/package.json | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | package.json | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | patches/agents-anywhere-connector-httpx.patch | ALREADY | fork 已删除该 patch，等价修复已被上游 AA 吸收 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | scripts/agents-anywhere-connector.test.mjs | ALREADY | fork connector 测试已适配更新 AA artifact 和 mesh 边界 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | vendor/agents-anywhere/agents-anywhere-dsh-bridge-next-2.1.0-desktop.ca67a3f5b7715.r2e406d2a.tgz | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | vendor/agents-anywhere/provenance.json | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d | yarn.lock | SKIP | Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为 |
| 16d4d97ba6fc02a6526dbcc57036fbd9cbb7f1a9 | dsh-desktop-next/package.json | SKIP | 旧 AA artifact 重钉；fork 已吸收 connector 修复且使用更新 artifact |
| 16d4d97ba6fc02a6526dbcc57036fbd9cbb7f1a9 | dsh-plugin-desktop-beta/package.json | SKIP | 旧 AA artifact 重钉；fork 已吸收 connector 修复且使用更新 artifact |
| 16d4d97ba6fc02a6526dbcc57036fbd9cbb7f1a9 | dsh-plugin-desktop/package.json | SKIP | 旧 AA artifact 重钉；fork 已吸收 connector 修复且使用更新 artifact |
| 16d4d97ba6fc02a6526dbcc57036fbd9cbb7f1a9 | package.json | SKIP | 旧 AA artifact 重钉；fork 已吸收 connector 修复且使用更新 artifact |
| 16d4d97ba6fc02a6526dbcc57036fbd9cbb7f1a9 | patches/agents-anywhere-connector-httpx.patch | ALREADY | fork 已删除该 patch |
| 16d4d97ba6fc02a6526dbcc57036fbd9cbb7f1a9 | scripts/agents-anywhere-connector.test.mjs | SKIP | 旧 AA artifact 重钉；fork 已吸收 connector 修复且使用更新 artifact |
| 16d4d97ba6fc02a6526dbcc57036fbd9cbb7f1a9 | scripts/agents-anywhere-release-policy.mjs | ALREADY | fork 的 aaConnectorResolution 已返回无 patch 的 file: 制品 |
| 16d4d97ba6fc02a6526dbcc57036fbd9cbb7f1a9 | scripts/agents-anywhere-release-policy.test.mjs | SKIP | 旧 AA artifact 重钉；fork 已吸收 connector 修复且使用更新 artifact |
| 16d4d97ba6fc02a6526dbcc57036fbd9cbb7f1a9 | scripts/prepare-agents-anywhere-release.mjs | ALREADY | fork prepare 已使用无 patch 的 file: 制品语义 |
| 16d4d97ba6fc02a6526dbcc57036fbd9cbb7f1a9 | vendor/agents-anywhere/agents-anywhere-dsh-bridge-next-2.1.0-desktop.c43434415e1d6.r2e406d2a.tgz | SKIP | 旧 AA artifact 重钉；fork 已吸收 connector 修复且使用更新 artifact |
| 16d4d97ba6fc02a6526dbcc57036fbd9cbb7f1a9 | vendor/agents-anywhere/provenance.json | SKIP | 旧 AA artifact 重钉；fork 已吸收 connector 修复且使用更新 artifact |
| 16d4d97ba6fc02a6526dbcc57036fbd9cbb7f1a9 | yarn.lock | SKIP | 旧 AA artifact 重钉；fork 已吸收 connector 修复且使用更新 artifact |
| dc44bf0091e1b8b2f4cc1cdea832d0d5f44414a6 | dsh-desktop-next/package.json | SKIP | Next renderer health 功能，非 HuaAnWork 维护范围 |
| dc44bf0091e1b8b2f4cc1cdea832d0d5f44414a6 | dsh-desktop-next/scripts/verify-window-controls.mjs | SKIP | Next renderer health 功能，非 HuaAnWork 维护范围 |
| dc44bf0091e1b8b2f4cc1cdea832d0d5f44414a6 | dsh-desktop-next/src/client/index.ts | SKIP | Next renderer health 功能，非 HuaAnWork 维护范围 |
| dc44bf0091e1b8b2f4cc1cdea832d0d5f44414a6 | dsh-desktop-next/src/client/renderer-recovery.ts | SKIP | Next renderer health 功能，非 HuaAnWork 维护范围 |
| dc44bf0091e1b8b2f4cc1cdea832d0d5f44414a6 | dsh-desktop-next/src/renderer-recovery.ts | SKIP | Next renderer health 功能，非 HuaAnWork 维护范围 |
| dc44bf0091e1b8b2f4cc1cdea832d0d5f44414a6 | dsh-desktop-next/tests/client-renderer-recovery.spec.ts | SKIP | Next renderer health 功能，非 HuaAnWork 维护范围 |
| dc44bf0091e1b8b2f4cc1cdea832d0d5f44414a6 | dsh-desktop-next/tests/renderer-recovery.spec.ts | SKIP | Next renderer health 功能，非 HuaAnWork 维护范围 |
| 1d40b5724a4f7bb5fc05b87fe384f02cfa67b2e5 | dsh-desktop-next/scripts/verify-window-controls.mjs | SKIP | Next 设置导航滚动 UI 功能 |
| 1d40b5724a4f7bb5fc05b87fe384f02cfa67b2e5 | dsh-desktop-next/src/client/styles.ts | SKIP | Next 设置导航滚动 UI 功能 |
| 1d40b5724a4f7bb5fc05b87fe384f02cfa67b2e5 | dsh-desktop-next/tests/settings-adapter.spec.ts | SKIP | Next 设置导航滚动 UI 功能 |
| e8fda1919ece81d63fc23581339870341ce79d79 | dsh-desktop-next/README.i18n.yaml | SKIP | Next pre-Host onboarding 功能 |
| e8fda1919ece81d63fc23581339870341ce79d79 | dsh-desktop-next/README.md | SKIP | Next pre-Host onboarding 功能 |
| e8fda1919ece81d63fc23581339870341ce79d79 | dsh-desktop-next/README.zh.md | SKIP | Next pre-Host onboarding 功能 |
| e8fda1919ece81d63fc23581339870341ce79d79 | dsh-desktop-next/scripts/verify-onboarding.mjs | SKIP | Next pre-Host onboarding 功能 |
| e8fda1919ece81d63fc23581339870341ce79d79 | dsh-desktop-next/src/main.ts | SKIP | Next pre-Host onboarding 功能 |
| e8fda1919ece81d63fc23581339870341ce79d79 | dsh-desktop-next/src/native-ui/main.tsx | SKIP | Next pre-Host onboarding 功能 |
| e8fda1919ece81d63fc23581339870341ce79d79 | dsh-desktop-next/src/native-ui/onboarding.css | SKIP | Next pre-Host onboarding 功能 |
| e8fda1919ece81d63fc23581339870341ce79d79 | dsh-desktop-next/src/native-ui/onboarding.tsx | SKIP | Next pre-Host onboarding 功能 |
| e8fda1919ece81d63fc23581339870341ce79d79 | dsh-desktop-next/src/native-ui/theme.css | SKIP | Next pre-Host onboarding 功能 |
| e8fda1919ece81d63fc23581339870341ce79d79 | dsh-desktop-next/tests/main-lifecycle.spec.ts | SKIP | Next pre-Host onboarding 功能 |
| 580984e920f364b5d9b3b3063925cc7e29cb9c0b | .yarn/patches/dshmarket-desktop.patch | ALREADY | fork 的 1.70.2 patch 已包含等价 hostProvidedNpmVersions/holdYoungReleases 修复 |
| 580984e920f364b5d9b3b3063925cc7e29cb9c0b | dsh-desktop-next/package.json | SKIP | dshmarket 1.66.45 patch 适配；fork 已有 1.70.2 的更新适配 |
| 580984e920f364b5d9b3b3063925cc7e29cb9c0b | dsh-plugin-desktop-beta/package.json | SKIP | dshmarket 1.66.45 patch 适配；fork 已有 1.70.2 的更新适配 |
| 580984e920f364b5d9b3b3063925cc7e29cb9c0b | dsh-plugin-desktop/package.json | SKIP | dshmarket 1.66.45 patch 适配；fork 已有 1.70.2 的更新适配 |
| 580984e920f364b5d9b3b3063925cc7e29cb9c0b | package.json | SKIP | dshmarket 1.66.45 patch 适配；fork 已有 1.70.2 的更新适配 |
| 580984e920f364b5d9b3b3063925cc7e29cb9c0b | yarn.lock | SKIP | dshmarket 1.66.45 patch 适配；fork 已有 1.70.2 的更新适配 |
| 2f6e721d475910a26665397616fd3798adc5d0fb | dsh-desktop-next/package.json | SKIP | 上游 CI 硬化不整批移植；safe-mode Windows 清理测试修复登记为后续独立测试任务 |
| 2f6e721d475910a26665397616fd3798adc5d0fb | dsh-desktop-next/scripts/verify-window-controls.mjs | SKIP | 上游 CI 硬化不整批移植；safe-mode Windows 清理测试修复登记为后续独立测试任务 |
| 2f6e721d475910a26665397616fd3798adc5d0fb | dsh-desktop-next/tests/package.spec.ts | SKIP | 上游 CI 硬化不整批移植；safe-mode Windows 清理测试修复登记为后续独立测试任务 |
| 2f6e721d475910a26665397616fd3798adc5d0fb | dsh-plugin-desktop-beta/package.json | ALREADY | fork 已把 meshcall-router-darwin-* 纳入 mac x64ArchFiles；本地等价：`dsh-plugin-huaanwork/package.json:511` 的 `build.mac.x64ArchFiles`（含 `meshcall-router-darwin-*/**`） |
| 2f6e721d475910a26665397616fd3798adc5d0fb | dsh-plugin-desktop-beta/scripts/verify-packaged-runtime.ts | SKIP | 上游 CI 硬化不整批移植；safe-mode Windows 清理测试修复登记为后续独立测试任务 |
| 2f6e721d475910a26665397616fd3798adc5d0fb | dsh-plugin-desktop-beta/scripts/verify-profile-boot.mjs | ALREADY | fork 已读取 AA 2.1.0 manager-lock 租约；本地等价：`dsh-plugin-huaanwork/scripts/verify-profile-boot.mjs:437-438`（AA 段：`:437` 的 `const endpoint = join(userInfo().homedir, '.agents-anywhere', 'dsh-bridge', '.manager-lock.json')` 与 `:438` 的 `if (!existsSync(endpoint))`；该文件是顶层脚本，无函数符号） |
| 2f6e721d475910a26665397616fd3798adc5d0fb | dsh-plugin-desktop-beta/tests/host-process-integration.spec.ts | SKIP | 上游 CI 硬化不整批移植；safe-mode Windows 清理测试修复登记为后续独立测试任务 |
| 2f6e721d475910a26665397616fd3798adc5d0fb | dsh-plugin-desktop-beta/tests/primary-runtime.spec.ts | SKIP | 上游 CI 硬化不整批移植；safe-mode Windows 清理测试修复登记为后续独立测试任务 |
| 2f6e721d475910a26665397616fd3798adc5d0fb | dsh-plugin-desktop-beta/tests/safe-mode.spec.ts | SKIP | 上游 CI 硬化不整批移植；safe-mode Windows 清理测试修复登记为后续独立测试任务 |
| 2f6e721d475910a26665397616fd3798adc5d0fb | dsh-plugin-desktop/package.json | ALREADY | fork 已把 meshcall-router-darwin-* 纳入 mac x64ArchFiles；本地等价：`dsh-plugin-huaanwork/package.json:511` 的 `build.mac.x64ArchFiles`（含 `meshcall-router-darwin-*/**`） |
| 2f6e721d475910a26665397616fd3798adc5d0fb | dsh-plugin-desktop/scripts/verify-packaged-runtime.ts | SKIP | 上游 CI 硬化不整批移植；safe-mode Windows 清理测试修复登记为后续独立测试任务 |
| 2f6e721d475910a26665397616fd3798adc5d0fb | dsh-plugin-desktop/scripts/verify-profile-boot.mjs | ALREADY | fork 已读取 AA 2.1.0 manager-lock 租约；本地等价：`dsh-plugin-huaanwork/scripts/verify-profile-boot.mjs:437-438`（AA 段：`:437` 的 `const endpoint = join(userInfo().homedir, '.agents-anywhere', 'dsh-bridge', '.manager-lock.json')` 与 `:438` 的 `if (!existsSync(endpoint))`；该文件是顶层脚本，无函数符号） |
| 2f6e721d475910a26665397616fd3798adc5d0fb | dsh-plugin-desktop/tests/host-process-integration.spec.ts | SKIP | 上游 CI 硬化不整批移植；safe-mode Windows 清理测试修复登记为后续独立测试任务 |
| 2f6e721d475910a26665397616fd3798adc5d0fb | dsh-plugin-desktop/tests/primary-runtime.spec.ts | SKIP | 上游 CI 硬化不整批移植；safe-mode Windows 清理测试修复登记为后续独立测试任务 |
| 2f6e721d475910a26665397616fd3798adc5d0fb | dsh-plugin-desktop/tests/safe-mode.spec.ts | SKIP | 上游 CI 硬化不整批移植；safe-mode Windows 清理测试修复登记为后续独立测试任务 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | .github/workflows/ci.yml | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-desktop-next/package.json | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-desktop-next/scripts/prepare-runtime.ts | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-desktop-next/scripts/runtime-file-policy.ts | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-desktop-next/tests/package.spec.ts | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-desktop-next/tests/prepare-runtime.spec.ts | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-desktop-next/tests/primary-runtime.spec.ts | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-desktop-next/tests/runtime-file-policy.spec.ts | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop-beta/README.i18n.yaml | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop-beta/README.md | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop-beta/README.zh.md | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop-beta/package.json | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop-beta/scripts/package-linux.ts | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop-beta/scripts/prepare-runtime.ts | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop-beta/scripts/verify-packaged-runtime.ts | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop-beta/tests/package.spec.ts | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop-beta/tests/prepare-runtime.spec.ts | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop/README.i18n.yaml | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop/README.md | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop/README.zh.md | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop/package.json | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop/scripts/package-linux.ts | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop/scripts/prepare-runtime.ts | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop/scripts/verify-packaged-runtime.ts | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop/tests/package.spec.ts | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| 0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e | dsh-plugin-desktop/tests/prepare-runtime.spec.ts | SKIP | Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1 |
| eef3a8873ef057d5bd5c5f04a60c2e00a979e33d | .github/workflows/ci.yml | SKIP | 上游 CI 性能优化，不是单桌面正确性维护；本计划独立收窄 CI |
| eef3a8873ef057d5bd5c5f04a60c2e00a979e33d | dsh-plugin-desktop-beta/scripts/package-linux.ts | SKIP | 上游 CI 性能优化，不是单桌面正确性维护；本计划独立收窄 CI |
| eef3a8873ef057d5bd5c5f04a60c2e00a979e33d | dsh-plugin-desktop-beta/scripts/package-mac.ts | SKIP | 上游 CI 性能优化，不是单桌面正确性维护；本计划独立收窄 CI |
| eef3a8873ef057d5bd5c5f04a60c2e00a979e33d | dsh-plugin-desktop-beta/scripts/package-win.ts | ALREADY | fork 已有 windowsCompressionOverride，CI 已使用 store；本地等价：`dsh-plugin-huaanwork/scripts/package-win.ts:29` 的 `windowsCompressionOverride()`（调用点 `:158`） |
| eef3a8873ef057d5bd5c5f04a60c2e00a979e33d | dsh-plugin-desktop-beta/tests/package-linux.spec.ts | SKIP | 上游 CI 性能优化，不是单桌面正确性维护；本计划独立收窄 CI |
| eef3a8873ef057d5bd5c5f04a60c2e00a979e33d | dsh-plugin-desktop-beta/tests/package-mac.spec.ts | SKIP | 上游 CI 性能优化，不是单桌面正确性维护；本计划独立收窄 CI |
| eef3a8873ef057d5bd5c5f04a60c2e00a979e33d | dsh-plugin-desktop-beta/tests/package-win.spec.ts | SKIP | 上游 CI 性能优化，不是单桌面正确性维护；本计划独立收窄 CI |
| eef3a8873ef057d5bd5c5f04a60c2e00a979e33d | dsh-plugin-desktop-beta/tests/package.spec.ts | SKIP | 上游 CI 性能优化，不是单桌面正确性维护；本计划独立收窄 CI |
| eef3a8873ef057d5bd5c5f04a60c2e00a979e33d | dsh-plugin-desktop/scripts/package-linux.ts | SKIP | 上游 CI 性能优化，不是单桌面正确性维护；本计划独立收窄 CI |
| eef3a8873ef057d5bd5c5f04a60c2e00a979e33d | dsh-plugin-desktop/scripts/package-mac.ts | SKIP | 上游 CI 性能优化，不是单桌面正确性维护；本计划独立收窄 CI |
| eef3a8873ef057d5bd5c5f04a60c2e00a979e33d | dsh-plugin-desktop/scripts/package-win.ts | ALREADY | fork 已有 windowsCompressionOverride，CI 已使用 store；本地等价：`dsh-plugin-huaanwork/scripts/package-win.ts:29` 的 `windowsCompressionOverride()`（调用点 `:158`） |
| eef3a8873ef057d5bd5c5f04a60c2e00a979e33d | dsh-plugin-desktop/tests/package-linux.spec.ts | SKIP | 上游 CI 性能优化，不是单桌面正确性维护；本计划独立收窄 CI |
| eef3a8873ef057d5bd5c5f04a60c2e00a979e33d | dsh-plugin-desktop/tests/package-mac.spec.ts | SKIP | 上游 CI 性能优化，不是单桌面正确性维护；本计划独立收窄 CI |
| eef3a8873ef057d5bd5c5f04a60c2e00a979e33d | dsh-plugin-desktop/tests/package-win.spec.ts | SKIP | 上游 CI 性能优化，不是单桌面正确性维护；本计划独立收窄 CI |
| eef3a8873ef057d5bd5c5f04a60c2e00a979e33d | dsh-plugin-desktop/tests/package.spec.ts | SKIP | 上游 CI 性能优化，不是单桌面正确性维护；本计划独立收窄 CI |
| eef3a8873ef057d5bd5c5f04a60c2e00a979e33d | package.json | SKIP | 上游 CI 性能优化，不是单桌面正确性维护；本计划独立收窄 CI |
| 6f987d94d6cfc86fc6e20c814f1c6e0fa0551879 | dsh-desktop-next/scripts/verify-window-controls.mjs | SKIP | Next 设置 UI 功能 |
| 6f987d94d6cfc86fc6e20c814f1c6e0fa0551879 | dsh-desktop-next/src/client/DesktopSettingsSection.tsx | SKIP | Next 设置 UI 功能 |
| 6f987d94d6cfc86fc6e20c814f1c6e0fa0551879 | dsh-desktop-next/src/client/desktop-settings-styles.ts | SKIP | Next 设置 UI 功能 |
| 6f987d94d6cfc86fc6e20c814f1c6e0fa0551879 | dsh-desktop-next/src/client/index.ts | SKIP | Next 设置 UI 功能 |
| 6f987d94d6cfc86fc6e20c814f1c6e0fa0551879 | dsh-desktop-next/src/client/permissions.tsx | SKIP | Next 设置 UI 功能 |
| 6f987d94d6cfc86fc6e20c814f1c6e0fa0551879 | dsh-desktop-next/src/client/plugin-controls.tsx | SKIP | Next 设置 UI 功能 |
| 6f987d94d6cfc86fc6e20c814f1c6e0fa0551879 | dsh-desktop-next/src/client/settings-adapter.ts | SKIP | Next 设置 UI 功能 |
| 6f987d94d6cfc86fc6e20c814f1c6e0fa0551879 | dsh-desktop-next/src/client/settings.tsx | SKIP | Next 设置 UI 功能 |
| 6f987d94d6cfc86fc6e20c814f1c6e0fa0551879 | dsh-desktop-next/src/client/updates.tsx | SKIP | Next 设置 UI 功能 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-desktop-next/README.i18n.yaml | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-desktop-next/README.md | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-desktop-next/README.zh.md | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-desktop-next/package.json | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-desktop-next/scripts/verify-window-controls.mjs | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-desktop-next/src/client/computer-use.tsx | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-desktop-next/src/client/plugin-controls.tsx | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-desktop-next/tests/plugin-detail-navigation.spec.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop-beta/package.json | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop-beta/src/client/plugin-controls.tsx | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop-beta/src/main.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop-beta/src/profile-schedule.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop-beta/src/profile.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop-beta/tests/package.spec.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop-beta/tests/primary-runtime.spec.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop-beta/tests/profile-schedule.spec.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop-beta/tests/profile.spec.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/docs/stable-next-transition.i18n.yaml | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/docs/stable-next-transition.md | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/docs/stable-next-transition.zh.md | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/package.json | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/src/client/plugin-controls.tsx | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/src/desktop-dialog-window.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/src/main.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/src/native-ui/desktop-dialog/App.tsx | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/src/next-transition-notice.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/src/profile-schedule.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/src/profile.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/tests/desktop-dialog-native-ui.spec.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/tests/desktop-dialog-window.spec.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/tests/next-transition-notice.spec.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/tests/package.spec.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/tests/primary-runtime.spec.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/tests/profile-schedule.spec.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | dsh-plugin-desktop/tests/profile.spec.ts | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | scripts/verify-desktop-variants.mjs | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 779968651e705fd81aef984ac8852fc081110ebb | yarn.lock | SKIP | rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为 |
| 0f72133c150dc7a0ae673558703ea4e6b3dc18e3 | dsh-desktop-next/README.i18n.yaml | SKIP | Next pre-Host onboarding UI 功能 |
| 0f72133c150dc7a0ae673558703ea4e6b3dc18e3 | dsh-desktop-next/README.md | SKIP | Next pre-Host onboarding UI 功能 |
| 0f72133c150dc7a0ae673558703ea4e6b3dc18e3 | dsh-desktop-next/README.zh.md | SKIP | Next pre-Host onboarding UI 功能 |
| 0f72133c150dc7a0ae673558703ea4e6b3dc18e3 | dsh-desktop-next/scripts/verify-onboarding.mjs | SKIP | Next pre-Host onboarding UI 功能 |
| 0f72133c150dc7a0ae673558703ea4e6b3dc18e3 | dsh-desktop-next/src/client/index.ts | SKIP | Next pre-Host onboarding UI 功能 |
| 0f72133c150dc7a0ae673558703ea4e6b3dc18e3 | dsh-desktop-next/src/desktop-contract.ts | SKIP | Next pre-Host onboarding UI 功能 |
| 0f72133c150dc7a0ae673558703ea4e6b3dc18e3 | dsh-desktop-next/src/main.ts | SKIP | Next pre-Host onboarding UI 功能 |
| 0f72133c150dc7a0ae673558703ea4e6b3dc18e3 | dsh-desktop-next/src/native-ui/main.tsx | SKIP | Next pre-Host onboarding UI 功能 |
| 0f72133c150dc7a0ae673558703ea4e6b3dc18e3 | dsh-desktop-next/src/native-ui/onboarding.css | SKIP | Next pre-Host onboarding UI 功能 |
| 0f72133c150dc7a0ae673558703ea4e6b3dc18e3 | dsh-desktop-next/src/native-ui/onboarding.tsx | SKIP | Next pre-Host onboarding UI 功能 |
| 0f72133c150dc7a0ae673558703ea4e6b3dc18e3 | dsh-desktop-next/src/native-ui/theme.css | SKIP | Next pre-Host onboarding UI 功能 |
| 0f72133c150dc7a0ae673558703ea4e6b3dc18e3 | dsh-desktop-next/src/profiles.ts | SKIP | Next pre-Host onboarding UI 功能 |
| 0f72133c150dc7a0ae673558703ea4e6b3dc18e3 | dsh-desktop-next/tests/main-lifecycle.spec.ts | SKIP | Next pre-Host onboarding UI 功能 |
| 0f72133c150dc7a0ae673558703ea4e6b3dc18e3 | dsh-desktop-next/tests/profiles.spec.ts | SKIP | Next pre-Host onboarding UI 功能 |
| f6271d7bf7710cdd6291fa5f37ea01d91e1ac9a8 | dsh-desktop-next/src/desktop-runtime.ts | SKIP | Next 启动性能优化，未证明适用于 HuaAnWork 当前架构 |
| f6271d7bf7710cdd6291fa5f37ea01d91e1ac9a8 | dsh-desktop-next/src/host/index.ts | SKIP | Next 启动性能优化，未证明适用于 HuaAnWork 当前架构 |
| f6271d7bf7710cdd6291fa5f37ea01d91e1ac9a8 | dsh-desktop-next/src/host/logging.ts | SKIP | Next 启动性能优化，未证明适用于 HuaAnWork 当前架构 |
| f6271d7bf7710cdd6291fa5f37ea01d91e1ac9a8 | dsh-desktop-next/src/host/official-diagnostics.ts | SKIP | Next 启动性能优化，未证明适用于 HuaAnWork 当前架构 |
| f6271d7bf7710cdd6291fa5f37ea01d91e1ac9a8 | dsh-desktop-next/src/main.ts | SKIP | Next 启动性能优化，未证明适用于 HuaAnWork 当前架构 |
| f6271d7bf7710cdd6291fa5f37ea01d91e1ac9a8 | dsh-desktop-next/tests/host-logging.spec.ts | SKIP | Next 启动性能优化，未证明适用于 HuaAnWork 当前架构 |
| f6271d7bf7710cdd6291fa5f37ea01d91e1ac9a8 | dsh-desktop-next/tests/main-lifecycle.spec.ts | SKIP | Next 启动性能优化，未证明适用于 HuaAnWork 当前架构 |
| 9caca3f6219218e5bf270ba87c478e226b688995 | dsh-desktop-next/src/main.ts | SKIP | Next recovery bundle 依赖和 toggle UI 行为变化 |
| 9caca3f6219218e5bf270ba87c478e226b688995 | dsh-desktop-next/src/profiles.ts | SKIP | Next recovery bundle 依赖和 toggle UI 行为变化 |
| 9caca3f6219218e5bf270ba87c478e226b688995 | dsh-desktop-next/src/recovery.ts | SKIP | Next recovery bundle 依赖和 toggle UI 行为变化 |
| 9caca3f6219218e5bf270ba87c478e226b688995 | dsh-desktop-next/tests/main-lifecycle.spec.ts | SKIP | Next recovery bundle 依赖和 toggle UI 行为变化 |
| 9caca3f6219218e5bf270ba87c478e226b688995 | dsh-desktop-next/tests/profiles.spec.ts | SKIP | Next recovery bundle 依赖和 toggle UI 行为变化 |
| 9caca3f6219218e5bf270ba87c478e226b688995 | dsh-desktop-next/tests/recovery.spec.ts | SKIP | Next recovery bundle 依赖和 toggle UI 行为变化 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-desktop-next/package.json | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-desktop-next/tests/prepare-payload.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-desktop-next/tests/prepare-runtime.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-desktop-next/tests/primary-runtime.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-desktop-next/tests/runtime-fixture.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-desktop-next/tests/workspace-file-drive-path-win32.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-desktop-next/tests/workspace-file-drive-path.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-desktop-next/vitest.config.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop-beta/THIRD_PARTY_NOTICES.md | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop-beta/package.json | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop-beta/src/desktop-dialog-window.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop-beta/src/desktop-port.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop-beta/src/webserver.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop-beta/tests/desktop-dialog-window.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop-beta/tests/package.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop-beta/tests/prepare-runtime.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop-beta/tests/primary-runtime.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop-beta/tests/recovery-plugin-uninstall.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop-beta/tests/webserver.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop/THIRD_PARTY_NOTICES.md | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop/package.json | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop/src/desktop-dialog-window.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop/src/desktop-port.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop/src/webserver.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop/tests/desktop-dialog-window.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop/tests/package.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop/tests/prepare-runtime.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop/tests/primary-runtime.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop/tests/recovery-plugin-uninstall.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | dsh-plugin-desktop/tests/webserver.spec.ts | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | package.json | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | patches/dsh-client-ui-conversation@0.2.1-rc.2.patch | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | patches/dsh-fs-local@0.2.1-rc.2.patch | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | patches/pi-ai@0.87.1.patch | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | patches/pi-ai@1.0.2.patch | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | patches/pi-ai@1.1.0.patch | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | patches/pnpm@11.28.5.patch | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | patches/pnpm@11.8.0.patch | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | scripts/conversation-draft-compat.test.mjs | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 271cc526e493a2e0fb427671cc44644ad5d32508 | yarn.lock | SKIP | rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选 |
| 62723fdc43710f44ef9b804b44f57cc0c5c308c7 | dsh-desktop-next/src/host-process.ts | SKIP | Next staged update shutdown 行为，HuaAnWork 更新协议不变 |
| 62723fdc43710f44ef9b804b44f57cc0c5c308c7 | dsh-desktop-next/src/main.ts | SKIP | Next staged update shutdown 行为，HuaAnWork 更新协议不变 |
| 62723fdc43710f44ef9b804b44f57cc0c5c308c7 | dsh-desktop-next/tests/main-lifecycle.spec.ts | SKIP | Next staged update shutdown 行为，HuaAnWork 更新协议不变 |
| 88b9bbdbe7f2bc9012336912c55436adec08ed92 | dsh-desktop-next/src/client/updates.tsx | SKIP | Next Linux 更新 UI；HuaAnWork 无 Linux 发行线 |
| 88b9bbdbe7f2bc9012336912c55436adec08ed92 | dsh-desktop-next/src/desktop-menu.ts | SKIP | Next Linux 更新 UI；HuaAnWork 无 Linux 发行线 |
| 88b9bbdbe7f2bc9012336912c55436adec08ed92 | dsh-desktop-next/src/main.ts | SKIP | Next Linux 更新 UI；HuaAnWork 无 Linux 发行线 |
| 88b9bbdbe7f2bc9012336912c55436adec08ed92 | dsh-desktop-next/src/updates.ts | SKIP | Next Linux 更新 UI；HuaAnWork 无 Linux 发行线 |
| 88b9bbdbe7f2bc9012336912c55436adec08ed92 | dsh-desktop-next/tests/desktop-menu.spec.ts | SKIP | Next Linux 更新 UI；HuaAnWork 无 Linux 发行线 |
| 88b9bbdbe7f2bc9012336912c55436adec08ed92 | dsh-desktop-next/tests/updates.spec.ts | SKIP | Next Linux 更新 UI；HuaAnWork 无 Linux 发行线 |
| 584fb4909352d744be6b0f020db9151126796f4e | dsh-desktop-next/src/client/DesktopSettingsSection.tsx | SKIP | Next sidebar footer 与布局设置功能 |
| 584fb4909352d744be6b0f020db9151126796f4e | dsh-desktop-next/src/client/index.ts | SKIP | Next sidebar footer 与布局设置功能 |
| 584fb4909352d744be6b0f020db9151126796f4e | dsh-desktop-next/src/client/settings-adapter.ts | SKIP | Next sidebar footer 与布局设置功能 |
| 584fb4909352d744be6b0f020db9151126796f4e | dsh-desktop-next/src/client/settings.tsx | SKIP | Next sidebar footer 与布局设置功能 |
| 584fb4909352d744be6b0f020db9151126796f4e | dsh-desktop-next/src/client/sidebar-footer-styles.ts | SKIP | Next sidebar footer 与布局设置功能 |
| 584fb4909352d744be6b0f020db9151126796f4e | dsh-desktop-next/src/desktop-contract.ts | SKIP | Next sidebar footer 与布局设置功能 |
| 584fb4909352d744be6b0f020db9151126796f4e | dsh-desktop-next/src/desktop-preferences.ts | SKIP | Next sidebar footer 与布局设置功能 |
| 584fb4909352d744be6b0f020db9151126796f4e | dsh-desktop-next/tests/desktop-state.spec.ts | SKIP | Next sidebar footer 与布局设置功能 |
| 584fb4909352d744be6b0f020db9151126796f4e | dsh-desktop-next/tests/settings-adapter.spec.ts | SKIP | Next sidebar footer 与布局设置功能 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/package.json | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/scripts/package.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/scripts/packaged-payload.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/scripts/packaging-builder.mjs | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/scripts/packaging-command.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/scripts/packaging-step.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/scripts/prepare-pack.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/scripts/prepare-payload.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/scripts/prepare-runtime.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/scripts/primary-runtime.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/scripts/runtime-file-policy.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/scripts/verify-fuses.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/scripts/verify-packaged.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/scripts/windows-asar-unpack.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/src/runtime-tree.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/tests/macos-signing-walk.spec.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/tests/packaged-payload.spec.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/tests/packaging-command.spec.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/tests/packaging-step.spec.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/tests/prepare-payload.spec.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/tests/prepare-runtime.spec.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/tests/runtime-file-policy.spec.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/tests/runtime-tree.spec.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/tests/windows-asar-unpack.spec.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-desktop-next/tests/windows-packaging-builder.spec.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-plugin-desktop-beta/THIRD_PARTY_NOTICES.md | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-plugin-desktop-beta/package.json | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-plugin-desktop-beta/tests/macos-signing-walk.spec.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-plugin-desktop-beta/tests/package.spec.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-plugin-desktop/THIRD_PARTY_NOTICES.md | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-plugin-desktop/package.json | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-plugin-desktop/tests/macos-signing-walk.spec.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | dsh-plugin-desktop/tests/package.spec.ts | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | package.json | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | patches/@electron__osx-sign@1.3.3.patch | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | patches/app-builder-lib@26.15.7.patch | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | patches/pnpm@11.28.5.patch | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | vendor/agents-anywhere/agents-anywhere-dsh-bridge-next-2.1.0-desktop.c6fb6b165d490.r2e406d2a.tgz | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | vendor/agents-anywhere/provenance.json | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 06446375d9e2b6fcbe468a902d45696893de26fd | yarn.lock | SKIP | Next packaging 性能和版本资产批次，非单桌面维护所需 |
| 38379b77176949ccb8eda3b5b96c5179b2c14a29 | dsh-desktop-next/src/client/computer-use-command-ui.tsx | SKIP | Next computer-use 功能 |
| 38379b77176949ccb8eda3b5b96c5179b2c14a29 | dsh-desktop-next/src/client/computer-use.tsx | SKIP | Next computer-use 功能 |
| 38379b77176949ccb8eda3b5b96c5179b2c14a29 | dsh-desktop-next/src/client/index.ts | SKIP | Next computer-use 功能 |
| 38379b77176949ccb8eda3b5b96c5179b2c14a29 | dsh-desktop-next/src/client/plugin-controls-styles.ts | SKIP | Next computer-use 功能 |
| 38379b77176949ccb8eda3b5b96c5179b2c14a29 | dsh-desktop-next/src/client/plugin-controls.tsx | SKIP | Next computer-use 功能 |
| 38379b77176949ccb8eda3b5b96c5179b2c14a29 | dsh-desktop-next/src/extensions.ts | SKIP | Next computer-use 功能 |
| 38379b77176949ccb8eda3b5b96c5179b2c14a29 | dsh-desktop-next/src/host/computer-use-command.ts | SKIP | Next computer-use 功能 |
| 38379b77176949ccb8eda3b5b96c5179b2c14a29 | dsh-desktop-next/tests/computer-use-command.spec.ts | SKIP | Next computer-use 功能 |
| 38379b77176949ccb8eda3b5b96c5179b2c14a29 | dsh-desktop-next/tests/plugin-detail-navigation.spec.ts | SKIP | Next computer-use 功能 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | .github/workflows/ci.yml | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | .gitignore | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/README.i18n.yaml | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/README.md | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/README.zh.md | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/package.json | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/scripts/mac-runtime.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/scripts/package.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/scripts/packaging-command.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/scripts/verify-fuses.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/scripts/verify-mac-release.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/scripts/verify-win-installer.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/scripts/verify-window-controls.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/src/client/DesktopSettingsSection.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/src/client/desktop-settings-styles.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/src/client/index.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/src/client/plugin-controls.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/src/client/settings-adapter.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/src/client/settings.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/src/desktop-runtime.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/src/main.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/src/native-ui/main.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/src/native-ui/onboarding.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/src/native-ui/theme.css | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/src/profiles.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/src/single-instance.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/src/system-proxy.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/src/update-transport.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/src/updates.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/tests/account-continuation.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/tests/desktop-runtime-cleanup.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/tests/main-lifecycle.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/tests/package.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/tests/packaging-command.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/tests/profiles.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/tests/update-installer.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/tests/updates.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/tests/windows-packaging-builder.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-desktop-next/vite.client.config.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/assets/tray-icon-blue.png | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/assets/tray-icon-blue@1.25x.png | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/assets/tray-icon-blue@1.5x.png | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/assets/tray-icon-blue@2x.png | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/assets/tray-iconTemplate.png | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/assets/tray-iconTemplate@2x.png | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/components.json | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/cordis.patch.yml | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/host.cordis.patch.yml | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/package.json | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/before-build.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/clean.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/electron-builder-environment.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/fixtures/isolated-user-host.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/fixtures/recent-registry.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/generate-mac-app-icon.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/generate-tray-icons.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/generate-windows-app-icon.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/mac-runtime.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/mac-universal.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/node-bin/node | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/node-bin/node.cmd | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/office-packages.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/operation-reliability.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/package-dir.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/package-linux.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/package-mac.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/package-win-portable.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/package-win.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/package.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/packaged-driver-smoke.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/packaged-host-smoke.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/packaged-payload.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/packaged-skill-badge-smoke.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/packaging-builder.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/packaging-command.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/packaging-step.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/prepare-fs-ext.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/prepare-pack.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/prepare-payload.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/prepare-runtime.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/primary-runtime.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/probe-windows-installer-quit.ps1 | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/release-mac.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/release-preflight.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/reproduce-windows-installer-running-check.ps1 | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/runtime-closure.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/runtime-closure.spec.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/runtime-file-policy.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/sign-runtime.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/smoke-windows-installer-upgrade.ps1 | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/start.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-cli-runtime.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-desktop-runtime.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-electron-fuses.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-frontend.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-fuses.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-host.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-licenses.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-linux-artifacts.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-loader-boot.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-mac-entitlements.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-mac-release.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-mac-runtime.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-mac-smoke.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-onboarding.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-operation-reliability.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-packaged-runtime.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-packaged.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-plugin-frames.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-profile-boot.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-protocol.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-runtime-closure.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-safe-cleanup.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-sidebar-browser-ui.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-sidebar-browser.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-win-installer.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-win-portable.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/verify-window-controls.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/scripts/windows-asar-unpack.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/agent-error-logging.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/app-downloads.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/asar-archive-policy.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/asar-module-resolver-state.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/auxiliary-window-options.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/backend-controller.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/bin.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/browser-guests.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/AdvancedFrame.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/DesktopFrameTitlebarView.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/DesktopNativeActions.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/DesktopSettingsSection.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/DesktopTerminalSettingsAction.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/ExtendedFrame.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/ExtendedTitlebar.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/advanced-shell.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/assets.d.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/boot-health.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/computer-use-command-ui.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/computer-use.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/contracts.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/desktop-settings-api.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/desktop-settings-locales.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/desktop-settings-styles.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/desktop-settings.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/desktop-state.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/directory-picker.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/environment.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/extended-shell.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/extended-styles.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/index.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/launch-workspace.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/layout-service.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/layout-state.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/market-toggle.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/onboarding.css | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/onboarding.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/permissions.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/plugin-controls-styles.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/plugin-controls.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/renderer-recovery.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/settings-adapter.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/settings-bridge.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/settings-requests.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/settings.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/sidebar-footer-styles.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/styles.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/theme-presenter.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/ui-diagnostics.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/updates.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/client/window-service.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/compatibility-chrome-contract.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/compatibility-preload.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/compatibility-shell.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/context-menu.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/crash-evidence.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/data-directory.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-actions.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-boot-recovery.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-browser-access.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-channel-home.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-cli.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-contract.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-data-directory.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-data-operation-lock.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-dialog-window.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-factory-reset.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-installation-id.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-installer-quit.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-logger.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-market.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-menu.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-network.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-office.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-plugins.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-port.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-preferences.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-runtime-environment.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-runtime.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-settings-contract.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-settings-controller.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-settings-route.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/desktop-terminal.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/developer-logging.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/diagnostic-export-worker.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/diagnostic-export.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/diagnostic-record.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/diagnostics-export.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/diagnostics.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/directory-picker-contract.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/directory-picker-route.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/disposable-tree.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/dsh-product-version.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/electron-permissions.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/electron-platform.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/electron-reveal.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/electron-runtime.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/electron-shell-generation.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/extensions.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/file-exporter.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/file-path-bridge-contract.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host-bootstrap.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host-developer-logging.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host-launch-environment.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host-permissions.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host-process-entry.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host-process.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host-rpc.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host-runtime-bridge.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host/agent-preset.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host/computer-use-command.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host/cua-driver.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host/index.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host/logging.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host/office-engine.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host/office.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host/official-diagnostics.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host/platform-login.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host/resolution.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/host/skill-badge.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/index.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/ipc.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/jobs-bridge.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/keybindings.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/keyboard.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/lan-https-certificate.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/lan-https-ingress.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/lan-https-runtime.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/launch-environment.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/launch-workspace-contract.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/launch-workspace-path.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/lifecycle-events.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/link-projections.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/local-window-policy.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/log-files.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/log-history.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/log-level.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/log-record.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/mac-update-feed.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/main-window-state.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/main.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/menu-locale.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/module-resolution.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-desktop.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-dialog-copy.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-locale.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-menu.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-permissions.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/assets/README.md | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/assets/agents-anywhere-phone.webp | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/assets/agents-anywhere-tablet.webp | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/compatibility-chrome.html | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/compatibility-chrome/main.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/compatibility-chrome/overlay.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/compatibility-chrome/style.css | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/components/ui/alert.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/components/ui/badge.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/components/ui/button.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/components/ui/card.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/components/ui/dialog.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/components/ui/hover-card.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/components/ui/input.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/components/ui/label.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/components/ui/radio-group.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/components/ui/scroll-area.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/components/ui/sonner.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/components/ui/switch.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/components/ui/tabs.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/desktop-dialog.html | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/desktop-dialog/App.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/desktop-dialog/main.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/index.html | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/lib/utils.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/main.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/onboarding.css | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/onboarding.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/profile-create.html | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/profile-create/App.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/profile-create/main.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/profile-selector.html | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/profile-selector/App.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/profile-selector/main.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/recovery.html | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/recovery/App.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/recovery/main.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/setup-wizard.html | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/setup-wizard/App.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/setup-wizard/main.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/shared/DesktopFrame.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/shared/ProfileSelector.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/shared/RecoveryWindowPrimitives.tsx | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/shared/theme.css | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/theme.css | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/native-ui/vite-env.d.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/node-environment.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/notifications.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/official-diagnostics.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/package-overlay.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/packaged-filesystem-smoke.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/packaged-runtime-path.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/packaged-runtime-smoke.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/permissions.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/platform-login-window.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/platform-login.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/plugin-cli.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/plugin-packages.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/pnpm-policy.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/pnpm.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/preload-app.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/preload-browser.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/preload-keyboard.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/preload-locale.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/preload-material.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/preload-menu.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/preload-permissions.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/preload-platform.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/preload-settings.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/preload-shell.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/preload-theme.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/preload-windows.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/preload.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/private-files.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/process-output-logging.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/product-identity.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/profile-channel-admission.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/profile-checkpoint.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/profile-computer-use.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/profile-context.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/profile-create-copy.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/profile-create-window.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/profile-manager.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/profile-materializer.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/profile-plugin-market.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/profile-preferences.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/profile-schedule.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/profile-selection-window.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/profile-service.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/profile.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/profiles.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/recovery-copy.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/recovery-plugin-uninstall.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/recovery-support.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/recovery.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/relaunch-arguments.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/relaunch.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/remote-control-offer.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/renderer-actions-contract.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/renderer-actions-dispatch.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/renderer-boot-contract.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/renderer-boot.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/renderer-health.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/renderer-logging.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/renderer-recovery.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/renderer-surface-watchdog.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/runtime-tree.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/runtime.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/safe-mode.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/session-projcache-recovery.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/settings-bridge.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/setup-onboarding-bridge.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/setup-wizard-contract.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/setup-wizard-copy.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/setup-wizard-settings.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/setup-wizard-state.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/setup-wizard-window.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/shell-locale.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/shutdown.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/single-instance.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/startup-audit.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/startup-error.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/startup-failure-routing.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/startup-generation.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/startup-recovery-controller.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/startup-recovery-window.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/system-proxy.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/terminal.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/tray-icons.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/tray-locale.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/update-checker.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/update-download.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/update-installer.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/update-lifecycle.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/update-state.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/update-transport.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/updates.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/web-document.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/webserver.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/window-chrome.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/window-material.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/window-options.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/windows-acl-runner.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/windows-console-host.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/windows-layout.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/windows-pwsh-sandbox.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/windows-volume-diagnostics.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/src/workspace-admission.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/account-continuation.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/agent-error-logging.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/agent-preset.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/app-downloads.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/asar-archive-policy.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/backend-controller.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/bin.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/browser-links.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/client-boot-health.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/client-desktop-settings.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/client-desktop-update-settings.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/client-directory-picker.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/client-environment.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/client-launch-workspace.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/client-layout-service.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/client-modules-startup.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/client-permissions.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/client-renderer-recovery.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/client-shell-settings.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/client-sidebar-dom-anchor.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/compatibility-chrome-ui.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/compatibility-shell.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/computer-use-command.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/context-menu.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/crash-evidence.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/cua-driver.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/cua-permissions.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/data-directory.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-actions.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-boot-recovery.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-channel-home.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-cli.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-copy.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-data-directory.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-dialog-native-ui.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-dialog-window.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-factory-reset.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-installation-id.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-installer-quit.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-logger.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-market.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-menu.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-office.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-plugins.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-runtime-cleanup.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-runtime-environment.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-runtime-lan.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-settings-api.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-state.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/desktop-terminal.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/developer-logging.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/diagnostic-export.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/diagnostics-export.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/diagnostics.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/directory-picker-route.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/dshmarket-compat.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/electron-permissions.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/electron-platform.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/electron-runtime.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/extensions.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/fixtures/desktop-host-services-smoke-plugin/index.js | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/fixtures/desktop-host-services-smoke-plugin/package.json | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/fixtures/isolated-host/child.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/host-developer-logging.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/host-directory-picker-browse.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/host-entry.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/host-logging.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/host-office.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/host-permissions.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/host-process-entry.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/host-process-integration.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/host-process.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/host-rpc.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/host-runtime-bridge.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/installer-nsh.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/keybindings.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/keyboard.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/lan-addresses.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/lan-https-certificate.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/launch-environment.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/launch-workspace-path.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/lifecycle-events.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/link-projections.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/local-window-policy.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/log-files.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/logging-integration.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/mac-entitlements.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/mac-universal.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/main-lifecycle.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/market-plugin-manager-integration.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/mask-secrets.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/menu-locale.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/module-resolution.integration.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/module-resolution.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/native-locale.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/native-menu.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/native-notifications.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/native-path-opener.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/node-environment.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/notifications-live.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/notifications.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/office-engine.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/office-packages.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/official-diagnostics.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/official-onboarding.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/open-in-app.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/optional-bundles.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/package-dir.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/package-linux.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/package-mac.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/package-overlay.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/package-win.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/package.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/packaged-payload.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/packaging-command.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/packaging-step.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/permissions.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/platform-login-window.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/platform-login.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/plugin-detail-navigation.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/plugin-packages.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/plugin.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/pnpm.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/preload-locale.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/preload.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/prepare-fs-ext.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/prepare-pack.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/prepare-payload.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/prepare-runtime.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/preset-resolution.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/primary-runtime.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/profile-channel-admission.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/profile-checkpoint.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/profile-context.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/profile-create-window.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/profile-manager.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/profile-materializer.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/profile-preferences.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/profile-schedule.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/profile-selection-window.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/profile-service.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/profile.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/profiles.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/recovery-native-ui.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/recovery-navigation.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/recovery-plugin-uninstall.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/recovery-support.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/recovery.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/relaunch-arguments.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/release-mac.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/release-preflight.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/remote-control-offer.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/renderer-actions-dispatch.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/renderer-boot.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/renderer-health.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/renderer-recovery.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/renderer-surface-watchdog.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/request-inventory-resolution.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/runtime-file-policy.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/runtime-fixture.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/runtime-tree.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/safe-mode.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/settings-adapter.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/setup-wizard-copy.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/setup-wizard-native-ui.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/setup-wizard-settings.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/setup-wizard-state.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/setup-wizard-window.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/shell-locale.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/shutdown.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/sign-runtime.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/single-instance.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/skill-badge.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/startup-generation.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/startup-recovery-controller.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/startup-recovery-window.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/system-proxy-egress.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/system-proxy.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/theme-presenter.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/tray-icons.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/update-checker.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/update-download.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/update-installer.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/update-transport.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/updates.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/upstream-session-migration.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/verify-electron-fuses.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/verify-linux-artifacts.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/verify-mac-release.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/verify-mac-smoke.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/verify-packaged-runtime.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/verify-win-installer.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/verify-win-portable.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/web-document.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/webserver.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/window-options.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/windows-asar-unpack.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/windows-packaging-builder.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/windows-pwsh-sandbox.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/windows-volume-diagnostics.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/workspace-admission.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/workspace-file-drive-path-win32.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tests/workspace-file-drive-path.spec.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tsconfig.client.json | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tsconfig.json | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tsconfig.native-ui.json | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tsconfig.packaging.json | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tsconfig.tests.client.json | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tsconfig.tests.json | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/tsdown.config.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/vite.client.config.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/vite.native-ui.config.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | dsh-plugin-desktop-beta/vitest.config.ts | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | package.json | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | scripts/export-app-icons.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | scripts/verify-desktop-onboarding-browser.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | scripts/verify-desktop-variants.mjs | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| ba41476b1038e38a56b90626a9dfb30ece870110 | yarn.lock | SKIP | Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移 |
| 9b0eaefc84b57c05affff58e3b80620928b2cb14 | deepseek-harness | SKIP | rc.3 runtime train；Harness pin 独立且本轮不变 |
| 9b0eaefc84b57c05affff58e3b80620928b2cb14 | upstream.json | SKIP | rc.3 runtime train；Harness pin 独立且本轮不变 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | dsh-community-market/package.json | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | dsh-community-market/tests/contracts.spec.ts | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | dsh-desktop-next/package.json | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | dsh-desktop-next/scripts/verify-frontend.mjs | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | dsh-desktop-next/scripts/verify-host.mjs | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | dsh-desktop-next/scripts/verify-window-controls.mjs | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | dsh-desktop-next/upstream-reference.json | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | dsh-plugin-desktop-beta/package.json | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | dsh-plugin-desktop-beta/scripts/verify-frontend.mjs | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | dsh-plugin-desktop-beta/scripts/verify-host.mjs | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | dsh-plugin-desktop-beta/scripts/verify-window-controls.mjs | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | dsh-plugin-desktop/THIRD_PARTY_NOTICES.md | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | dsh-plugin-desktop/package.json | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | package.json | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-app-boot@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-app-boot@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-modules@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-modules@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-ui-conversation@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-ui-conversation@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-ui-directory-picker-browse@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-ui-directory-picker-browse@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-ui-plugin-manager@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-ui-plugin-manager@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-ui-primitives@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-ui-primitives@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-ui-settings-account@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-ui-settings-account@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-ui-settings-general@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-ui-settings-general@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-ui-settings-shell@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-ui-settings-shell@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-ui-sidebar@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-client-ui-sidebar@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-experimental-computer-use-cua-driver-native@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-experimental-computer-use-cua-driver-native@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-experimental-inspector@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-experimental-inspector@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-fs-local@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-fs-local@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-hmr@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-hmr@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-host-directory-picker-browse@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-host-directory-picker-browse@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-host-open-in-app@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-host-open-in-app@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-plugin-manager@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-plugin-manager@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-plugin-package-inventory-deepseek@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-plugin-package-inventory-deepseek@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-ptc-runtime-node@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-ptc-runtime-node@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-sandbox-windows-acl@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-sandbox-windows-acl@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-subprocess-local@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-subprocess-local@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-web-app@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh-web-app@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh@0.2.1-rc.2.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | patches/dsh@0.2.1-rc.3.patch | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | scripts/agents-anywhere-connector.test.mjs | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | scripts/conversation-draft-compat.test.mjs | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | scripts/inspector-compat.test.mjs | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/agents-anywhere/agents-anywhere-dsh-bridge-next-2.1.0-desktop.cb9f491df9a97.r7504932a.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/agents-anywhere/provenance.json | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-acp-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-acp-app-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-agent-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-agent-default-model-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-agent-instructions-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-agent-loop-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-agent-loop-testkit-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-agent-preset-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-agent-preset-registry-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-agent-tool-presentation-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-anonymous-user-id-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-account-controller-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-gateway-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-job-controller-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-remote-access-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-remotes-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-session-controller-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-settings-controller-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-terminal-controller-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-workspace-controller-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-api-workspace-files-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-app-boot-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-atomic-write-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-attachment-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-attachment-local-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-authorization-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-base-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-bash-local-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-bash-sandbox-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-brand-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-browser-use-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-chunked-list-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-connection-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-file-upload-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-hmr-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-locale-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-modules-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-product-analytics-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-resources-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-shortcuts-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-store-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-test-runtime-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-agent-preset-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-approval-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-attachment-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-brand-official-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-chat-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-commands-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-conversation-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-cordis-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-deepseek-model-label-1017-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-deliverables-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-directory-picker-browse-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-directory-picker-native-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-dockkit-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-goal-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-input-trigger-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-jobs-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-layout-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-message-feedback-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-model-selection-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-open-in-app-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-permission-presets-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-plan-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-plugin-manager-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-plugin-market-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-primitives-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-reference-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-renderer-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-schedule-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-secret-mask-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-session-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-account-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-agent-loop-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-general-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-models-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-plugin-inventory-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-plugins-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-session-log-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-shell-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-subagent-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-settings-web-search-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-shortcuts-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-sidebar-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-sidebar-browser-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-sidebar-documentpreview-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-sidebar-files-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-sidebar-right-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-sidebar-terminal-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-skill-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-slots-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-subagent-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-theme-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-tool-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-trajectory-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-user-questions-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-workflow-run-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-ui-workspace-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-client-web-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-cmdline-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-command-compact-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-command-feedback-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-command-goal-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-commands-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-compaction-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-compaction-basic-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-compaction-image-offload-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-compaction-tool-result-pruner-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-computer-use-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-config-editor-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-cordis-client-runner-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-cordis-host-runner-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-credentials-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-credentials-local-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-cua-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-deepseek-account-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-deepseek-account-platform-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-deepseek-llm-api-extensions-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-deque-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-agent-team-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-agent-team-profile-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-api-speech-to-text-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-auto-review-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-badge-skill-bundle-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-browser-use-chrome-devtools-mcp-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-browser-use-playwright-mcp-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-browser-use-runtime-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-browser-use-stagehand-native-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-claude-code-mods-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-client-ui-agent-team-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-client-ui-claude-code-mods-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-client-ui-cot-translation-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-client-ui-voice-input-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-computer-use-cua-driver-mcp-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-computer-use-cua-driver-native-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-cot-translation-bundle-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-cua-macos-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-inspector-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-inspector-profile-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-plugin-market-bundle-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-ptc-runtime-python-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-ralph-bundle-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-session-inspector-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-session-search-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-session-titles-bundle-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-speech-to-text-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-speech-to-text-sensevoice-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-terminal-bundle-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-tool-agent-team-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-tool-worktree-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-translator-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-voice-input-bundle-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-webworker-packer-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-webworker-runtime-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-experimental-worktree-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-file-reference-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-file-reference-local-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-fs-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-fs-local-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-fs-observation-policy-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-fs-sandbox-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-fs-ssh-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-goal-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-goal-round-driver-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-harness-dev-context-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-headless-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-hmr-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-home-paths-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-hook-protocol-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-hooks-claude-code-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-hooks-codex-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-directory-picker-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-directory-picker-auto-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-directory-picker-browse-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-directory-picker-native-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-frontend-static-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-open-in-app-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-plugin-inventory-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-product-telemetry-otel-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-host-webserver-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-http-proxy-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-jobs-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-jobs-local-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-launch-environment-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-lazy-require-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-llm-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-llm-deepseek-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-llm-deepseek-account-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-llm-deepseek-api-key-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-llm-mock-server-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-llm-pi-ai-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-llm-replay-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-llm-retry-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-loader-smoke-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-lsp-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-lsp-stdio-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-mcp-client-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-mcp-resources-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-message-feedback-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-native-command-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-office-to-pdf-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-otel-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-output-retention-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-package-manifest-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-permission-presets-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-persona-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-plan-mode-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-plugin-manager-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-plugin-market-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-plugin-market-index-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-plugin-package-inventory-deepseek-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-ptc-runtime-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-ptc-runtime-node-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-pwsh-local-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-pwsh-sandbox-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-remote-mock-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-repeat-tool-reminder-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sandbox-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sandbox-local-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sandbox-policy-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sandbox-ssh-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sandbox-windows-acl-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-schedule-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-scope-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sdk-app-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sdk-client-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sdk-jsonrpc-server-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sdk-minimal-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-sdk-protocol-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-checkpoint-policy-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-format-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-format-catalog-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-format-v0-to-v1-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-format-v1-to-v2-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-format-v2-to-v3-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-format-v3-to-v4-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-log-deepseek-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-log-export-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-persistence-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-persistence-jsonl-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-projection-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-projection-cache-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-query-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-query-sqlite-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-reference-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-snapshot-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-stats-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-telemetry-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-telemetry-otel-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-title-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-title-all-prompts-llm-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-title-first-prompt-llm-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-title-llm-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-session-turn-outline-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-settings-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-shell-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-shell-env-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-skill-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-skill-badge-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-skill-filesystem-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-skill-office-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-spill-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-spill-local-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-spill-policy-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-ssh-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-storage-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-storage-domain-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-storage-json-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-storage-sqlite-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subagent-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subagent-acp-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subagent-claude-code-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subagent-codex-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subagent-dsh-sdk-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subagent-fork-in-process-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subagent-spawn-in-process-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subprocess-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subprocess-local-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-subprocess-ssh-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-system-prompt-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-terminal-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-terminal-bash-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-time-context-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-timeout-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tmux-context-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-token-meter-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-ask-user-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-bash-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-bash-persistent-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-call-timeout-policy-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-cordis-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-fs-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-fs-search-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-goal-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-jobs-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-lsp-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-present-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-pwsh-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-pwsh-persistent-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-ralph-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-schedule-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-session-query-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-skill-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-str-replace-editor-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-subagent-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-subagent-control-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-terminal-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-todo-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-web-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-workflow-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-working-directory-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tool-workspace-dependencies-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-tools-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-typert-generator-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-typert-loader-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-typert-protocol-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-typert-registry-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-user-approval-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-user-questions-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-util-code-language-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-util-crypto-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-util-time-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-util-values-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-util-workspace-path-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-app-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-deepseek-api-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-fetch-http-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-frontend-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-search-deepseek-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-search-exa-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-web-search-perplexity-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-webhook-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-webhook-github-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-win32-process-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-workflow-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-workflow-ptc-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-working-directory-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-workspace-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/deepseek-ai-dsh-workspace-changes-0.2.1-rc.2.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.2/manifest.json | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-acp-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-acp-app-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-agent-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-agent-default-model-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-agent-instructions-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-agent-loop-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-agent-loop-testkit-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-agent-preset-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-agent-preset-registry-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-agent-tool-presentation-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-anonymous-user-id-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-api-account-controller-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-api-gateway-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-api-job-controller-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-api-remote-access-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-api-remotes-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-api-session-controller-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-api-settings-controller-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-api-terminal-controller-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-api-workspace-controller-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-api-workspace-files-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-app-boot-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-atomic-write-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-attachment-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-attachment-local-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-authorization-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-base-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-bash-local-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-bash-sandbox-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-brand-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-browser-use-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-chunked-list-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-connection-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-file-upload-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-hmr-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-locale-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-modules-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-product-analytics-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-resources-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-shortcuts-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-store-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-test-runtime-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-agent-preset-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-approval-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-attachment-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-brand-official-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-chat-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-commands-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-conversation-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-cordis-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-deepseek-model-label-1017-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-deliverables-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-directory-picker-browse-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-directory-picker-native-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-dockkit-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-entry-customization-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-goal-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-input-trigger-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-jobs-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-layout-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-message-feedback-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-model-selection-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-open-in-app-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-permission-presets-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-plan-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-plugin-manager-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-plugin-market-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-primitives-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-reference-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-renderer-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-schedule-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-secret-mask-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-session-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-settings-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-settings-account-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-settings-agent-loop-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-settings-general-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-settings-models-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-settings-plugin-inventory-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-settings-plugins-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-settings-session-log-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-settings-shell-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-settings-subagent-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-settings-web-search-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-shortcuts-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-sidebar-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-sidebar-browser-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-sidebar-documentpreview-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-sidebar-files-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-sidebar-right-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-sidebar-terminal-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-skill-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-slots-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-subagent-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-theme-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-tool-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-trajectory-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-user-questions-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-workflow-run-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-ui-workspace-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-client-web-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-cmdline-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-command-compact-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-command-feedback-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-command-goal-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-commands-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-compaction-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-compaction-basic-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-compaction-image-offload-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-compaction-tool-result-pruner-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-computer-use-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-config-editor-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-cordis-client-runner-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-cordis-host-runner-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-credentials-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-credentials-local-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-cua-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-deepseek-account-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-deepseek-account-platform-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-deepseek-llm-api-extensions-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-deque-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-agent-team-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-agent-team-profile-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-api-speech-to-text-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-auto-review-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-badge-skill-bundle-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-browser-use-chrome-devtools-mcp-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-browser-use-playwright-mcp-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-browser-use-runtime-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-browser-use-stagehand-native-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-claude-code-mods-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-client-ui-agent-team-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-client-ui-claude-code-mods-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-client-ui-cot-translation-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-client-ui-voice-input-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-computer-use-cua-driver-mcp-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-computer-use-cua-driver-native-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-cot-translation-bundle-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-cua-macos-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-inspector-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-inspector-profile-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-plugin-market-bundle-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-ptc-runtime-python-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-ralph-bundle-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-session-inspector-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-session-search-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-session-titles-bundle-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-speech-to-text-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-speech-to-text-sensevoice-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-terminal-bundle-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-tool-agent-team-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-tool-worktree-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-translator-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-voice-input-bundle-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-webworker-packer-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-webworker-runtime-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-experimental-worktree-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-file-reference-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-file-reference-local-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-fs-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-fs-local-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-fs-observation-policy-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-fs-sandbox-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-fs-ssh-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-goal-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-goal-round-driver-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-harness-dev-context-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-headless-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-hmr-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-home-paths-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-hook-protocol-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-hooks-claude-code-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-hooks-codex-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-host-directory-picker-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-host-directory-picker-auto-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-host-directory-picker-browse-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-host-directory-picker-native-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-host-frontend-static-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-host-open-in-app-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-host-plugin-inventory-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-host-product-telemetry-otel-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-host-webserver-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-http-proxy-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-jobs-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-jobs-local-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-launch-environment-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-lazy-require-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-llm-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-llm-deepseek-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-llm-deepseek-account-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-llm-deepseek-api-key-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-llm-mock-server-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-llm-pi-ai-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-llm-replay-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-llm-retry-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-loader-smoke-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-lsp-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-lsp-stdio-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-mcp-client-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-mcp-resources-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-message-feedback-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-native-command-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-office-to-pdf-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-otel-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-output-retention-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-package-manifest-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-permission-presets-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-persona-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-plan-mode-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-plugin-manager-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-plugin-market-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-plugin-market-index-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-plugin-package-inventory-deepseek-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-ptc-runtime-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-ptc-runtime-node-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-pwsh-local-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-pwsh-sandbox-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-remote-mock-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-repeat-tool-reminder-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-sandbox-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-sandbox-local-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-sandbox-policy-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-sandbox-ssh-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-sandbox-windows-acl-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-schedule-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-scope-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-sdk-app-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-sdk-client-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-sdk-jsonrpc-server-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-sdk-minimal-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-sdk-protocol-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-checkpoint-policy-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-format-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-format-catalog-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-format-v0-to-v1-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-format-v1-to-v2-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-format-v2-to-v3-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-format-v3-to-v4-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-log-deepseek-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-log-export-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-persistence-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-persistence-jsonl-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-projection-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-projection-cache-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-query-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-query-sqlite-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-reference-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-snapshot-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-stats-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-telemetry-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-telemetry-otel-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-title-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-title-all-prompts-llm-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-title-first-prompt-llm-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-title-llm-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-session-turn-outline-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-settings-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-shell-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-shell-env-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-skill-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-skill-badge-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-skill-filesystem-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-skill-office-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-spill-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-spill-local-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-spill-policy-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-ssh-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-storage-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-storage-domain-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-storage-json-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-storage-sqlite-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-subagent-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-subagent-acp-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-subagent-claude-code-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-subagent-codex-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-subagent-dsh-sdk-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-subagent-fork-in-process-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-subagent-spawn-in-process-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-subprocess-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-subprocess-local-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-subprocess-ssh-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-system-prompt-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-terminal-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-terminal-bash-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-time-context-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-timeout-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tmux-context-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-token-meter-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-ask-user-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-bash-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-bash-persistent-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-call-timeout-policy-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-cordis-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-fs-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-fs-search-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-goal-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-jobs-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-lsp-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-present-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-pwsh-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-pwsh-persistent-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-ralph-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-schedule-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-session-query-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-skill-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-str-replace-editor-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-subagent-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-subagent-control-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-terminal-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-todo-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-web-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-workflow-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-working-directory-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tool-workspace-dependencies-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-tools-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-typert-generator-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-typert-loader-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-typert-protocol-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-typert-registry-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-user-approval-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-user-questions-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-util-code-language-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-util-crypto-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-util-time-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-util-values-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-util-workspace-path-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-web-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-web-app-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-web-deepseek-api-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-web-fetch-http-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-web-frontend-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-web-search-deepseek-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-web-search-exa-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-web-search-perplexity-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-webhook-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-webhook-github-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-win32-process-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-workflow-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-workflow-ptc-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-working-directory-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-workspace-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/deepseek-ai-dsh-workspace-changes-0.2.1-rc.3.tgz | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | vendor/dsh-runtime/0.2.1-rc.3/manifest.json | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 7a884a519b7001dfee63b7a49187169a83791d79 | yarn.lock | SKIP | rc.3 适配；HuaAnWork 保持 rc.1 |
| 013e494cf552cd6b4482abf7550c6a746ccc65e2 | (merge container, zero direct files) | SKIP | merge 容器；子提交已独立裁定 |
| bc297e7a95d56a5edec7d7dd65bc174c0ec14a8c | dsh-desktop-next/package.json | SKIP | Next 框架迁移后的 packaging/landlock 修复，不适用于当前 HuaAnWork 工具链 |
| bc297e7a95d56a5edec7d7dd65bc174c0ec14a8c | dsh-desktop-next/scripts/packaging-command.ts | ALREADY | fork 现有 mapping 使用不同的 dsh-plugin-desktop-beta 替换顺序，不具该 replaceAll 缺陷；本地等价：单桌面化后**不存在**跨包名替换表 —— `dsh-plugin-huaanwork/` 下无 `packaging-command.ts`，且 `git grep -c 'dsh-plugin-desktop-beta' -- dsh-plugin-huaanwork/scripts` = 0；打包参数由 `scripts/package-mac.ts:134-152`（`packageMacSmoke`）与 `scripts/package-win.ts` 直接拼出 |
| bc297e7a95d56a5edec7d7dd65bc174c0ec14a8c | dsh-desktop-next/tests/main-lifecycle.spec.ts | SKIP | Next 框架迁移后的 packaging/landlock 修复，不适用于当前 HuaAnWork 工具链 |
| bc297e7a95d56a5edec7d7dd65bc174c0ec14a8c | dsh-desktop-next/tests/package.spec.ts | SKIP | Next 框架迁移后的 packaging/landlock 修复，不适用于当前 HuaAnWork 工具链 |
| bc297e7a95d56a5edec7d7dd65bc174c0ec14a8c | dsh-desktop-next/tests/packaging-command.spec.ts | SKIP | Next 框架迁移后的 packaging/landlock 修复，不适用于当前 HuaAnWork 工具链 |
| bc297e7a95d56a5edec7d7dd65bc174c0ec14a8c | dsh-plugin-desktop-beta/package.json | SKIP | Next 框架迁移后的 packaging/landlock 修复，不适用于当前 HuaAnWork 工具链 |
| bc297e7a95d56a5edec7d7dd65bc174c0ec14a8c | dsh-plugin-desktop-beta/scripts/packaging-command.ts | SKIP | Next 框架迁移后的 packaging/landlock 修复，不适用于当前 HuaAnWork 工具链 |
| bc297e7a95d56a5edec7d7dd65bc174c0ec14a8c | dsh-plugin-desktop-beta/tests/main-lifecycle.spec.ts | SKIP | Next 框架迁移后的 packaging/landlock 修复，不适用于当前 HuaAnWork 工具链 |
| bc297e7a95d56a5edec7d7dd65bc174c0ec14a8c | dsh-plugin-desktop-beta/tests/package.spec.ts | SKIP | Next 框架迁移后的 packaging/landlock 修复，不适用于当前 HuaAnWork 工具链 |
| bc297e7a95d56a5edec7d7dd65bc174c0ec14a8c | dsh-plugin-desktop-beta/tests/packaging-command.spec.ts | SKIP | Next 框架迁移后的 packaging/landlock 修复，不适用于当前 HuaAnWork 工具链 |
| bc297e7a95d56a5edec7d7dd65bc174c0ec14a8c | scripts/verify-desktop-variants.mjs | SKIP | Next 框架迁移后的 packaging/landlock 修复，不适用于当前 HuaAnWork 工具链 |
| 678aa209b2842c8388c9d76b268b0774d7a04572 | .github/workflows/ci.yml | SKIP | CI/Next 性能优化；非单桌面正确性维护，留待后续独立评估 |
| 678aa209b2842c8388c9d76b268b0774d7a04572 | dsh-desktop-next/package.json | SKIP | CI/Next 性能优化；非单桌面正确性维护，留待后续独立评估 |
| 678aa209b2842c8388c9d76b268b0774d7a04572 | dsh-desktop-next/scripts/prepare-runtime.ts | SKIP | CI/Next 性能优化；非单桌面正确性维护，留待后续独立评估 |
| 678aa209b2842c8388c9d76b268b0774d7a04572 | dsh-desktop-next/tests/prepare-runtime.spec.ts | SKIP | CI/Next 性能优化；非单桌面正确性维护，留待后续独立评估 |
| 678aa209b2842c8388c9d76b268b0774d7a04572 | dsh-plugin-desktop-beta/package.json | SKIP | CI/Next 性能优化；非单桌面正确性维护，留待后续独立评估 |
| 678aa209b2842c8388c9d76b268b0774d7a04572 | dsh-plugin-desktop-beta/scripts/prepare-runtime.ts | SKIP | CI/Next 性能优化；非单桌面正确性维护，留待后续独立评估 |
| 678aa209b2842c8388c9d76b268b0774d7a04572 | dsh-plugin-desktop-beta/tests/prepare-runtime.spec.ts | SKIP | CI/Next 性能优化；非单桌面正确性维护，留待后续独立评估 |
| 678aa209b2842c8388c9d76b268b0774d7a04572 | dsh-plugin-desktop/package.json | SKIP | CI/Next 性能优化；非单桌面正确性维护，留待后续独立评估 |
| 678aa209b2842c8388c9d76b268b0774d7a04572 | package.json | SKIP | CI/Next 性能优化；非单桌面正确性维护，留待后续独立评估 |
| 678aa209b2842c8388c9d76b268b0774d7a04572 | scripts/run-parallel.mjs | SKIP | CI/Next 性能优化；非单桌面正确性维护，留待后续独立评估 |
| 077241ce7dad2c78bba89a3c1c9d175c961ebea4 | .github/workflows/ci.yml | SKIP | Beta AA-skip 去重已由 HuaAnWork 单格 CI 重写取代 |
| 7cd28c1c598694b204e7311e3f609b44d0fbeba9 | .github/workflows/ci.yml | SKIP | 上游 beta-only CI 不适用于 HuaAnWork；本计划已有独立单产品 CI |
| 7cd28c1c598694b204e7311e3f609b44d0fbeba9 | dsh-plugin-desktop/tests/package.spec.ts | SKIP | 上游 beta-only CI 不适用于 HuaAnWork；本计划已有独立单产品 CI |
| 7cd28c1c598694b204e7311e3f609b44d0fbeba9 | package.json | SKIP | 上游 beta-only CI 不适用于 HuaAnWork；本计划已有独立单产品 CI |
| 9847a9bb633dbf17e6d6050b0706b2ab2cbda9bb | (merge container, zero direct files) | SKIP | merge 容器；子提交已独立裁定 |
| bc6ae423eda7c21f121a2c41b83b8274499b2485 | .yarn/patches/dshmarket-desktop.patch | ALREADY | fork 1.70.2 patch 已保留等价自更新与 channel 修复 |
| bc6ae423eda7c21f121a2c41b83b8274499b2485 | dsh-desktop-next/package.json | ALREADY | fork 已是 dshmarket 1.70.2 及更新 patch，上游 1.70.1 被更新实现覆盖；本地等价：`dsh-plugin-huaanwork/package.json:398` 的 `dshmarket` 依赖（评估时为 `1.70.2`，F1 升级后现为 `1.73.5`）+ `.yarn/patches/dshmarket-desktop.patch` |
| bc6ae423eda7c21f121a2c41b83b8274499b2485 | dsh-plugin-desktop-beta/package.json | ALREADY | fork 已是 dshmarket 1.70.2 及更新 patch，上游 1.70.1 被更新实现覆盖；本地等价：`dsh-plugin-huaanwork/package.json:398` 的 `dshmarket` 依赖（评估时为 `1.70.2`，F1 升级后现为 `1.73.5`）+ `.yarn/patches/dshmarket-desktop.patch` |
| bc6ae423eda7c21f121a2c41b83b8274499b2485 | dsh-plugin-desktop/package.json | ALREADY | fork 已是 dshmarket 1.70.2 及更新 patch，上游 1.70.1 被更新实现覆盖；本地等价：`dsh-plugin-huaanwork/package.json:398` 的 `dshmarket` 依赖（评估时为 `1.70.2`，F1 升级后现为 `1.73.5`）+ `.yarn/patches/dshmarket-desktop.patch` |
| bc6ae423eda7c21f121a2c41b83b8274499b2485 | package.json | ALREADY | fork 已是 dshmarket 1.70.2 及更新 patch，上游 1.70.1 被更新实现覆盖 |
| bc6ae423eda7c21f121a2c41b83b8274499b2485 | yarn.lock | ALREADY | fork 已是 dshmarket 1.70.2 及更新 patch，上游 1.70.1 被更新实现覆盖 |
| 092e2ecef750d10db43cedbab8e81fd48c8de38e | (merge container, zero direct files) | SKIP | merge 容器；子提交已独立裁定 |
