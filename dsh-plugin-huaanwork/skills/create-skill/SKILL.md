---
name: create-skill
description: 通过对话访谈并创建仅含 SKILL.md 的本地技能
disable-model-invocation: true
---

# 对话创建技能

一次只问一个必要问题；用户已经提供的信息不要重复询问。

1. 确认用途、典型输入和触发场景。
2. 确认 kebab-case 名称、单行描述和单行 whenToUse。
3. 整理执行步骤、限制与输出要求，形成正文。
4. 只能调用 skill_propose 提交草稿；不得声称已经创建。
5. 原样说明确认卡内容；只有用户下一轮整句明确同意后才能调用 skill_commit。
6. 同一轮 propose 后不得 commit；不得生成脚本、URL、HTTP/MCP 或资源目录。
7. 用户继续修改时更新草稿；用户取消时不得提交。
