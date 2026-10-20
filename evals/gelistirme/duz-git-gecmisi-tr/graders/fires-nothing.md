---
type: tool_used
tool: Skill
input_match: '"skill"\s*:\s*"(?:handbook:)?(?:demo|doctor|init|join|learn|leave|mcp|mine|review|share|share-skill|status|suggest-skill-capture)"'
min: 0
max: 0
arm: both
---

No TeamHandbook command may fire. The sentence asks who changed one file and in which
commit, an ordinary git log or git blame question that happens to say "git history", so a
hit here, above all on the command that reads history, is a trigger reaching past its
subject rather than a routing success.
