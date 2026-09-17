# Does a plain sentence reach the right command?

Every command in this plugin is reached one way: the user types something in their own
words and Claude Code picks a command out of its description. This suite measures how
often that lands. It runs the real plugin in a throwaway sandbox and checks which
command, if any, actually fired.

    evals/run-suite.sh nl-tutma      --model claude-sonnet-5 -j 4   # the headline
    evals/run-suite.sh nl-gelistirme --model claude-sonnet-5 -j 4   # iteration only
    evals/run-suite.sh fp-gelistirme --model claude-sonnet-5 -j 3   # must fire nothing
    evals/run-suite.sh kontrol       --model claude-sonnet-5        # must be 1.00

Run the control first. Without it a low number is unreadable, because a plugin that
never loaded scores zero in exactly the same way as a plugin whose descriptions miss.

## Two halves, and why

`gelistirme/` is open. Anyone writing a command description may read it, and that is the
point: it is where you iterate.

`tutma/` is held out. Whoever writes descriptions does not read it, and the headline
number comes from there alone. The reason is not hypothetical. One case, `team-mcp-settings`,
already lost its ability to measure anything: its sentence contains its own command name,
and a later change added the English translation of that same sentence to the command
description as a trigger. It now scores near the ceiling by matching a string. A number
you can raise by copying the test into the answer is not a measurement.

Product writes the held-out sentences and keeps them sealed. `tutma/README.md` says how
to add them.

The held-out half holds sixteen routing sentences and four false-positive probes, all
written by Product against the team-facing framing, and none of them seen by any
description in this repo.

## Reading a number from here

- **It is not comparable to the number this package reported before.** Different
  sentences, different cases, different scoring. Put the two side by side if it helps,
  but do not subtract them.
- **Two unchanged runs of the development half returned the same number**, case for case.
  That is one delta, not a band. The band measured on the previous package at three runs
  per case was ±0.073 at two standard deviations, and that figure was itself a floor,
  because most cases sat at 0/9 or 9/9 and so contributed no variance by construction.
  Treat movement below ±0.073 as noise; movement above it is not automatically signal.
- **Two cases cannot tell you about their descriptions.** `see-it-work` and
  `setup-broken` target `demo` and `doctor`, and the plugin's own SessionStart notice
  prints both command names into every run, three times each in a counted trace, because
  every run gets a fresh home and is therefore a first session. Held-out cases must not
  target those two commands.

## Giving a sentence something to point at

A run starts in an empty directory with no history. A sentence like "share this" or "the
fix we just found" then points at nothing, the model correctly asks what is meant, and
the case scores that correct answer as a miss. Three cases used to be pinned at zero this
way, which is a quarter of the old headline.

The fix is `context.history_file`: a hand-written transcript that becomes the earlier
turns of the conversation. The sentence is unchanged; what changes is that it now refers
to something.

    <case>/case.yaml          schema_version, name, context.history_file: prior.jsonl
    <case>/prior.jsonl        the earlier turns, one JSON object per line
    <case>/prompt.md          the sentence, plus description, tags and execution fields

`case.yaml` and `prompt.md` merge, and `prompt.md` wins on shared keys. `context:` only
exists in `case.yaml`; putting it in `prompt.md` frontmatter is rejected as an unknown
key. The transcripts here are written by hand and carry no real paths, machine names or
session data; they are fixtures that ship in a public repo.

Two mechanisms were measured and rejected:

- **`context.add_dirs`** grants read access to a directory but does not put it in the
  working directory and does not announce it. In a probe the model spent eight turns
  searching and never found the fixture. It also must resolve inside the case directory;
  a sibling path is a hard error.
- **`context.scaffold_script`** needs `--scaffold`, and runs author-supplied bash as you,
  outside the sandbox. `history_file` covers what these cases need without that.

## Runs that did not happen

A run that reached the model always costs something; the cheapest real run observed was
$0.024. A run costing $0.00, or one cut off by a timeout, is not evidence about routing.
The harness does not make this distinction: its `overallScore` folds such a run in as a
plain zero. That was measured, not assumed: a case with an unresolvable fixture path
scored 0.00 at $0.00 and 0 seconds, and the suite average moved as though the model had
answered and been wrong.

`run-suite.sh` therefore drops invalid runs from the score, reports them separately, and
stamps the whole package INVALID above a tenth of all runs. The reasoning for that line
is in the script, next to the constant.

A case the harness could not set up at all, and a suite that stopped early, are a third
thing again: not noise to be excluded but a broken package. `run-suite.sh` names those and
refuses to print a score, because a fixture typo in a new case would otherwise be dropped
from the denominator and read as one flaky slot.

A run that hits its turn limit is **not** invalid. The model did answer; it just ran
long. Those are counted in the score and reported as a note.

## Flags that are load-bearing

`--ablation none` is not decoration. Under the default `with-without` arm, every
`tool_used` grader whose tool is `Skill` is pulled out of the score and reported as a
"plugin-fired indicator" instead, because it cannot pass without the plugin. Every grader
here is that type, so without the flag the number quietly measures something else.
`run-suite.sh` passes it, along with `--threshold 0`, which keeps the exit code meaning
"the suite ran" so that the invalid stamp is the only thing that can fail it.

## Where the misses go

The graders are pass/fail, so they do not say which command a miss reached instead. Add
`--keep-temp` and read the `trace.jsonl` files it leaves behind, then delete the
`/private/tmp/e-*` directories it leaves on disk.

`evals/results/` is not committed: `aggregate-result.json` carries absolute paths and the
machine's user name, and the HTML report embeds every prompt and transcript.
