<!-- Conventional Commit title, e.g. fix: drop candidates whose fix was reverted -->

**What & why**
What this changes and the reason. For capture/gate/secret changes, name the
failure case it prevents.

**Checklist**
- [ ] `npm run build` (bundles committed if hooks/CLIs changed)
- [ ] `npm test` passes
- [ ] `npm run typecheck` clean
- [ ] Trust invariants intact: nothing delivered without `/handbook:review`
      approval; secrets can't reach disk; untrusted text stays fenced in prompts
- [ ] Tests added/updated for `src/lib/` changes
