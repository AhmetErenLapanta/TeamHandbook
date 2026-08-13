---
description: Watch TeamHandbook learn something from a real session, end to end, in about five minutes
---

You are setting up TeamHandbook's guided demo. Your job in THIS session is only to
prepare it and hand the user their next two steps. Do not do the work yourself here.

Why the split, if the user asks: the harvest reads the conversation a session produced.
A session spent talking about TeamHandbook is a session about TeamHandbook, and a model
reading it back concludes, correctly, that it was watching a staged exercise rather than
someone working. Measured on a real transcript: the demo that narrated itself produced a
skill in 1 run out of 3, while the same work done in an ordinary session produced it 3
out of 3. So the demo hands the work to a clean session. That is also the honest thing
to show, since it is what the product actually does all day.

## Step 1, here: build the scratch project

Create it with ONE Bash call, exactly as written. One call is deliberate: `mkdir` and
`chmod` are too generic to count as work, so this session stays under the substance bar
and never spends a model call harvesting itself. Writing the two files with the Write
tool instead would cross it.

```bash
mkdir -p /tmp/handbook-demo && cd /tmp/handbook-demo && git init -q -b main 2>/dev/null; git remote remove origin 2>/dev/null; git remote add origin git@example.com:demo/payments.git; cat > config.json <<'EOF'
{
  "user_id": "abc-123",
  "amount": 100
}
EOF
cat > validate.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if grep -q '"user_id"' config.json; then
  echo "ERROR 400: field 'user_id' unknown - the gateway only accepts camelCase" >&2
  exit 1
fi
echo "config OK"
EOF
chmod +x validate.sh && ls
```

## Step 2: send the work to a NEW session

Print this, changing nothing inside the code blocks:

> The scratch project is ready at `/tmp/handbook-demo`: a config using `user_id`, and a
> validator that rejects it.
>
> Quit this session with `/exit`, then start Claude Code in that directory:
>
> ```
> cd /tmp/handbook-demo && claude
> ```
>
> Paste this as your first message and let it work:
>
> ```
> we always use camelCase in gateway configs here, never snake_case. run ./validate.sh, fix whatever it rejects, then run it again
> ```
>
> When it prints `config OK`, quit that session too. TeamHandbook harvests it as it
> closes: your rule, the command that failed, and the fix that followed.

Then stop. Do not offer to do the work here instead, and do not reach for
`/handbook:learn` as a shortcut: the manual path captures the failure and its fix, so
the candidate arrives with no `correction` kind and no `you said:` quote, which is the
half of the demo worth watching.

## Step 3: tell them what to look for when they come back

> Start Claude Code in `/tmp/handbook-demo` once more. It should open with:
>
> ```
> TeamHandbook learned from your last session: "..." (correction, 8/10) - run /handbook:review
> ```
>
> Run `/handbook:review` and read the candidate:
>
> - `kind: correction`, which only the session-end path produces
> - the score, and which of the five criteria earned it
> - `you said:`, carrying your own sentence, quoted back as the reason the skill exists
>
> Then keep it, put it in the repo, or skip it.
>
> If that opening line does not appear, give the background harvest a few seconds and
> start a session again. `/handbook:status` shows whether it ran, and `/handbook:doctor`
> says whether it could reach your `claude` CLI at all.

Clean up whenever they ask: `rm -rf /tmp/handbook-demo`. Leave it until after the
review, since the candidate's grounded case points at it.
