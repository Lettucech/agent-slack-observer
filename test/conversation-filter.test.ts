import assert from "node:assert/strict";
import test from "node:test";
import { conversationNameMatchesFilter, filterPatterns, parseFilterTerms } from "../src/conversation-filter.js";

test("parses comma-separated filter terms, trimming and deduplicating case variants", () => {
  assert.deepEqual(parseFilterTerms(" on-off-notification , Ops-Noise ,on-off-notification, "), ["on-off-notification", "ops-noise"]);
  assert.deepEqual(parseFilterTerms(""), []);
  assert.deepEqual(parseFilterTerms(null), []);
  assert.deepEqual(parseFilterTerms(undefined), []);
});

test("matches conversation names case-insensitively on any term", () => {
  const terms = parseFilterTerms("on-off-notification, ops-noise");
  assert.equal(conversationNameMatchesFilter("team-on-off-notification", terms), true);
  assert.equal(conversationNameMatchesFilter("OPS-NOISE room", terms), true);
  assert.equal(conversationNameMatchesFilter("general", terms), false);
  assert.equal(conversationNameMatchesFilter(null, terms), false);
  assert.equal(conversationNameMatchesFilter("general", []), false);
});

test("escapes LIKE wildcards in terms before building SQL ILIKE patterns", () => {
  assert.deepEqual(filterPatterns(parseFilterTerms("a_b%c\\d")), ["%a\\_b\\%c\\\\d%"]);
});
