// A pipeline: one producer, one consumer, joined.
//
// The channel is closed by its producer. A channel nobody closes is a
// deadlock, and a deadlock FAILS the run rather than hanging it.

interface Item {
  /** What this item is. */
  name: string;
  /** Its weight. */
  weight: number;
}

const items = channel<Item>("items");

const producer = future(async () => {
  const found = await agent("scanner", { system: "You find things." })
    .ask<Item[]>("List the things in this repository, with a weight for each.");
  for (const item of found) items.send(item);
  items.close();
});

const consumer = future(async () => {
  const seen: string[] = [];
  for await (const item of items) {
    seen.push(item.name);
    log("saw " + item.name + " (" + item.weight + ")");
  }
  return seen;
});

const [found, seen] = await Promise.all([producer, consumer]);

report({ count: seen.length, names: seen });

return { found, seen };
