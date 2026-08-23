import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyAltinbasLoginFailure } from "../src/universities/altinbas/altinbasLogin.js";

test("Altınbaş login: current Salesforce invalid-credential copy is classified", () => {
  assert.equal(
    classifyAltinbasLoginFailure({
      bodyText:
        "Sorry, we couldn't find an account associated with that username/password. " +
        "Please make sure you're using the correct login information and try again.",
      passwordVisible: true,
      loginUrlVisible: true,
    }),
    "invalid_credentials",
  );
});

test("Altınbaş login: captcha and rate-limit evidence take priority", () => {
  assert.equal(
    classifyAltinbasLoginFailure({
      bodyText: "Incorrect password. Too many login attempts; try again later.",
      captchaDetected: true,
      passwordVisible: true,
    }),
    "captcha_or_rate_limit",
  );
});

test("Altınbaş login: an unexplained visible login form stays unknown", () => {
  assert.equal(
    classifyAltinbasLoginFailure({
      bodyText: "Agency Login",
      passwordVisible: true,
      loginUrlVisible: true,
    }),
    "unknown",
  );
});

test("Altınbaş login: a password-free non-login page has no failure", () => {
  assert.equal(
    classifyAltinbasLoginFailure({
      bodyText: "My Applications",
      passwordVisible: false,
      loginUrlVisible: false,
    }),
    null,
  );
});

