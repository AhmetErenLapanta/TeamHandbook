# Does the harvest find the lessons a session contains?

The first sentence of this repository's README promises that TeamHandbook harvests durable
lessons out of real sessions - the corrections you gave, the procedures you completed, the
traps you hit. The routing suite next door measures whether a plain sentence reaches the
right command. Nothing measured the sentence above.

This package does. It is a golden corpus of synthetic sessions with the lessons they
contain written down separately, a runner that puts each one through the real harvest, and
a grader that decides whether what came out is the lesson that went in. It changes no
product code: it is an instrument, and an instrument that adjusts the thing it measures has
measured nothing.

## What it measures

Per label kind, and over the whole corpus:

- **recall** - of the lessons planted, how many came back as something the product kept.
  Reported twice: over kept items, and over everything the model proposed before the sieve
  ran. The gap between those two is the sieve's contribution, and it is the number an
  adjustment to the sieve would move.
- **precision** - of the items the product kept, how many sit on a planted lesson. Counted
  by the kind the model EMITTED, not the kind the lesson was, so a correction proposed as a
  discovery is visible rather than averaged away.
- **distractor capture** - how often a kept item's central claim is a true fact about one
  system rather than a rule. Every session carries one to three of those, and the prompt
  already tells the model to leave them out.
- **discovery share** - discovery is the one kind with no anchor the parser can check, and
  the kind a session's real lesson is most easily filed under.
- **where the losses happen** - four tiers, because an empty queue has four different
  causes and they need different fixes: the model returned nothing, the parser refused what
  it returned, the sieve dropped what the parser kept, or the lesson never reached the model
  at all.
- **a label-kind against emitted-kind table** - which is where a correction that came back
  as a discovery, and was then cut by the one-discovery-per-session quota, becomes visible.

## The corpus

`corpus.ts`. Twenty-four synthetic sessions. Everything in them is invented: no real path,
account name, company, product or repository, and nothing copied out of a real session or a
real queue.

Each session carries one to three **labels** - a lesson with its kind, its canonical
sentence, and three to five concepts any faithful statement of it has to carry - and one to
three **distractors**, true facts about one system that a good harvest must not propose as
the lesson. One session carries no label at all: everything produced there is noise by
construction, which is the only way the precision number has a floor under it.

The spread is deliberate, and `corpus.test.ts` asserts it: lessons stated at the opening, in
the middle, in the closing turn and twice over; stated as a flat prohibition, as a soft
"from here on", and not stated at all but pushed for across a correction dialogue; sessions
of a few hundred characters and sessions whose prompt runs past thirty thousand; most in
English, three carrying the developer's own language, because the correction detectors carry
other languages as data and the harvest prompt has to as well.

Two sessions exist only to separate two failure modes that otherwise look identical:

- one loses its lesson to the **slice budget** - the newer turns exhaust the user's share of
  the transcript slice - while the recorded prompts still carry it;
- one loses its lesson to the **forty-prompt ceiling** on the recorded prompts while the
  slice still carries it.

Both directions are asserted by name. Everywhere else, both evidence paths carry the lesson,
so a recall miss there is the model's or the sieve's and not the plumbing's.

### Why the labels are not in the transcript

A label's canonical sentence is the grader's reference and appears nowhere in the session.
The developer states the rule in their own words, as a person would; the assistant never
closes with a summary that restates it. `corpus.test.ts` enforces this asymmetrically - no
five-word run of a label may appear in an assistant turn, no eight-word run in a user turn -
because a session where the assistant has already written the answer measures copying, and
would score well while the product got worse.

Each label also carries an **anchor**: a verbatim fragment of the developer's own turn. It
is never used for grading. Its only job is deterministic attribution - did this lesson reach
the slice, did it reach the recorded prompts - which is what turns a recall miss into a
diagnosis.

## The job is built the way production builds it

`session.ts`. `harvestSession` accepts a bare transcript path, and a runner that handed it
only that would be measuring a different product: in production the job carries
transcript-independent evidence, and the harvest prompt leans on it heavily.

So nothing is assembled by hand. Each session is replayed through the same capture functions
the hooks call, in the order they call them, and the job is then assembled exactly as
`src/hooks/session-end.ts` assembles it. A pair fingerprint therefore comes out of the
product's own hashing rather than a literal - which matters, because the parser verifies
that id and refuses an error-fix that names one it was not given. The forty-prompt ceiling,
the four-hundred-character truncation, the six-hundred-character shape filter and the
verbatim-repeat drop all apply exactly as they do on a real machine.

Each session gets a **fresh handbook home**. A shared one would make the first session's
teachings the second's echoes and its candidate the next one's "recent review decision", so
the fixtures would be measuring each other.

## Running it

    npx vite-node evals/hasat/run.ts -- --tier 1 --dry-run            # preflight and cost projection only
    npx vite-node evals/hasat/run.ts -- --tier 1 --grader-check-only  # measure the grader, spend nothing else
    npx vite-node evals/hasat/run.ts -- --tier 1 --runs 3             # the measurement

`--tier` is required and has no default: a second corpus lives beside this one (below), the two
are never pooled, and they cost differently.

Flags: `--tier 1|2|1,2`, `--runs N`, `--budget N`, `--model <name>` (written into the temporary home's config, which is the
product's own override path), `--sessions a,b,c`, `--no-grade`, `--no-grader-check`,
`--out <dir>`.

Each run writes, under `--out`: `run-N.json` (every session's row), `decisions-N.jsonl`
(every grader question and its answer), `material-N/<session>.json` (the redacted reply, the
elements the parser refused, and every item with its sieve verdict) and `summary.json`. None
of it is committed, and `material-N` is where the hand-labelled grader cases came from.

This package does **not** run under `claude plugin eval`. It calls `harvestSession` through
the real `runClaudeCli` directly, because what is being measured is the harvest and not a
routing decision. It is not wired into anything automatic: it spends money, and like the
rest of `evals/` it is run by hand.

`corpus.test.ts` is the opposite: deterministic, free, in the default suite, and it is what
keeps the corpus honest between measured runs.

### Two things it refuses to do

**Run against an unisolated child.** If the installed CLI does not support the flags that
give the child no tools, no MCP servers and none of this machine's settings, the run exits
before spending anything. Without them the child loads this repository and fires this
plugin's own SessionStart hook inside the very session being measured - which was observed
to suppress the harvest outright. A number taken that way describes the notice, not the
product.

**Overspend.** The projection comes from two metered calibration calls of the shape this
package actually sends, at both ends of the corpus, because the longest session's prompt is
six times the shortest's and one calibration would price a call nobody makes for half the
corpus. If the projection exceeds the ceiling the run refuses rather than starting.

### Three runs, and a band

A single run of anything that calls a model is not a headline. The band is the mean of three
runs plus and minus two sample standard deviations, with n-1 in the denominator - the same
method the routing baseline in this repository uses. Two runs of the sibling injection
package over one corpus disagreed on more than half of its cases; that is the size of the
noise a single number hides.

A call that never reached the model is not a zero. It leaves every denominator and is
reported as its own rate, the same rule `evals/run-suite.sh` applies for the same reason. An
**unparseable** reply is not that: the model answered, the answer was unusable, and that is a
product outcome that stays in the number.

## The grader, and its limits

`grader.ts`. One question per (item, label) pair - "is this the same lesson?" - answered YES
or NO by a cheap model. Pairwise rather than one question over a list of labels: a list
invites the model to pick the closest option, and most pairs are genuinely unrelated, so
"none of these" has to be as easy an answer as any other.

It is shown the item's name, description, body and expect. It is **not** shown the quote
field, which holds the developer's own sentence - grading against that would ask whether the
model can copy.

The rubric requires two things at once: the item has to tell a reader to do the same thing
the reference lesson tells them, as a rule they could follow on a different codebase, and it
has to carry every listed concept in some wording. Same topic is not enough; a different rule
about the same subject is a NO.

Two checks stand between the grader and its own numbers, and both are in the report:

1. **Agreement.** `grader-cases.ts` holds hand-labelled pairs, every item a verbatim output
   of a pilot run rather than an invented one, about half of them NO and the NO half
   deliberately hard. They go through the exact production call, three times each.
2. **Shuffled labels.** Every item from the first run is graded a second time against
   another session's labels, chosen so the two are never about the same subject. The answer
   has to be no. A grader that leans towards yes shows up here as a rate that is not zero,
   and every precision number above would be inflated by roughly that much.
3. **A positive control for the distractor question.** A distractor-capture rate of zero is
   indistinguishable from a question that never answers yes, so the same question is put to
   synthetic items whose whole content is one system-specific fact. Every one has to come back
   YES. These are the only invented items in the package, and the reason is the measurement
   itself: a real harvest never produced such an item, so the control had to be built by hand.
   They enter no recall or precision number.

What the grader cannot do: it reads one item against one sentence. It cannot tell whether a
skill is well written, whether its body is correct, or whether anyone would want it. It
answers one question, and the numbers here mean exactly that question and nothing wider.

**And it is not independent of what it grades.** The rubric, the reference sentences and the
ten hand-labelled pairs the grader is checked against all come from the same hand, so 10/10 is
agreement with its own test set: the direction is right, the opinion is not an outside one. An
independent review wrote five harder near-miss pairs against this rubric without seeing the
existing cases, and the grader answered all fifteen trials correctly - which narrows the
objection rather than removing it.

Every verdict is written to `decisions-<run>.jsonl` beside the results, so a rate in the
report can be argued with rather than only read.

## Keeping the fixtures from steering anything

The corpus is read by the model under measurement and by whoever is reading the results:

- no real path, account name, company, product or repository appears anywhere in it, and
  `corpus.test.ts` asserts the shapes that have leaked into this repository before;
- the real queue on this machine was read to learn what a distracting one-system fact looks
  like, and not one line of it was copied;
- raw model replies and grader decisions land under `evals/results/`, which is not
  committed.

## Baseline

Measured 2026-09-26 at `014f984` (the evals commit) against product `eb589b0` (v0.13.3),
harvest model `claude-sonnet-5`, grader `haiku`, 24 sessions and 25 labels, three runs.

```
recall     0.9200 / 0.9600 / 1.0000   mean 0.9600  sd 0.0400  band [0.8800 ; 1.0400]
precision  0.9200 / 0.9231 / 0.9615   mean 0.9349  sd 0.0231  band [0.8886 ; 0.9812]
```

Read the band, not a run inside it. The recall band's upper edge sits above 1.0, which is an
artefact of an empirical two-sigma band measured near a ceiling rather than a real
possibility.

**This number is taken at the density ceiling.** The corpus is legible by construction, and
measurably so: the slice that reaches the model is a median of 824 characters against the
product's 40,000-character cap (2.1% of it), 21 of 24 sessions are under 1,200 characters in
total, the median session has three user turns, and in 23 of the 24 the rule is stated outright
in the developer's own words. In production the slice fills and the lesson sits somewhere inside
hundreds of turns. Treat this as the ceiling of production recall, not an estimate of it. A
harder tier - longer sessions, lessons that are never stated - is the next measurement.

Beside those two, over the same three runs:

```
recall by label kind      correction 45/45   procedure 15/15   error-fix 12/15
recall by lesson FORM     hard-never 27/27   soft-henceforth 30/30   implicit 15/18
distractor capture        0 of 77 kept items (39 such facts planted), positive control 4/4
discovery share of kept   8.0% / 11.5% / 3.8%
model returned nothing    0/23 sessions that had a lesson to find, in every run
lesson-free session       0 items kept, in every run
sieve                     dropped nothing in any run; the score floor never bound
parser refusals           1 of 78 elements, for a quote stitched from two separate user turns
grader agreement          10/10 on each of three repeats over the ten hand-labelled pairs
shuffled-label YES rate   0/27
cost                      $3.18 metered plus $3.04 estimated for the 72 harvest calls
duration                  harvest calls sum to 963s; runs 2 and 3 took 14m26s end to end
```

Precision is a **lower bound** as well as a ceiling-side figure: of the five kept items that
sat on no label, three are one lesson the model split across two skills and two were judged by
an independent review to be real lessons the corpus had not labelled. And because the runner
injects an empty existing-skill list, the sieve's duplicate rule is never exercised here.

**A rule the developer actually states comes back every time**, 57 out of 57, wherever in the
session it sits and whichever language it is in. All three misses across all three runs belong
to two labels, and each of those two is *both* an `error-fix` and an `implicit` lesson.

**This corpus cannot tell you which of those two attributes matters**, because it nests them:
all five error-fix labels are implicit, and all five procedure labels are soft-voiced. The
`error-fix 12/15` row and the `implicit 15/18` row are reporting the same two labels. That is a
flaw in the corpus, not a finding about the product, and the next version of it has to cross the
two - a voiced error-fix, an implicit procedure - before any tuning aims at either.

What the two losses do show is a mechanism, and neither is a failure to *find* the lesson. One
session's job carried a resolved error-fix pair; the model filed the lesson as a correction
instead of pointing at that pair, which obliged it to ground a quote, and an implicit dialogue
has no single quotable sentence - so it stitched two user turns together and the whole item was
refused. The other split one lesson across two skills, and the label asks for it whole.

A related thing the corpus deliberately cannot tell you: of 77 kept items, 68 came back as
`correction`, including every procedure label. That is the prompt being obeyed rather than a
defect - its first kind is "an explicit teaching the user gave", and nearly every lesson here is
stated as a rule. Whether the kinds discriminate when a lesson is *not* stated is unmeasured, so
no distribution of kinds in a real queue can be read against these numbers.

---

# Tier 2: the same question at production's density

The number above is a ceiling and the paragraph under it says why: the rule is stated outright
in 23 of 24 sessions, the slice that reaches the model fills 2% of its cap, and the
existing-skill list is injected empty. Two of the conclusions were also unreadable by
construction - `error-fix` and `implicit` named the same five labels, so no adjustment could
tell which attribute it moved, and the sieve's duplicate branch never fired because there was
no existing skill to collide with.

Tier 2 is the same instrument with three things changed and nothing else. `corpus-tier2.ts`,
selected with `--tier 2`, reported apart from tier 1 and never pooled with it.

## What is different

**The session is dense.** Measured through the product's own slicer and recorder rather than
estimated, and asserted by `corpus.test.ts`:

| | tier 1 | tier 2 |
|---|---:|---:|
| slice that reaches the model, median | 824 chars (2.1% of the cap) | 32,703 chars (82% of the cap) |
| developer turns, median | 3 | 26 |
| of those, short enough to be recorded as prompts | 3 | 15 |
| the turn carrying the lesson, as a share of everything typed | 70% | 1.1% |
| existing skills injected | 0 | 4 |

The bulk comes from `noise.ts`: chores, pasted data and inventories of what changed, over
twenty-four invented service areas. It is generated rather than written by hand, which is a
real limit on this tier and the reason tier 3 exists - a model may well find templated filler
easier to ignore than the real thing.

**The lesson is often not stated at all.** Nine of the twenty-two labels are a new form,
`unstated`: the same mistake is corrected twice on its own terms, or the developer quietly
reverts the same thing twice, or a procedure is carried out step by step because each step was
asked for, and no turn generalises any of it. There is no sentence to quote. Four more are
`implicit` - pushback on the general case without a rule sentence - and the rest are stated,
filling the cells tier 1 left empty: a voiced error-fix, a procedure stated as a hard rule.

| kind \ form | hard-never | soft-henceforth | implicit | unstated |
|---|---:|---:|---:|---:|
| correction | 1 | 0 | 2 | 4 |
| procedure | 2 | 1 | 2 | 3 |
| error-fix | 3 | 2 | 0 | 2 |

**The model is told what already exists.** Every session injects three to five existing skills
with real descriptions, and in three of them one of those skills already covers the session's
own lesson. The right outcome there is silence: the prompt says to propose nothing that
overlaps an existing skill, and the sieve drops an item whose slug already exists. Those three
labels are out of every recall denominator and reported as suppression instead - whether
anything came back for them, and which of the two mechanisms stopped it.

Measured: the model stopped all nine of them (three labels, three runs), so **the sieve's
duplicate branch is still not exercised by this package** - the first mechanism never handed it
anything. The gap the first tier's note above describes is narrower now and it is not closed.

## What holds the tier up

- **The canonical sentence is nowhere in the session.** Tier 1 bans a five-word run of it from
  an assistant turn and an eight-word run from a developer turn. For an `unstated` or
  `implicit` label the bound here is four words in EITHER role, because a lesson nobody stated
  has no reason to share a phrase with anything.
- **And it is barely there as vocabulary.** Content-word overlap between a label's sentence
  and the best single developer turn: 0.15 on average across the unstated arm and 0.12 across the
  implicit one, against a floor of 0.11 for the same measure taken against a DIFFERENT session.
  There is nothing to rephrase. The stated arm sits at 0.47, which is roughly what tier 1
  measured (0.46 on its own hard-never arm), and that is the point of keeping the arms apart.
- **The filler states no rule - and that is weaker than "teaches nothing", which is the honest
  version.** The first draft of it filled the sessions with substantial engineering exchanges - a
  duplicate-delivery bug traced through log timestamps, a flaky test traced to a module-scope
  counter in a shared fixture - and a pilot run over nine sessions showed the harvest proposing
  exactly those: of the seven sessions that returned anything, all seven proposed filler-derived
  lessons, and in two the planted lesson did not come back at all. (Whether the filler displaced
  it cannot be read off that run: nothing was dropped by the sieve, so the model simply never
  emitted it.) The filler was rewritten as bulk without a mechanism, which cut its own yield to
  one or two items a session and did not remove it: the measured runs kept 86 filler-derived
  items. `corpus.test.ts` asserts that no filler turn states a rule in the developer's voice,
  which is what would make it indistinguishable from a planted label; it cannot assert that a
  dense session contains nothing else worth keeping, because it does.
- **Each label declares which evidence path carries it**, and the test asserts the declaration
  against what the product's own recorder and slicer do. One label is stated inside a turn
  longer than 600 characters, so it reaches the model through the slice alone - which is the
  production mix rather than a defect, and it is declared rather than discovered afterwards.

## Running it

    npx vite-node evals/hasat/run.ts -- --tier 2 --dry-run
    npx vite-node evals/hasat/run.ts -- --tier 2 --runs 3

`--tier` has no default: the two tiers are never pooled and they cost differently, so an
invocation that ran both by accident would spend twice what its command line says. The grader
is checked against its own tier's hand-labelled pairs - agreement on ten pairs about voiced
rules says nothing about a grader reading an item against a sentence nobody in the session ever
said.
