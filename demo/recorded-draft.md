---
name: add-resource-endpoints
description: >-
  Adds a new resource's endpoints to the shop API by creating its routes file and schema, registering it in the app, and documenting it. Use when a ticket asks to "add the X endpoints" for a new resource such as customers, products or invoices. Also when a new resource responds but is missing from the API docs, or its routes exist but are never mounted in the app. Triggers: "add the endpoints", "new resource endpoints".
argument-hint: "[TICKET]"
---
# add-resource-endpoints - add a new resource's endpoints to the shop API

This touches one repository (shop-api) and four files per resource: a routes file, a schema file, the app entry point and the API docs. It is easy to get wrong because every one of the four changed in all 10 past jobs, so skipping any of them leaves the resource half-added.

## 0. Reading the ticket
- Pull out the resource name (for example customer, product, shipment) and the operations requested; past tickets are titled "add the <resource> endpoints" [subject 1].
- Sibling tickets exist for other resources (products, shipments, refunds, warehouses, invoices, orders, suppliers, coupons, payments), each done the same way [subject 2].
- Copy the naming from the existing resource: the singular lowercase name drives the routes file, the schema file and the docs heading.

## 1. Schema layer (shop-api, src/schemas)
1. Create `src/schemas/<resource>Schema.ts` exporting an interface named after the resource, starting with an `id: string` field [hunk 3].
2. Add any further fields the ticket specifies to that interface, keeping the file one-per-resource [map 3].

## 2. Routes layer (shop-api, src/routes)
1. Create `src/routes/<resource>Routes.ts` exporting a `<resource>Routes` constant listing the endpoints, for example `GET /customers` and `POST /customers` [hunk 2].
2. Keep one routes file per resource, named with the `Routes.ts` suffix [map 2].

## 3. App registration (shop-api, src/app.ts)
1. Register the new routes in `src/app.ts`; this file changed in every past job [map 4].

## 4. Documentation (shop-api, docs/api.md)
1. Append a `## <Resources>` heading to `docs/api.md` after the existing sections [hunk 1].
2. Under it, list each endpoint as a bullet such as `- GET /customers` and `- POST /customers`, matching the routes file exactly [hunk 1].

## Not visible in history
- The exact edit made to `src/app.ts` (import style, mount order) is not shown in the evidence; what does the registration look like?
- Do the routes files need handlers or validation beyond the list of endpoint strings, or is the list the whole deliverable?
- Tests were changed in only 4 of 10 jobs; which resources called for a test, and what did it check?
- Is there a build, lint or type-check command for the repository? The history does not record one.

## File map (10 past changes)
| File (pattern) | Touched in | Note |
|---|---|---|
| shop-api:docs/*api.md | 10/10 | API documentation; new section per resource |
| shop-api:routes/*Routes.ts | 10/10 | New routes file per resource |
| shop-api:schemas/*Schema.ts | 10/10 | New schema interface per resource |
| shop-api:src/*app.ts | 10/10 | App entry point where the resource is registered |

## Verification
Run in this order; a green run is a safety net, not proof:
- [ ] `ls src/routes/<resource>Routes.ts src/schemas/<resource>Schema.ts` lists both files without error.
- [ ] `grep -n "<resource>" src/app.ts` prints at least one line showing the resource is registered.
- [ ] `grep -n "## <Resources>" docs/api.md` prints exactly one heading line, followed by the same endpoints as the routes file.
- [ ] `git diff --stat` shows all four files (docs, routes, schema, app) changed.

## Delivery
- Single repo: one change containing all four files; there is no merge ordering to follow.

## Common mistakes (observed)
| Mistake | Evidence | Do instead |
|---|---|---|
| None recorded: no corrections were made inside any past ticket | none in history | Follow the four-file checklist above so none of the 10/10 files is skipped |