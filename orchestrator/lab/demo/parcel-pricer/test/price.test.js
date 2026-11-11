import { strict as assert } from "node:assert";
import { test } from "node:test";
import { priceFor } from "../src/price.js";

test("prices a light parcel at the first tier", () => {
  assert.equal(priceFor(1), 4.5);
});

test("prices a parcel exactly at a weight limit at that tier", () => {
  assert.equal(priceFor(5), 7);
});

test("prices nothing over the heaviest tier", () => {
  assert.equal(priceFor(25), null);
});
