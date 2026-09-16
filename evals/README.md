# Natural-language routing suite

Does a plain sentence reach the right command? Every case is one sentence a user would
actually type, and one `tool_used` grader asserting which command should have fired. A
case's score is therefore its hit rate over the runs, and `overallScore` is the suite's
hit rate. No `llm` graders: `tool_used` is computed from the transcript and costs nothing,
and a judge would add variance to a number that exists to be compared across changes.

Sentences stay in the language the user would type them in. What is measured is whether
Turkish phrasing reaches an English description, so translating the cases would erase the
measurement. Each case's `description` says why that sentence is in the suite and
`expected_outcome` names the command it should reach and defends the choice.

No case names the command it targets, with one exception noted in
`team-mcp-settings/prompt.md`: a sentence containing the command name measures string
matching rather than natural phrasing.

## Running it

```
claude plugin eval . --tag nl --ablation none --no-publish --model claude-sonnet-5 -j 4
```

`--ablation none` is required, not cosmetic. Under the default two-arm ablation every
`tool_used` grader whose tool is `Skill` is excluded from the score and reported as a
plugin-fired indicator instead, because such a grader can never pass without the plugin.
That would leave these cases with nothing scored. Under `--ablation none` nothing is
excluded and the score is the hit rate.

Two tags stay out of the headline number, for opposite reasons.

`control-named-command` is tagged `control`, not `nl`. Run it separately before
trusting a low score:

```
claude plugin eval . --case control-named-command --ablation none --no-publish --model claude-sonnet-5
```

Its prompt names the command outright, so it should score 1.00. If it does not, the plugin
did not load and the `nl` run measured nothing. A suite-wide zero and a plugin that failed
to resolve look identical from the score alone.

The three `fp` cases are the other exclusion. They are false-positive probes: ordinary
development sentences that borrow a word the descriptions claim ("review this function",
"the status of my branch", an onboarding doc for "the team"), each graded by a `tool_used`
grader with `min: 0, max: 0` asserting that no handbook command fired. A trigger written
too broadly shows up here and nowhere else, because every `nl` case is a sentence that
SHOULD route. They carry `arm: both`, without which a `tool_used: Skill` grader is dropped
from scoring under the default ablation and the assertion would never count. Run them on
their own, and read their exit code on its own:

```
claude plugin eval . --tag fp --ablation none --no-publish --model claude-sonnet-5
```

Add `--keep-temp` to keep each run's `trace.jsonl`. A `tool_used` grader is pass or fail,
so it records that the right command did not fire but not what fired instead; the trace is
the only place that answer exists. It leaves one `/private/tmp/e-*` directory per run
behind, each holding that run's disposable home, so delete them once you have read the
traces.

## Baseline

2026-09-16, Claude Code 2.1.273, `claude-sonnet-5`, 12 `nl` cases, control 1.00 alongside
each. Re-run the command above unchanged to compare against it.

| descriptions | runs per case | `overallScore` | hits |
|---|---|---|---|
| before the change | 3 | 0.5556 | 20/36 |
| after the change | 3 | 0.6667 | 24/36 |
| after the change | 9 | 0.6204 | 67/108 |

`fp`: 3 cases, 3 runs each, 1.00, no handbook command fired in any run.

A movement under 0.07 at 3 runs per case is noise: the auditor changed nothing and saw
0.5556 become 0.5833. At 9 runs per case the band is roughly 0.042. Nine of the twelve
cases are deterministic, so the headline only moves when one of `hand-written-skill`,
`setup-broken` or `teammate-shared-url` turns over.

Read that number with its confound. Each run starts in an empty working directory with no
prior conversation, and several misses are that rather than a description that failed to
attract the sentence: three cases refer to something with no antecedent here (a fix "we
just found", "bunu", a URL the user did not paste) and the run answers by asking what was
meant. Each case's `expected_outcome` says which reading it assumes. The baseline and any
later run share the confound, so the comparison holds, but a rise is not automatically a
description getting better.

`results/` is gitignored. The run document embeds the absolute path of the machine that
produced it, including the operator's home directory, and this repository is public. The
numbers above are the part worth keeping, and the report also carries every prompt and
transcript, which is noise in a diff.
