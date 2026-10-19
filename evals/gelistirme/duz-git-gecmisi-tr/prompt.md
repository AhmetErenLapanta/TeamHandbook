---
description: >-
    False-positive probe, not a routing case. A Turkish git-history question that shares
    "git geçmişine bak" with the routing case tekrar-eden-isler-tr and sits close to
    /handbook:mine's triggers about history. Its subject is one file and one past change,
    the thing git log or git blame answers, not work that keeps repeating.
tags: [fp-gelistirme]
expected_outcome: >-
    No handbook command. The subject is a single commit in the git history, not the
    repeating work /handbook:mine turns into a skill.
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

git geçmişine bakar mısın, src/auth/session.ts içindeki token süresi kontrolünü en son kim değiştirdi, hangi commit'te ve ne zaman
