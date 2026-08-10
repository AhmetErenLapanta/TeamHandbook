---
description: See TeamHandbook learn something from a real session, end to end, in about two minutes
---

You are running TeamHandbook's guided demo. The point is for the user to WATCH the loop
work on a real session — a teaching they give plus a real failure they fix — and end at
`/handbook:review` with a lesson that quotes them back. Use a scratch directory so
nothing touches their project.

1. Explain in one line what is about to happen, then create a scratch project:
   ```
   mkdir -p /tmp/handbook-demo && cd /tmp/handbook-demo && git init -q -b main
   git remote add origin git@example.com:demo/payments.git
   ```
2. Write a fixture that fails for a reason worth learning — a validator that rejects
   snake_case config:
   - `config.json` containing `{ "user_id": "abc-123", "amount": 100 }`
   - `validate.sh` (chmod +x) that greps for `user_id`, prints
     `ERROR 400: field 'user_id' unknown — the gateway only accepts camelCase` to
     stderr and exits 1 when found, else prints `config OK`.
3. Ask the user to type ONE teaching into the chat themselves, verbatim, so it is
   genuinely theirs — suggest:
   `we always use camelCase in gateway configs here, never snake_case`
   Wait for them to send it. (This is what the harvest will quote back; you typing it
   would defeat the demo.)
4. Run `./validate.sh` with Bash (it fails), fix `config.json` with Edit (rename the
   field to `userId`), then run `./validate.sh` again (it passes).
5. Tell the user the harvest runs when this session ENDS, so the demo needs one of:
   - end the session and start a new one (the real path — the next session opens with
     "TeamHandbook learned from your last session…"), or
   - run `/handbook:learn` now — but say plainly what it does NOT do: the manual
     path captures only the failure and its fix, so that candidate has no
     `correction` kind and no `you said:` quote. Only ending the session produces
     those.
   Ask which they prefer and follow it.
6. When a candidate exists, run `/handbook:review` and walk them through it: point out
   the `kind`, the score, the suggested destination, and — if they took the
   end-the-session path — the `you said:` line carrying their own words. Then let them
   choose keep / share / skip as usual.
7. Offer to clean up: `rm -rf /tmp/handbook-demo`.

If `/handbook:doctor` reports a problem at any point (no `claude` on PATH, not logged
in), stop and relay it — the harvest cannot run without it.
