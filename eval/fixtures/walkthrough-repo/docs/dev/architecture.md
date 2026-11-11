# Architecture

Back to the [developer docs](README.md).

relaybox polls each forge's review API, turns comments into one internal
shape, and posts them to the other forge.

## Data

relaybox stores nothing on disk. It sends comment bodies and author names to
the other forge, and nothing anywhere else.

## Trust boundaries

Both forge APIs are untrusted input: comment bodies are escaped before they
are posted. The machine running relaybox is trusted.
