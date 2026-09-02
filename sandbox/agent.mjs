// The image entry point is intentionally fail-closed until the reviewed agent
// implementation is added. A missing implementation must become a held run,
// never an apparent successful execution.
console.error(JSON.stringify({ event: "factory_agent_unavailable", reason: "agent_not_released" }));
process.exitCode = 78;
