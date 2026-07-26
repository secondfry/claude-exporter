# Claude Exporter

A browser extension that pulls a user's conversations off claude.ai and writes them to local files. This context covers the vocabulary of exporting and of the local caching that makes bulk exports cheap.

## Language

**Conversation**:
A single claude.ai chat thread, identified by its UUID.
_Avoid_: chat, thread

**Artifact**:
A file-like document produced inside a Conversation, extractable as its own file.

**Export**:
The act of writing one or more Conversations to disk as files.
_Avoid_: download, backup, save

**Export Record**:
The note that a Conversation was Exported, and when.
_Avoid_: export status, export flag

**Stale**:
The state of a Conversation whose content has changed since its Export Record was written.
_Avoid_: dirty, outdated, needs-update

**Chat Cache**:
The extension's local store of previously fetched Conversation content, held so an Export need not refetch.
_Avoid_: chat store, local copy, offline archive

**Cache Hit**:
An Export satisfied from the Chat Cache without contacting claude.ai.

**Orphan**:
A **Chat Cache** entry whose Conversation no longer exists on claude.ai.
_Avoid_: stale entry, dead cache entry, garbage

**Backup**:
A user-initiated snapshot of the extension's own settings and Export Records, for moving between machines.
_Avoid_: export (see Flagged ambiguities)

## Relationships

- A **Conversation** has at most one **Export Record** and at most one **Chat Cache** entry
- A **Conversation** is **Stale** when its server-side modification time is newer than its **Export Record**
- A **Chat Cache** entry is valid only while the **Conversation** is unchanged since the entry was stored
- An **Export** writes an **Export Record** for every **Conversation** it succeeds on
- A **Backup** carries **Export Records** but never the **Chat Cache**
- An **Orphan** can never become **Stale**, since nothing upstream can change it

## Example dialogue

> **Dev:** "If a **Conversation** has a **Chat Cache** entry, is it Exported?"
> **Domain expert:** "No — those are unrelated. The **Chat Cache** says we hold the bytes. The **Export Record** says the user got a file. You can have cached bytes for a Conversation the user has never Exported, and an **Export Record** for one whose cache entry we've lost."
> **Dev:** "And if the Conversation is **Stale**?"
> **Domain expert:** "Then both are out of date, but only the cache invalidity blocks us — we refetch, Export, and write a fresh **Export Record**."

## Flagged ambiguities

- "exported" was used to mean both *the user has a file for this* and *we hold its content locally* — resolved: those are the **Export Record** and the **Chat Cache**, and they are independent.
- "orphan" carries a connotation of garbage, but an **Orphan** is the only surviving copy of its Conversation — resolved: Orphans are exportable, not merely deletable. The **Chat Cache** still is not the archive; the exported file is.
- "backup" was used for both the settings snapshot and the idea of a durable local copy of all Conversations — resolved: **Backup** means settings and **Export Records** only. A durable local copy of Conversations is not a thing this project offers; the **Chat Cache** is disposable and explicitly not a Backup.
