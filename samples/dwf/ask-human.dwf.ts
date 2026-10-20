// The parts that are dsh's own: asking the human, routing between models,
// and reading the run's telemetry.
//
// The human question PAUSES the run. The question reaches the user, and the
// answer comes back on the same run.

phase("check");

// Is this run allowed to touch the network? The human decides.
const allowed = await askUser(
  "This workflow wants to run a network command. Allow it?",
  { kind: "confirm" },
);

if (!allowed) {
  log("the user declined; stopping before the command");
  return { allowed: false, ran: false };
}

phase("run");

const exit = await world.run("node", ["--version"]);

phase("report");

// The host's own view of the concurrency limiter — a script cannot measure
// this from the outside, because time spent WAITING for a slot is not time
// spent holding one.
const limits = await concurrency.stat();

// The models this run may use.
const available = models.length;

log("exit " + exit.exitCode + ", limit " + limits.limit);

report({ exitCode: exit.exitCode, limit: limits.limit, models: available });

return { allowed, exit, limits, models: available };
