---
name: change-cache-backend-api
description: >-
  Applies a change to the cache API consistently across every Django cache backend module and the cache docs. Use when a request adds or alters a cache method's behavior, return value, timeout semantics or key handling that all backends must honor. Also when one backend behaves differently from the others after a cache change, or the docs still describe the old behavior. Triggers: "add a cache method", "change cache backend behavior".
argument-hint: "[TICKET]"
---
# change-cache-backend-api - keep every cache backend and the cache docs in step

This touches the single Django repository: the cache backends package (base class plus one module per backend) and the cache topic doc. It is easy to get wrong because each backend implements the contract on its own, so changing the base class or one backend leaves the others silently inconsistent (for example, a method returning None in one backend and True or False in another).

## 0. Reading the ticket
- Pull out the exact contract change: method name, new return value, timeout semantics (including `None` or 0), or key rules. Write the expected result for success and for failure in one sentence each.
- Decide whether the change is observable by users; if so the cache topic doc needs an update (5 of 8 past changes touched it).
- No sibling tickets per product type exist; the same change fans out across backends instead.

## 1. Base class
1. Open the base cache module in the backends package and update the method's docstring to state the contract, for example "Returns True if the value was stored, False otherwise."
2. If the method is new, add it to the base class, raising `NotImplementedError`, so every backend has a defined signature to match.

## 2. Each backend module
1. Update the database backend. Make internal helpers return the outcome (`True` on commit, `False` in the swallowed `DatabaseError` branch) and make sure public methods that should not return a value (like `set`) do not leak the helper's return.
2. Update the dummy backend so it satisfies the contract with a sensible constant (for `add`, `return True`, replacing a bare `pass`).
3. Update the file-based backend and the local-memory backend to return the same values under the same conditions.
4. Update the memcached backend (7 of 8 past changes touched it) by mapping the client library's result onto the contract. Skip only if the client already returns the right thing, and confirm that explicitly.
5. Check every backend for the same early-exit paths (key already exists, expired entry, write failure) so each returns the documented value.

## 3. File map (8 past changes)
| File (pattern) | Touched in | Note |
|---|---|---|
| backends/*base.py | 8/8 | Base class contract and docstrings |
| backends/*db.py | 8/8 | Database backend; helper return values and error branch |
| backends/*dummy.py | 8/8 | No-op backend; must still honor the return contract |
| backends/*filebased.py | 8/8 | File-based backend |
| backends/*locmem.py | 8/8 | Local-memory backend |
| backends/*memcached.py | 7/8 | Memcached backend; map client result to contract |
| topics/*cache.txt | 5/8 | Cache topic documentation |

## 4. Verification
Run in this order; a green run is a safety net, not proof:
- [ ] `grep -n "def <method>" django/core/cache/backends/*.py` lists the method in every backend module with the same signature.
- [ ] `grep -n -A12 "def <method>" django/core/cache/backends/*.py` shows an explicit `return` on every exit path in each backend (no bare `pass` left in the changed method).
- [ ] A scratch script calling the method twice against each configured backend (`locmem://`, `db://<table>`, `file://<dir>`, `dummy://`) prints the documented value for the first call and for the second (for `add`: `True` then `False`; dummy is the documented exception).
- [ ] `python tests/runtests.py cache` (or the repository's equivalent test runner invocation for the cache tests) exits with status 0, and a test for the new behavior exists in the cache tests (88% of past changes added one).
- [ ] `grep -n "<method>" docs/topics/cache.txt` shows the updated description matching the base class docstring.

## 5. Delivery
- Single repository: ship backends, tests and docs in one change so no commit leaves backends disagreeing.

## Common mistakes (observed)
| Mistake | Evidence | Do instead |
|---|---|---|
| Public method returns a helper's value it should not expose (`set` returning the helper result) | #1 | Call the helper without `return` in methods whose contract returns nothing |
| Failure swallowed with `pass`, so callers cannot tell nothing was stored | #1 | Return `False` in the except branch and `True` in the success branch |
| Dummy backend left as a bare `pass` | #1 | Return the constant the contract implies |
| Updating the base docstring but not every backend | #1, #2 | Walk the file map row by row before finishing |
| Docs not updated for a user-visible change | #2 | Edit the cache topic doc in the same change |