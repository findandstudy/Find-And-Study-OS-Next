import assert from "node:assert/strict";
import { test } from "node:test";
import { preventPipelineDialogOutsideDismiss } from "../src/lib/pipelineDialogDismiss";

test("pipeline stage editor ignores outside interactions from portalled selects", () => {
  let prevented = false;

  preventPipelineDialogOutsideDismiss({
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
});
