# Run nightly imports with ferry

This guide shows operators how to schedule the nightly CSV import into the
reporting database, check that it finished, and recover from a failed batch.

## Before you start

- `ferry` 2.0 or later on the import host (`ferry --version`).
- Write access to the `reporting` schema.
- The CSV drop directory mounted at `/srv/drop`.

## Schedule the import

1. Create the schedule:

   ```bash
   ferry schedule add nightly --at 02:00 --source /srv/drop/orders.csv --target reporting.orders
   ```

2. Confirm it is listed:

   ```bash
   ferry schedule list
   ```

We recommend running the import outside business hours, when the database
has spare capacity.

In the last measured run the system took 20 seconds to do the import.

Under the hood, the import planner builds a dependency graph of table tasks
and sorts it topologically before it hands batches to a worker pool sized
to the number of CPU cores.

## Check that an import finished

Run a dry run first when you change the source file:

```console
$ ferry import --dry-run /srv/drop/orders.csv
[2026-03-01 02:00:04] planned 12 batches
[2026-03-01 02:00:24] dry run finished in 20.1s
```

Then check the last scheduled run:

```bash
ferry status nightly
```

`ferry status` prints `ok` when every batch committed.

On a 4-core runner with an SSD, a 1 GB CSV imports in about 3 minutes.
During our benchmark on 2026-03-01, indexing the imported rows took 4
minutes.

## Recover from a failed batch

By default `ferry` retries a failed batch 3 times, 30 seconds apart. If a
batch still fails, rerun only the failed batches:

```bash
ferry import --resume nightly
```

Failed batches wait in the retry queue. The retry queue is a Redis sorted
set; we moved off RabbitMQ in 2023 because its delayed-message plugin
dropped messages on restart.

To re-import everything, run:

```bash
ferry import --full nightly
```

Back when Priya set this up for the billing team, a full re-sync came in at
just under an hour.

## What changed in 2.0

`ferry schedule` replaces the `ferry cron` command from 1.x. See the
[changelog](CHANGELOG.md) for the full list.
