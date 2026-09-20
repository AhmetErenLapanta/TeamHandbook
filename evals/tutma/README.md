# Held-out half

The headline number comes from here. Nothing in this directory may be read by anyone
writing a command or skill description, which is the whole reason it exists: a
description written against a sentence stops measuring routing and starts measuring
string matching, and that has already happened once, to `team-mcp-settings`.

Product owns these sentences and keeps the source list outside this repository, so that
writing a description cannot start from the list the number is measured against.

| | routing sentences | must route nowhere | tag |
|---|---|---|---|
| easy | 15 (8 TR, 7 EN), all ten commands | 4 | `nl-tutma`, `fp-tutma` |
| hard | 10 (5 TR, 5 EN), eight commands | 2 | `nl-tutma` + `zor`, `fp-tutma` + `fp-zor` |
| contested | | 1 | `itirazli`, outside the headline |

`zor` selects the ten routing cases and nothing else, so `run-suite.sh zor` reports the
score that has room in it. The two hard probes carry `fp-zor` instead, because a package
that mixes "must route here" with "must route nowhere" averages two different questions.

The hard set skips `demo` and `doctor` on purpose: the SessionStart notice prints both
names into every run, so a held-out case targeting either measures the notice.

`fp-remember-commit-style-tr` is in no scored package. Product reads it as no command,
because nothing in the session was finished to harvest, while
`evals/gelistirme/capture-this-fix/` treats memory as learn's loss rather than its
competitor. It is run on its own with `run-suite.sh itirazli` and reported apart from the
headline, because the run is the same either way and only the reading changes: three runs
score 1.00 under Product's reading and the identical behaviour is 0.00 under the other one.
Folding that into the headline would make a number move when a definition changed.

One sentence was retired rather than scored. `t-setting-up-squad-en` repeated two entries
of `init`'s trigger list clause for clause, so it would have stayed green through a routing
regression, which is the one job the held-out half has. Its directory is still here, tagged
out of every package, because the record of a case that had to go is worth more than a
clean directory listing. That leaves `init` with one sentence instead of two.

## Adding a hard case

The room this package has left to improve in is smaller than its own noise, because most
of its cases return 3/3 on every run. `evals/README.md` has the arithmetic. Hard cases are
the fix, and they live here alongside the easy ones rather than in their own directory,
because they are the same instrument measured two ways.

    <case>/prompt.md   tags: [nl-tutma, zor]

Both tags, always. `nl-tutma` keeps the case in the headline; `zor` lets
`run-suite.sh zor` report the hard subset on its own. A directory name says what the case
expects, not how hard it is: `t-` routes somewhere, `fp-` must route nowhere. The tag
carries the difficulty, and the name matches the slug in the sealed source so an audit can
trace one to the other without opening both.

What makes a case hard is not obscure phrasing. It is a sentence that does not hand over
its own answer: someone who knows the command list but has never read a description should
not be able to route it from the wording alone. The sentence names the situation, not the
operation. Fifteen of the original sixteen fail that test, which is why they score where
they do.

A hard case still has to be gradeable, so its expected outcome must be a single command
that is defensibly right. A sentence two commands could serve belongs in the false-positive
set or nowhere, not here.

## Context

Twelve of the twenty cases carry a `prior.jsonl`, because their sentence leans on
something it does not itself supply. Two kinds, and they are not equally solid:

- **A conversational antecedent.** `t-address-posted-tr` needs the address its sentence
  points at. The prior turns are the conversation it refers to, which is what actually
  happened.
- **Product or filesystem state**, such as a configured MCP server or a skill on disk.
  The harness cannot pre-seed that: `add_dirs` grants reads without putting anything in
  the working directory, and `scaffold_script` runs outside the sandbox. So the state is
  established *conversationally* instead. That is a stand-in, and a case resting on it
  measures routing given a described situation, not given a real one.

## Reading these

- **`t-see-it-work-tr` cannot speak about its description.** It targets `demo`, and the
  plugin's SessionStart notice prints that command name into every run. Same caution, in
  weaker form, for `t-nothing-reaching-en`, which targets `doctor`.
- **`t-this-order-tr` and `t-way-we-did-en` are ahead of the product.** They ask for a
  team rule rather than a personal note, and no command description offers that yet. A
  low score from these two is the baseline for that work, not a defect in what exists.
- **`t-what-reached-team-tr` and `fp-deploy-status-en` are a deliberate pair.** Both ask
  for status, one about the plugin and one about CI. A description that cannot separate
  them misses both.
- **Case 9 and case 10 are the same request in two languages**, as are several others. A
  large gap between the pair is a language effect and should be reported as one.
