import assert from "node:assert/strict";
import test from "node:test";

import { hasBlockingCiContext } from "../src/automation/github-review-threads.ts";

test("CI rollup blocks review-loop readiness on failing or pending checks", () => {
	assert.equal(hasBlockingCiContext([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }]), true);
	assert.equal(hasBlockingCiContext([{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }]), true);
	assert.equal(hasBlockingCiContext([{ __typename: "StatusContext", state: "FAILURE" }]), true);
});

test("CI rollup allows successful, skipped, neutral, and absent checks", () => {
	assert.equal(hasBlockingCiContext([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" }, { __typename: "CheckRun", status: "COMPLETED", conclusion: "NEUTRAL" }, { __typename: "StatusContext", state: "SUCCESS" }]), false);
	assert.equal(hasBlockingCiContext([]), false);
});
