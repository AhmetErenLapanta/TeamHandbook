# Held-out half

The headline number comes from here. Nothing in this directory may be read by anyone
writing a command or skill description, which is the whole reason it exists: a
description written against a sentence stops measuring routing and starts measuring
string matching, and that has already happened once, to `team-mcp-settings`.

Product owns these sentences and keeps the source sealed at
`.fabrika/muhur/tutma-cumleleri.md`. Fifteen routing sentences, eight Turkish and seven
English, covering all ten commands; four false-positive probes that must route nowhere.

One sentence was retired rather than scored. `t-setting-up-squad-en` repeated two entries
of `init`'s trigger list clause for clause, so it would have stayed green through a routing
regression, which is the one job the held-out half has. Its directory is still here, tagged
out of every package, because the record of a case that had to go is worth more than a
clean directory listing. That leaves `init` with one sentence instead of two.

## Context

Twelve of the twenty cases carry a `prior.jsonl`, because their sentence leans on
something it does not itself supply. Two kinds, and they are not equally solid:

- **A conversational antecedent.** "Arkadaşlar bir adres attı" needs the address. The
  prior turns are the conversation it refers to, which is what actually happened.
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
  team rule rather than a personal note, which is the framing K-27 will carry. A low
  score before K-27 lands is that card's baseline, not a defect.
- **`t-what-reached-team-tr` and `fp-deploy-status-en` are a deliberate pair.** Both ask
  for status, one about the plugin and one about CI. A description that cannot separate
  them misses both.
- **Case 9 and case 10 are the same request in two languages**, as are several others. A
  large gap between the pair is a language effect and should be reported as one.
