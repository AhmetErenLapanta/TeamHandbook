# Does a plain sentence reach the right command?

Every command in this plugin is reached one way: the user types something in their own
words and Claude Code picks a command out of its description. This suite measures how
often that lands. It runs the real plugin in a throwaway sandbox and checks which
command, if any, actually fired.

    evals/run-suite.sh nl-tutma      --model claude-sonnet-5 -j 4   # the headline
    evals/run-suite.sh zor           --model claude-sonnet-5 -j 4   # its hard subset
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

The held-out half holds twenty-five routing sentences and six false-positive probes, all
written by Product against the team-facing framing, and none of them seen by any
description in this repo. One more was retired because its sentence repeated a command's
own trigger list, and one is held out of the headline while its expected answer is in
dispute;
`tutma/README.md` says which and why.

## The ceiling, and why there is a hard subset

Four unchanged runs of the sixteen-case package returned 0.8958, 0.9583, 0.9167 and
0.9792. Mean 0.9375, observed range 0.0833, empirical two standard deviations 0.0761.
That leaves 0.0625 of room below the ceiling, against a band of 0.0761:

    room below the ceiling  0.0625
    noise band              0.0761

The largest improvement the package can express is smaller than its own noise. Read
plainly: this half can show a regression and cannot show an improvement. The cause is not
the number of cases. Twelve of the sixteen returned 3/3 in every run and so contribute
exactly zero variance and exactly zero room; only four cases move at all. Adding more
cases like them widens nothing, which is why going from twelve cases to sixteen did not
narrow the band.

The cases are easy because the sentences carry their own answer. Fifteen of the sixteen
can be routed by someone who has never read a description but knows the command list, just
from the wording.

So the held-out half is split. The existing cases keep their job, which is to notice a
regression, and they are not thrown away for being easy: a case that cannot fail is useless
for improvement and still valuable for damage. New cases tagged `zor` carry the other job,
which is to leave the score somewhere to go. Both tags sit on a hard case, so the headline
covers it and `run-suite.sh zor` reports the hard subset on its own.

**The test this split has to pass, written down before the cases exist:** the room below
the ceiling must exceed the band, both measured on at least three runs of the package as it
then stands. With fifteen easy cases holding a mean of 14/15, `H` hard cases at a mean pass
rate of `p_hard`, and a band `B`, the condition is

    (1 + H(1 - p_hard)) / (15 + H)  >  B

At today's band of 0.0761 that solves to `H > 0.1415 / (0.9239 - p_hard)`: one hard case is
enough at `p_hard` of 0.5, two at 0.8, six at 0.9, and no number of cases is enough at 0.92
or above. The count is not the binding constraint. How hard the cases actually are is the
binding constraint, and a batch that scores near the ceiling fails this test no matter how
many of them there are.

`B` has to be measured again rather than carried over. The easy cases added structurally
zero variance; cases that sit mid-band add real variance, so the band may widen rather than
narrow.

**Measured, three runs of the twenty-five-case package, nothing changed between them:**
0.8000, 0.7733, 0.8000. Mean 0.7911, observed range 0.0267, empirical two standard
deviations 0.0308, model-based 0.0523. Room below the ceiling 0.2089, against the widest
band available, the 0.0761 carried from the previous package:

    room 0.2089  >  band 0.0761

The test passes with a factor of 2.7 against the most conservative band, and still passes
at 0.1289 if you assume the two cases the sealed source marks as fragile can never pass.
Three runs is thin for a band, which is why the criterion is tested against the wider
carried figure rather than the narrower one these runs produced.

The split does what it was for, and the halves say different things:

| | mean | room | band (carried) | can it show improvement |
|---|---:|---:|---:|---|
| all 25 | 0.7911 | 0.2089 | 0.0761 | yes |
| easy 15 | 0.9259 | 0.0741 | 0.0761 | **no**, still |
| hard 10 | 0.5889 | 0.4111 | 0.0761 | yes |

The easy half on its own still cannot show an improvement, by the same arithmetic that
condemned the sixteen-case package. That is the argument for keeping it and for reporting
it separately rather than for throwing it away: it is the regression instrument, and the
room to improve lives entirely in the hard half.

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

The sharing graders also accept the names that merged into `/handbook:share`: the
baseline was measured with that pattern, and a retired name cannot be reached anyway.

`evals/results/` is not committed: `aggregate-result.json` carries absolute paths and the
machine's user name, and the HTML report embeds every prompt and transcript.

---

# Does the harvest find the lesson a session gave?

The suite above measures routing: a sentence in, the right command out. It says nothing
about the sentence this product leads with, which is that it harvests the lessons a
session produced. `evals/hasat/` measures that one, and it is a different kind of
package - it calls `harvestSession` through the real `runClaudeCli` directly rather than
running the plugin, because the subject is the harvest and not a routing decision.

    npx vite-node evals/hasat/run.ts -- --tier 1 --dry-run            # preflight and cost projection
    npx vite-node evals/hasat/run.ts -- --tier 1 --grader-check-only  # measure the grader, nothing else
    npx vite-node evals/hasat/run.ts -- --tier 1 --runs 3             # the measurement
    npx vitest run evals/hasat/corpus.test.ts                         # free, deterministic, in the suite

Run the grader check first, for the same reason the routing suite runs its control first:
the recall number is a grader's verdicts, and a grader nobody measured produces an
unreadable number in exactly the way a plugin that never loaded does.

## The baseline

Measured 2026-09-26 at `014f984` (the evals commit) against product `eb589b0` (v0.13.3),
harvest model `claude-sonnet-5`, grader `haiku`, 24 synthetic sessions carrying 25 labelled
lessons, three runs. `evals/hasat/README.md`
describes the corpus and the method; what follows is only the number.

| | run 1 | run 2 | run 3 | mean | 2 sd band |
|---|---:|---:|---:|---:|---:|
| recall | 0.9200 | 0.9600 | 1.0000 | 0.9600 | [0.8800 ; 1.0400] |
| precision | 0.9200 | 0.9231 | 0.9615 | 0.9349 | [0.8886 ; 0.9812] |

Recall is labelled lessons the product kept something for; precision is kept items that
sit on a labelled lesson. Both pooled within a run, then banded across runs at two
sample standard deviations, the same arithmetic as the routing baseline. The recall
band's upper edge sits above 1.0, which is what an empirical band does near a ceiling
rather than a real possibility.

By the kind of lesson, summed over the three runs:

| label kind | found / labels | |
|---|---:|---|
| correction | 45/45 | a rule the developer stated |
| procedure | 15/15 | a completed task worth repeating |
| error-fix | 12/15 | a lesson from an error that got fixed |

And four numbers that did not move across the three runs:

| | |
|---|---|
| distractor capture | 0 of the 77 kept items had a one-system fact as its central claim (the corpus plants 39 such facts) |
| empty returns | 0/23 sessions that had a lesson to find got nothing proposed |
| the lesson-free session | 0 items kept, every run |
| the sieve | dropped nothing, any run; the score floor never bound |

Cost: $3.18 metered for grading and calibration, plus $3.04 estimated for the 72 harvest
calls, which are not metered because the product path reads plain text and asking the CLI
for JSON would price a call the product does not make.

Duration, only as far as the results support it: the harvest calls sum to 963 seconds over
the three runs (307 / 315 / 341), and runs 2 and 3 took 14 minutes 26 seconds end to end
including their grading, from the timestamps the two result files carry. Run 1 also carried
the grader check and the shuffled-label control and the data holds no start timestamp to
bound it, so no figure for the whole invocation is quoted here. Grading dominates: the
runner batches per session, so a run's grading outlasts its harvest.

## Reading a number from here

- **This is a ceiling, not an estimate.** The corpus is deliberately legible, and
  measurably so: the slice that reaches the model is a median of 824 characters against
  the product's 40,000-character cap, 21 of 24 sessions are under 1,200 characters in
  total, the median session has 3 user turns, and in 23 of 24 the rule is stated outright
  in the user's own words. In production the slice fills, and the lesson sits somewhere
  inside hundreds of turns. Treat 0.96 as the ceiling of production recall, not a
  prediction of it.
- **The band is ±0.08.** An adjustment whose effect is smaller than that cannot be
  distinguished from noise by this package, at this size, at three runs.
- **Precision here can only be higher than in production.** The runner injects an empty
  list of existing skills. In production that list goes into the prompt as "do not
  propose anything these already cover", and the harvest has something to be suppressed
  by. There is no such pressure here, and the sieve's duplicate rule - which drops an item
  whose slug already exists - is therefore never exercised by this package at all.
- **Precision is also a lower bound, for the opposite reason.** Of 77 kept items, five sat
  on no label: three are one lesson the model split across two skills, and the other two an
  independent review read and judged to be real, reusable lessons the corpus simply had not
  labelled. A harvest that finds a 26th lesson is scored as noise for finding it.
- **The grader is not independent of the labels.** Its rubric, the reference sentences and
  the ten hand-labelled pairs it is checked against all come from the same hand. Its
  agreement is 10/10 on each of three repeats and its shuffled-label rate is 0/27, so the
  direction is right; it is not an outside opinion. An independent review wrote five
  harder near-miss pairs against the same rubric and the grader answered all fifteen
  trials correctly, which narrows the objection without removing it.
- **Do not read a candidate queue's kind distribution against these rows.** Of 77 kept
  items 68 came back as `correction`, including every procedure label - which is the
  prompt being obeyed, since its first kind is an explicit teaching the user gave and
  nearly every lesson here is stated as one. Whether the kinds discriminate when a lesson
  is *not* stated is unmeasured.
- **The corpus nests two attributes it should have crossed.** All five error-fix labels
  are also the implicit ones, so the `error-fix 12/15` row and an equivalent
  `implicit 15/18` row report the same two labels, and which attribute the misses belong
  to cannot be read off this corpus. A harder tier that crosses them is the next
  measurement.

## The second tier: the same question at production's density

The baseline above is a ceiling, and the paragraph under it says why. `evals/hasat/` now carries
a second corpus that removes the three reasons it was one, and reports apart from the first:

    npx vite-node evals/hasat/run.ts -- --tier 2 --runs 3

Twenty-three sessions where the slice fills to 82% of its cap instead of 2%, the developer takes
26 turns instead of 3, the turn carrying the lesson is 1% of what they typed instead of 70%,
three to five existing skills are injected instead of none - and in nine of the twenty-two
labelled lessons nobody ever states the rule at all. It is measured the same way, with its own
hand-labelled grader pairs, because agreement on pairs about voiced rules says nothing about a
grader reading an item against a sentence that appears nowhere in the session.

Measured 2026-09-26, harvest model `claude-sonnet-5`, grader `haiku`, three runs:

| | run 1 | run 2 | run 3 | mean | 2 sd band |
|---|---:|---:|---:|---:|---:|
| recall | 0.7368 | 0.7368 | 0.7778 | 0.7505 | [0.7032 ; 0.7978] |
| precision | 0.2593 | 0.3684 | 0.3333 | 0.3203 | [0.2089 ; 0.4318] |

**A rule the developer states still comes back every time: 18 of 18, at this density.** Twelve
flat prohibitions and six "from here on"s, found in every run. That extends the first tier's
57-of-57 rather than replacing it.

**All of the drop is in the lessons that were not stated as rules** - 12 of the 26 unstated
label-runs and 2 of the 12 implicit ones - and it is systematic rather than noisy: thirteen of the
nineteen labels came back in all three runs, one in two, one in one, and **four in none at all**.
Three of those four are the same case: the developer quietly fixing the same thing twice without
ever saying the rule.

**Nothing was competing for the slot.** In six of the twelve runs of those four sessions the
harvest kept fewer than the three items it was allowed, and in two it returned nothing at all; the
sieve's over-cap rule never fired in any run of any session. So the model had room to propose the
quiet correction and did not - which points at what it treats as a correction, not at the quota.

**Read the precision band as a property of the corpus, not of the product.** A dense session
contains more lessons than a corpus can label: of 134 kept items, 42 sat on a planted label and
92 did not, and all 92 were read one by one. Six are a planted lesson split or re-framed; **none
is an invented claim and none is a bare fact about one system** (the distractor question agrees:
0 of 54, with its positive control at 4/4). The other 86 are real lessons the corpus simply had
not labelled.

**What they are says something about the corpus.** Eighty-four of those 86 items are seven
lessons - the filler's own chores, generalised - wearing 72 different names across the three runs.
That number is a property of this corpus and of how it was run, not a measurement of production:
twenty-three sessions share the same chores, every session runs against a fresh home, and the
existing-skill list is empty, so nothing could have suppressed a re-proposal and nothing about the
sieve's slug comparison was exercised. Whether duplicates of one lesson accumulate in a real queue
is **unmeasured**, and on the machine that produced this package they have not: its 86 real
candidates are 86 distinct topics, with no two names sharing a three-word prefix.

The suppression that WAS measured points the other way: where an existing skill already covered the
session's lesson, the model proposed nothing for it in any run, 0 of 9.
