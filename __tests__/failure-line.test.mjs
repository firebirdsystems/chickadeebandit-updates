import { describe, it, expect } from "vitest";
import { failureLine, uploadFailureLine, shareFailureLine } from "../src/logic.js";

const err = (status, code, message = "hub text") => Object.assign(new Error(message), { status, code });
const words = { action: "change the photo", thing: "photo" };

describe("failureLine", () => {
  it("says what a refusal was, never the hub's text", () => {
    expect(failureLine(err(403), words)).toBe("You don’t have permission to change the photo.");
    expect(failureLine(err(507), words)).toBe("The household’s storage is full — free up space first.");
    expect(failureLine(err(429), words)).toBe("Too many tries — wait a minute and try again.");
    for (const e of [new TypeError("Failed to fetch"), err(400), err(500)]) {
      expect(failureLine(e, words)).toBe("Couldn’t change the photo — try again.");
    }
  });
  it("shows a message the app worded itself", () => {
    expect(failureLine(Object.assign(new Error("This page could not be changed."), { forUser: true }), words))
      .toBe("This page could not be changed.");
  });
});

describe("uploadFailureLine", () => {
  it("names the upload's own refusals, then falls back to the write lines", () => {
    expect(uploadFailureLine(err(413))).toBe("That photo is too large.");
    expect(uploadFailureLine(err(415))).toBe("That kind of file can’t be uploaded.");
    expect(uploadFailureLine(err(507))).toBe("The household’s storage is full — free up space first.");
    expect(uploadFailureLine(err(0))).toBe("Couldn’t add that photo — try again.");
  });
});

describe("shareFailureLine", () => {
  const share = { action: "create the share link", thing: "page" };
  it("names the link cap and a short password by code", () => {
    expect(shareFailureLine(err(409, "share_link_limit"), share)).toBe("Too many share links are active — revoke one first.");
    expect(shareFailureLine(err(400, "password_too_short"), share)).toBe("The password needs at least 6 characters.");
    expect(shareFailureLine(err(409), share)).toBe("Couldn’t create the share link — try again.");
  });
});
