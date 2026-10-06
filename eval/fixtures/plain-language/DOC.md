# Ledger service operations guide

This guide covers running the Ledger service in production. Ledger stores
account balances and serves them over an HTTP API. Read it once end to end
before your first on-call shift, then keep it open as a reference.

The service runs on a two-node cluster. Each node holds a full copy of the
data, so either node can answer reads while the other restarts.

## Before you start

You need shell access to both nodes and a token for the release tool. Ask
the platform team for both; requests usually take one working day.

Complete this setup before requesting shared dev/prod applies or enabling
schedules. Then follow the dev and prod walkthroughs.

Check that your workstation has the same client version as the servers.
Mismatched clients can read data but refuse to write it, and the error they
print does not name the version problem.

Keep a terminal open on each node while you work. Most tasks below touch
both nodes in turn, and switching windows is faster than reconnecting.

## Install

Ledger ships as a single binary. Install it the same way on both nodes.

1. Download the release archive from the internal mirror.
2. Unpack it into the installation directory, `/opt/ledger`.
3. Copy the sample settings file next to the binary and edit the paths.
4. Start the service with `ledger serve`.
5. The operator should perform an evaluation of the logs before moving on.

The first start creates the data directory and writes an empty ledger. It
takes a few seconds. If the process exits at once, the settings file is the
usual cause; the log names the line it could not parse.

Repeat the steps on the second node. The nodes find each other through the
peer list in the settings file, so add each node's address to the other's
list before you start the second one.

When both nodes are up, run `ledger status` on either node. It prints both
nodes and the last write each one has seen. The two numbers should match
within a second.

## Configure

All settings live in one file. The service reads it at start and again when
it receives a reload signal, so most changes need no restart.

The deployment configuration sets three things: where data lives, which port
the API listens on, and who may call it. Leave everything else at its
default until you have a reason to change it.

To change how many nodes the platform keeps warm, open the cluster node pool
autoscaler settings page and set the minimum to two. Ledger needs both nodes
running to accept writes.

Access control uses the same groups as the rest of the platform. Add a group
to the access control list to grant read access; add it to the writers list
as well to grant write access. Changes apply on the next reload.

Logging defaults to one line per request. Raise the level only while you
debug, because the verbose level writes request bodies, and those contain
account numbers.

## Day-two operations

Most days need nothing from you. The service rotates its own logs, compacts
its own data files, and reports its health to the platform dashboard.

Restart one node at a time. Wait for `ledger status` to show the restarted
node caught up before you touch the other one. Restarting both together
stops writes until the first node is back.

After a restart, make a determination as to whether the cache is warm
before you send traffic to that node. A cold node answers correctly but
slowly, and slow answers trigger client timeouts.

Users sometimes ask why their password reset fails. The usual cause is the
user account password reset token expiry window, which the identity team
sets to fifteen minutes. Point them to the identity team's guide.

When a client reports stale balances, compare the last write on both nodes.
If they differ by more than a second, the slower node is behind; restart it
and watch it catch up.

## Monitoring

The platform dashboard shows request rate, error rate, and latency for each
node. Learn what normal looks like on a quiet day so that a bad day stands
out. Start with the request rate graph: a sudden drop to zero usually means
clients cannot reach the service, not that the service is down.

Each node answers a load balancer health check on `/healthz`. The check
passes when the node can read its data files and reach its peer. A node that
fails the check stops receiving traffic but keeps running, so you can still
log in and look.

Alerts page the on-call engineer when the error rate stays above one percent
for five minutes, or when a node fails its health check for two minutes.
Each alert links to the matching section of this guide.

Give consideration to the network latency between the nodes when you read
the replication graph. A gap of a few hundred milliseconds is normal across
zones; a gap of several seconds means a node is struggling.

Disk use grows slowly and steadily. The dashboard warns at seventy percent.
Plan to expand the disk at that point; do not wait for the critical alert at
ninety percent.

## Releases

New versions ship every two weeks. Each release note lists the changes and
any settings you must add before you upgrade.

Upgrade one node at a time, the same way you restart one. Run the new
version on the first node for an hour and watch the error rate before you
upgrade the second. If the error rate climbs in the hour after the upgrade,
roll that node back before you touch the other one.

Release artifacts are signed. Review the release pipeline artifact signing
key rotation schedule before each quarter so that you are not surprised by
a new key when a release arrives.

If a release misbehaves, roll back by installing the previous binary and
restarting the node. Releases never change the data format without a major
version bump, so a rollback within a major version is safe.

Keep the last two release archives on each node. Disk space is cheap, and
having the previous binary at hand turns a rollback into a two-minute task.

## Backups

Backups run every night and keep thirty days of history. Each backup is a
full copy of one node's data directory, taken while the node keeps serving.

To restore, stop the node, replace its data directory with the backup, and
start it again. The node catches up on any writes it missed from its peer.

Some teams need longer history for audits. For them, set the database backup
retention policy override flag in the backup tool and choose the number of
days they need.

Once a quarter, conduct a review of the access list for the backup bucket.
Remove people who have left the team or no longer need access.

Run a restore drill at least once a quarter on a spare machine. A backup
you have never restored is a guess, not a backup.

Store the restore steps somewhere you can reach when the service is down.
This guide lives in the same wiki the service hosts, so print the backup
section or keep a copy on your laptop.

## Getting help

The platform team owns the nodes and the network. The Ledger team owns the
service and its data. Open a ticket with the team that owns the part that
broke, and include the output of `ledger status` from both nodes.

For anything urgent outside working hours, page the on-call engineer for
the owning team. Their contact details are on the team pages.

Read the release notes for the version you run before you ask for help.
Many questions about new settings are answered there.
