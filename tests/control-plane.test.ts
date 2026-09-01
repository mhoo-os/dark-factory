import { describe, expect, it } from "vitest";
import { admitLinear, AdmissionError } from "../src/admission";
import { verifyHmac } from "../src/crypto";

const env = { LINEAR_PROJECT_ID: "project", LINEAR_PROJECT_SLUG: "", ALLOWED_REPOSITORY_PREFIX: "mhoo-os/", FACTORY_ENABLED: "true", FACTORY_AUTONOMY: "1", AUTO_MERGE: "false" } as const;

describe("control-plane admission", () => {
  it("accepts only an explicitly labelled issue in the configured project", async () => {
    const job = await admitLinear(JSON.stringify({ data: {
      id: "issue", identifier: "MHO-199", title: "Dispatch contract", description: "Repository target: `mhoo-os/dark-factory`", url: "https://linear.app/mhoo/issue/MHO-199", priority: 2,
      project: { id: "project" }, labels: [{ name: "factory:accepted" }], state: { type: "unstarted" }
    }}), env);
    expect(job.executionId).toBe("linear-issue");
    expect(job.repository).toBe("mhoo-os/dark-factory");
  });

  it("rejects unlabelled work", async () => {
    await expect(admitLinear(JSON.stringify({ data: { id: "issue", identifier: "MHO-1", title: "x", url: "u", project: { id: "project" }, labels: [] } }), env)).rejects.toBeInstanceOf(AdmissionError);
  });
});

describe("webhook signatures", () => {
  it("verifies GitHub-style sha256 signatures", async () => {
    const body = "{}";
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
    const signature = `sha256=${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    expect(await verifyHmac("secret", body, signature)).toBe(true);
    expect(await verifyHmac("wrong", body, signature)).toBe(false);
  });
});
