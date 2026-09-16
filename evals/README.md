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

`control-named-command` is tagged `control`, not `nl`, so it stays out of the headline
number. Run it separately before trusting a low score:

```
claude plugin eval . --case control-named-command --ablation none --no-publish --model claude-sonnet-5
```

Its prompt names the command outright, so it should score 1.00. If it does not, the plugin
did not load and the `nl` run measured nothing. A suite-wide zero and a plugin that failed
to resolve look identical from the score alone.

Add `--keep-temp` to keep each run's `trace.jsonl`. A `tool_used` grader is pass or fail,
so it records that the right command did not fire but not what fired instead; the trace is
the only place that answer exists. It leaves one `/private/tmp/e-*` directory per run
behind, each holding that run's disposable home, so delete them once you have read the
traces.

## Baseline

2026-09-16, Claude Code 2.1.273, `claude-sonnet-5`, 3 runs per case, 12 `nl` cases:
`overallScore` 0.5556, 5 of 12 cases at 1.00. Control 1.00. Re-run the command above
unchanged to compare against it.

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
